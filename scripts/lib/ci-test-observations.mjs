import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

const digest = /^[a-f0-9]{64}$/iu;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const observationFileId = ({ project, pool, file }) => JSON.stringify([project, pool, file]);
export const isObservationPath = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  !value.includes("\\") &&
  !value.startsWith("/") &&
  !/^[A-Za-z]:/u.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export function observationFile(value) {
  assert(object(value) && isObservationPath(value.file), "Invalid observation file path");
  assert(
    typeof value.project === "string" && typeof value.pool === "string",
    "Missing project/pool",
  );
  return { file: value.file, project: value.project, pool: value.pool };
}

export function observationContext(context) {
  assert(object(context), "Missing CI context");
  assert(/^[\w.-]+\/[\w.-]+$/u.test(context.repository), "Invalid repository");
  for (const name of ["revision", "tree"]) {
    assert(
      typeof context[name] === "string" && /^[a-f0-9]{40}$/iu.test(context[name]),
      `Invalid ${name}`,
    );
  }
  for (const name of ["configDigest", "lockDigest", "environmentDigest"]) {
    assert(typeof context[name] === "string" && digest.test(context[name]), `Invalid ${name}`);
  }
  return {
    repository: context.repository,
    revision: context.revision,
    tree: context.tree,
    configDigest: context.configDigest,
    lockDigest: context.lockDigest,
    environmentDigest: context.environmentDigest,
  };
}

function dependenciesFor(record, file, root) {
  if (!object(record) || record.version !== 1 || !object(record.projects)) {
    return null;
  }
  if (!Object.hasOwn(record.projects, file.project)) {
    return null;
  }
  const project = record.projects[file.project];
  if (!object(project) || !Array.isArray(project.modules) || !object(project.files)) {
    return null;
  }
  const nativeFile = root
    ? file.file.startsWith(`${root}/`)
      ? file.file.slice(root.length + 1)
      : null
    : file.file;
  if (!nativeFile || !Object.hasOwn(project.files, nativeFile)) {
    return null;
  }
  const fileIndexes = project.files[nativeFile];
  const setupIndexes = project.globalSetup ?? [];
  if (!Array.isArray(fileIndexes) || !Array.isArray(setupIndexes)) {
    return null;
  }
  const indexes = [...fileIndexes, ...setupIndexes];
  const paths = indexes.map((index) =>
    Number.isSafeInteger(index) && index >= 0 ? project.modules[index] : undefined,
  );
  if (!paths.every(isObservationPath)) {
    return null;
  }
  return [
    ...new Set([file.file, ...paths.map((entry) => (root ? `${root}/${entry}` : entry))]),
  ].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Convert native reporter events to a content-only exchange artifact, never admission evidence.
 * @param {string} log
 * @param {unknown} context
 * @param {unknown} [dependencyRecord]
 */
export function collectTestObservations(log, context, dependencyRecord = null) {
  const identity = observationContext(context);
  const invocations = new Map();
  for (const raw of stripVTControlCharacters(log).split("\n")) {
    const line = raw.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/u, "").replace(/^\[shard:[^\]]+\]\s*/u, "");
    const match = /^\[vitest:(inventory|module|run)\] (\{.*\})\s*$/u.exec(line);
    if (!match) {
      continue;
    }
    const event = JSON.parse(match[2]);
    if (typeof event.invocation !== "string" || !event.invocation) {
      continue;
    }
    if (match[1] === "inventory") {
      assert(
        event.version === 1 && !invocations.has(event.invocation),
        "Duplicate/unknown inventory",
      );
      assert(["node", "bun"].includes(event.runtime), "Unknown runtime");
      assert(
        typeof event.runtimeVersion === "string" && event.runtimeVersion.length > 0,
        "Missing runtime version",
      );
      assert(
        typeof event.platform === "string" && typeof event.arch === "string",
        "Missing platform identity",
      );
      assert(
        event.dependencyRoot === "" || isObservationPath(event.dependencyRoot),
        "Invalid dependency root",
      );
      assert(Array.isArray(event.files), "Missing inventory");
      const files = event.files.map(observationFile);
      const fileIds = new Set(files.map(observationFileId));
      assert(fileIds.size === files.length, "Duplicate inventory file");
      invocations.set(event.invocation, { event, files, fileIds, outcomes: new Map(), end: null });
    } else {
      const invocation = invocations.get(event.invocation);
      assert(invocation, "Outcome without inventory");
      if (match[1] === "run") {
        assert(!invocation.end, "Duplicate run completion");
        invocation.end = event;
      } else {
        assert(!invocation.end, "Outcome after run completion");
        const file = observationFile({ ...event, file: event.observationFile });
        const id = observationFileId(file);
        assert(invocation.fileIds.has(id), "Unknown outcome file");
        assert(!invocation.outcomes.has(id), "Duplicate outcome file");
        invocation.outcomes.set(id, event);
      }
    }
  }
  assert(invocations.size > 0, "No versioned Vitest inventories; use the resource reporter");
  const cacheBindings = new Map();
  for (const { event, files } of invocations.values()) {
    for (const file of files) {
      const key = JSON.stringify([file.project, file.file]);
      const bindings = cacheBindings.get(key) ?? new Set();
      bindings.add(
        JSON.stringify([
          file.pool,
          event.runtime,
          event.runtimeVersion,
          event.platform,
          event.arch,
          event.dependencyRoot,
        ]),
      );
      cacheBindings.set(key, bindings);
    }
  }
  return {
    version: 1,
    context: identity,
    invocations: [...invocations].map(([id, { event, files, outcomes, end }]) => {
      const ended = Boolean(
        end &&
        ["passed", "failed"].includes(end.reason) &&
        end.unhandledErrors === 0 &&
        end.files === files.length,
      );
      const observations = files.map((file) => {
        const outcome = outcomes.get(observationFileId(file));
        const counts = outcome?.cases;
        const validCounts =
          object(counts) &&
          ["passed", "failed", "skipped", "pending"].every(
            (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
          );
        const complete =
          ended &&
          validCounts &&
          counts.passed + counts.failed > 0 &&
          counts.skipped === 0 &&
          counts.pending === 0 &&
          ["passed", "failed"].includes(outcome.state) &&
          (outcome.state === "failed") === counts.failed > 0;
        // Native caches omit pool/runtime identity. Never share edges across incompatible runs.
        const unambiguous = cacheBindings.get(JSON.stringify([file.project, file.file])).size === 1;
        const dependencies = unambiguous
          ? dependenciesFor(dependencyRecord, file, event.dependencyRoot)
          : null;
        return {
          ...file,
          complete,
          outcome: complete ? outcome.state : "unknown",
          cases: validCounts
            ? {
                passed: counts.passed,
                failed: counts.failed,
                skipped: counts.skipped,
                pending: counts.pending,
              }
            : null,
          durationMs:
            Number.isFinite(outcome?.diagnostic?.duration) && outcome.diagnostic.duration >= 0
              ? outcome.diagnostic.duration
              : null,
          dependencies,
        };
      });
      return {
        id,
        dependencyRoot: event.dependencyRoot,
        runtime: event.runtime,
        runtimeVersion: event.runtimeVersion,
        platform: event.platform,
        arch: event.arch,
        complete: observations.length > 0 && observations.every((file) => file.complete),
        elapsedMs: Number.isFinite(end?.elapsedMs) && end.elapsedMs >= 0 ? end.elapsedMs : null,
        files: observations,
      };
    }),
  };
}

// Large native graphs repeat the same paths across many files. Compact only the
// exchange representation; selection and model code keep resolved path arrays.
export function compactTestObservations(observations) {
  const indexes = new Map();
  const dependencyPaths = [];
  return {
    ...observations,
    version: 2,
    dependencyPaths,
    invocations: observations.invocations.map((invocation) => ({
      ...invocation,
      files: invocation.files.map((file) => ({
        ...file,
        dependencies:
          file.dependencies?.map((dependency) => {
            if (!indexes.has(dependency)) {
              indexes.set(dependency, dependencyPaths.length);
              dependencyPaths.push(dependency);
            }
            return indexes.get(dependency);
          }) ?? null,
      })),
    })),
  };
}

/** @returns {ReturnType<typeof collectTestObservations>} */
export function decodeTestObservations(observations) {
  assert(object(observations), "Missing observations");
  if (observations.version === 1) {
    return observations;
  }
  assert(observations.version === 2, "Unsupported observation version");
  const paths = observations.dependencyPaths;
  assert(
    Array.isArray(paths) && paths.every(isObservationPath) && new Set(paths).size === paths.length,
    "Invalid dependency path table",
  );
  assert(Array.isArray(observations.invocations), "Missing observation invocations");
  return {
    version: 1,
    context: observations.context,
    invocations: observations.invocations.map((invocation) => {
      assert(object(invocation) && Array.isArray(invocation.files), "Missing observation files");
      return {
        ...invocation,
        files: invocation.files.map((file) => {
          assert(object(file), "Invalid observation file");
          const indexes = file.dependencies;
          assert(
            indexes === null ||
              (Array.isArray(indexes) &&
                indexes.every(
                  (index) => Number.isSafeInteger(index) && index >= 0 && index < paths.length,
                )),
            "Invalid dependency path index",
          );
          return { ...file, dependencies: indexes?.map((index) => paths[index]) ?? null };
        }),
      };
    }),
  };
}
