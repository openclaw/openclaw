#!/usr/bin/env node

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateClawHubTransactions } from "./clawhub-parent-authorization.mjs";
import { stripLeadingPackageManagerSeparator } from "./lib/arg-utils.runtime.mjs";
import { readBoundedResponseText } from "./lib/bounded-response.mjs";
import {
  classifyClawHubPublication,
  isClawHubPublishAttemptId,
} from "./lib/clawhub-publication-state.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const PACKAGE_PATTERN = /^@openclaw\/[a-z0-9][a-z0-9._-]*$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const RECOVERY_CONFLICT = Symbol("recoveryConflict");

export function formatClawHubRecoveryCommand({ attemptId, clawhubSource, reason, registry }) {
  if (!isClawHubPublishAttemptId(attemptId)) {
    throw new Error("Invalid ClawHub publish attempt.");
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "bun",
    quote(join(clawhubSource, "packages/clawhub/src/cli.ts")),
    ...(registry ? ["--registry", quote(registry)] : []),
    "--no-input package recover",
    quote(attemptId),
    "--manual-override-reason",
    quote(reason),
    "--wait --wait-timeout 1800 --json",
  ].join(" ");
}

function parsePublishRecord(path) {
  const record = JSON.parse(readFileSync(path, "utf8"));
  if (
    !record ||
    typeof record !== "object" ||
    !PACKAGE_PATTERN.test(record.name) ||
    !VERSION_PATTERN.test(record.version) ||
    !["published", "pending", "failed"].includes(record.publicationStatus)
  ) {
    throw new Error(`Invalid ClawHub publish artifact: ${path}`);
  }
  if (record.publicationStatus !== "published" && !isClawHubPublishAttemptId(record.attemptId)) {
    throw new Error(`Missing or invalid ClawHub publish attempt: ${path}`);
  }
  return record;
}

export function createClawHubRecoveryManifest(transactionsInput, recordsInput) {
  const transactions = validateClawHubTransactions(transactionsInput);
  const records = new Map();
  for (const record of recordsInput) {
    const key = `${record.name}@${record.version}`;
    if (records.has(key)) {
      throw new Error(`Duplicate ClawHub publish artifact: ${key}`);
    }
    records.set(key, record);
  }
  const attempts = new Set();
  const packages = transactions.packages.map((transaction) => {
    const key = `${transaction.name}@${transaction.version}`;
    const record = records.get(key);
    if (!record) {
      return {
        name: transaction.name,
        version: transaction.version,
        inventoryDigest: transaction.inventoryDigest,
        artifactName: transaction.artifactName,
        artifactSha256: transaction.artifactSha256,
        artifactSize: transaction.artifactSize,
        publicationStatus: "unavailable",
      };
    }
    records.delete(key);
    if (record.attemptId) {
      if (attempts.has(record.attemptId)) {
        throw new Error(`Duplicate ClawHub publish attempt: ${record.attemptId}`);
      }
      attempts.add(record.attemptId);
    }
    return {
      name: transaction.name,
      version: transaction.version,
      inventoryDigest: transaction.inventoryDigest,
      artifactName: transaction.artifactName,
      artifactSha256: transaction.artifactSha256,
      artifactSize: transaction.artifactSize,
      publicationStatus: record.publicationStatus,
      ...(record.attemptId ? { attemptId: record.attemptId } : {}),
    };
  });
  if (records.size) {
    throw new Error(
      "ClawHub publish artifacts contain packages outside the sealed transaction roster.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "openclaw-clawhub-recovery-manifest",
    identity: transactions.identity,
    packages,
  };
}

export function validateClawHubRecoveryManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.schemaVersion !== 1 ||
    manifest.kind !== "openclaw-clawhub-recovery-manifest" ||
    !Array.isArray(manifest.packages)
  ) {
    throw new Error("Invalid ClawHub recovery manifest.");
  }
  validateClawHubTransactions({
    schemaVersion: 1,
    identity: manifest.identity,
    packages: manifest.packages.map(
      ({ name, version, inventoryDigest, artifactName, artifactSha256, artifactSize }) => ({
        name,
        version,
        inventoryDigest,
        artifactName,
        artifactSha256,
        artifactSize,
      }),
    ),
  });
  for (const entry of manifest.packages) {
    if (
      !["published", "pending", "failed", "unavailable"].includes(entry.publicationStatus) ||
      (["pending", "failed"].includes(entry.publicationStatus) &&
        !isClawHubPublishAttemptId(entry.attemptId)) ||
      (entry.publicationStatus === "unavailable" && entry.attemptId !== undefined)
    ) {
      throw new Error("Invalid ClawHub recovery manifest package state.");
    }
  }
  return manifest;
}

export function validateClawHubRecoveryRun(manifestInput, run) {
  const manifest = validateClawHubRecoveryManifest(manifestInput);
  const identity = manifest.identity;
  if (
    run?.repository?.full_name !== identity.repository ||
    run?.head_repository?.full_name !== identity.repository ||
    String(run?.id) !== identity.runId ||
    String(run?.run_attempt) !== identity.runAttempt ||
    run?.path?.split("@")[0] !== identity.workflow ||
    run?.head_sha !== identity.sha ||
    run?.head_branch !== identity.ref ||
    run?.event !== "workflow_dispatch"
  ) {
    throw new Error("ClawHub recovery manifest does not bind the selected child run.");
  }
  return manifest;
}

async function requestRecovery(
  path,
  { registry, token, fetchImpl, body, allowConflict = false, allowNotFound = false },
) {
  const response = await fetchImpl(`${registry}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const text = await readBoundedResponseText(response, "ClawHub recovery", 256 * 1024);
  if (allowConflict && response.status === 409) {
    const retryAfter = response.headers.get("retry-after")?.trim();
    const retryAfterSeconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : 0;
    const retryAfterMilliseconds =
      retryAfterSeconds > 0 && retryAfterSeconds <= 300 ? retryAfterSeconds * 1000 : null;
    return { [RECOVERY_CONFLICT]: retryAfterMilliseconds };
  }
  if (allowNotFound && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`ClawHub recovery returned HTTP ${response.status}.`);
  }
  return JSON.parse(text);
}

function validateRecoveryAttempt(attempt, expected) {
  if (
    !attempt ||
    typeof attempt !== "object" ||
    attempt.attemptId !== expected.attemptId ||
    attempt.name !== expected.name ||
    attempt.version !== expected.version ||
    !["pending", "published", "blocked", "failed", "expired"].includes(attempt.publicationStatus)
  ) {
    throw new Error(`ClawHub recovery status changed the sealed transaction: ${expected.name}.`);
  }
  return attempt;
}

async function readPublicationState(expected, context) {
  const path = `/api/v1/packages/${encodeURIComponent(expected.name)}/versions/${encodeURIComponent(expected.version)}`;
  const state = await requestRecovery(`${path}/publication`, {
    ...context,
    allowNotFound: true,
  });
  const publication =
    state === undefined
      ? null
      : classifyClawHubPublication(state, { name: expected.name, version: expected.version });
  if (publication === null) {
    const published = await requestRecovery(path, { ...context, allowNotFound: true });
    return published === undefined ? { state: "unpublished" } : { state: "published" };
  }
  return publication;
}

// Receipts identify the original operation; only the registry selects what can
// happen now. Pending work belongs to ClawHub's existing finalizer, not recovery.
function selectRecoveryOperation(entry, publication) {
  if (publication.state === "published") {
    return "verify";
  }
  if (publication.state === "pending") {
    return "wait";
  }
  if (publication.state === "failed" && !publication.recoverable) {
    throw new Error(
      `ClawHub publication is not recoverable: ${entry.name}. Use a new version or ask the ClawHub operator to inspect the attempt.`,
    );
  }
  if (
    !["failed", "reconcile", "unpublished"].includes(publication.state) ||
    !isClawHubPublishAttemptId(entry.attemptId)
  ) {
    throw new Error(
      `ClawHub recovery ${publication.state}: ${entry.name}. No bound recoverable attempt; ask the ClawHub operator to inspect it.`,
    );
  }
  return "recover";
}

function describeRecoveryOperation(entry, operation, observedAttemptId) {
  const identity = `${entry.name}@${entry.version}`;
  if (operation === "verify") {
    return `${identity}: public publication state verified; no recovery performed. Run postpublish verification for sealed-byte evidence.`;
  }
  if (operation === "wait") {
    return `${identity}: observe the existing ClawHub finalizer; no recovery or replacement publication. If it remains pending, ask the ClawHub operator to run the targeted prepublication worker for attempt ${observedAttemptId ?? "unavailable"}.`;
  }
  return `${identity}: recover sealed attempt ${entry.attemptId} with current publisher authority; ClawHub validates eligibility and any existing successor.`;
}

async function waitForPublicationState(
  expected,
  context,
  deadline,
  { attemptId, recoverAttemptChange, recoverLegacyUnpublished, staleAttemptId },
) {
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`ClawHub recovery timed out: ${expected.name}.`);
    }
    const state = await readPublicationState(expected, context);
    if (recoverAttemptChange) {
      const operation = selectRecoveryOperation(expected, state);
      if (operation !== "recover") {
        context.report(describeRecoveryOperation(expected, operation, state.attemptId));
      }
      if (operation === "verify") {
        return state;
      }
    }
    const stale = state.attemptId !== undefined && state.attemptId === staleAttemptId;
    if (state.attemptId !== undefined && state.attemptId !== attemptId && !stale) {
      if (recoverAttemptChange) {
        return { state: "reconcile" };
      }
      throw new Error(`ClawHub publication state changed the sealed attempt: ${expected.name}.`);
    }
    const anonymousFailure = state.state === "failed" && state.attemptId === undefined;
    if (anonymousFailure && recoverAttemptChange) {
      return { state: "reconcile" };
    }
    const needsAttemptStatus =
      stale || anonymousFailure || (state.state === "unpublished" && !recoverLegacyUnpublished);
    if (needsAttemptStatus) {
      const current = validateRecoveryAttempt(
        await requestRecovery(`/api/v1/publish/attempts/${encodeURIComponent(attemptId)}`, context),
        { ...expected, attemptId },
      );
      if (current.publicationStatus !== "pending") {
        return { state: current.publicationStatus };
      }
    }
    if (
      !stale &&
      !anonymousFailure &&
      state.state !== "pending" &&
      (state.state !== "unpublished" || recoverLegacyUnpublished)
    ) {
      return state;
    }
    if (Date.now() >= deadline) {
      throw new Error(`ClawHub recovery timed out: ${expected.name}.`);
    }
    await context.wait(10_000);
  }
}

export async function executeClawHubRecoveryManifest({
  manifest: rawManifest,
  reason,
  registry = "https://clawhub.ai",
  token,
  fetchImpl = fetch,
  wait = (milliseconds) =>
    new Promise((resolveWait) => {
      setTimeout(resolveWait, milliseconds);
    }),
  timeoutMilliseconds = 30 * 60 * 1000,
  report = console.error,
}) {
  const manifest = validateClawHubRecoveryManifest(rawManifest);
  const trimmedReason = reason?.trim();
  if (!trimmedReason || trimmedReason.length > 500 || !token) {
    throw new Error("ClawHub recovery requires a token and a 1-500 character reason.");
  }
  const unavailable = manifest.packages.find((entry) => entry.publicationStatus === "unavailable");
  if (unavailable) {
    throw new Error(
      `ClawHub package was not staged and has no recoverable attempt: ${unavailable.name}.`,
    );
  }
  const recovered = [];
  for (const entry of manifest.packages) {
    const deadline = Date.now() + timeoutMilliseconds;
    let lastMessage;
    const context = {
      registry,
      token,
      fetchImpl,
      wait,
      report: (message) => {
        if (message !== lastMessage) {
          report(message);
        }
        lastMessage = message;
      },
    };
    let publication = await waitForPublicationState(entry, context, deadline, {
      attemptId: entry.attemptId,
      recoverAttemptChange: true,
      recoverLegacyUnpublished: true,
    });
    if (publication.state === "published") {
      continue;
    }
    let started;
    for (;;) {
      context.report(
        describeRecoveryOperation(
          entry,
          selectRecoveryOperation(entry, publication),
          publication.attemptId,
        ),
      );
      started = await requestRecovery(
        `/api/v1/publish/attempts/${encodeURIComponent(entry.attemptId)}/recover`,
        {
          registry,
          token,
          fetchImpl,
          body: { manualOverrideReason: trimmedReason },
          allowConflict: publication.state === "unpublished",
        },
      );
      const retryAfter = started?.[RECOVERY_CONFLICT];
      if (retryAfter === undefined) {
        break;
      }
      publication = await readPublicationState(entry, context);
      if (publication.state === "published") {
        break;
      }
      if (retryAfter === null) {
        throw new Error("ClawHub recovery returned HTTP 409.");
      }
      if (retryAfter >= deadline - Date.now()) {
        throw new Error(`ClawHub recovery timed out: ${entry.name}.`);
      }
      await wait(retryAfter);
      publication = await waitForPublicationState(entry, context, deadline, {
        attemptId: entry.attemptId,
        recoverAttemptChange: true,
        recoverLegacyUnpublished: true,
      });
      if (publication.state === "published") {
        break;
      }
    }
    if (started?.[RECOVERY_CONFLICT] !== undefined) {
      continue;
    }
    if (
      started.recoveredFromAttemptId !== entry.attemptId ||
      started.name !== entry.name ||
      started.version !== entry.version ||
      !isClawHubPublishAttemptId(started.attemptId)
    ) {
      throw new Error(`ClawHub recovery response changed the sealed transaction: ${entry.name}.`);
    }
    validateRecoveryAttempt(started, {
      attemptId: started.attemptId,
      name: entry.name,
      version: entry.version,
    });
    if (["blocked", "failed", "expired"].includes(started.publicationStatus)) {
      throw new Error(`ClawHub recovery ${started.publicationStatus}: ${entry.name}.`);
    }
    if (started.publicationStatus !== "published") {
      const state = await waitForPublicationState(entry, context, deadline, {
        attemptId: started.attemptId,
        recoverLegacyUnpublished: false,
        staleAttemptId: entry.attemptId,
      });
      if (state.state !== "published") {
        throw new Error(`ClawHub recovery ${state.state}: ${entry.name}.`);
      }
    }
    recovered.push({
      name: entry.name,
      version: entry.version,
      recoveredFromAttemptId: entry.attemptId,
      attemptId: started.attemptId,
      publicationStatus: "published",
    });
  }
  return { schemaVersion: 1, complete: true, recovered };
}

async function main() {
  const { values, positionals } = parseArgs({
    args: stripLeadingPackageManagerSeparator(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      version: { type: "string" },
      reason: { type: "string" },
      "clawhub-source": { type: "string" },
      transactions: { type: "string" },
      manifest: { type: "string" },
      "run-json": { type: "string" },
      output: { type: "string" },
      registry: { type: "string", default: "https://clawhub.ai" },
    },
  });
  const operation = positionals[0];
  if (operation === "create") {
    positionals.shift();
    if (!values.transactions || !values.output) {
      throw new Error("Create requires --transactions and --output.");
    }
    const manifest = createClawHubRecoveryManifest(
      JSON.parse(readFileSync(values.transactions, "utf8")),
      positionals.map(parsePublishRecord),
    );
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return;
  }
  if (operation === "snapshot") {
    positionals.shift();
    if (!values.output) {
      throw new Error("Snapshot requires --output.");
    }
    const packages = positionals.map(parsePublishRecord).map((record) => {
      const entry = {
        name: record.name,
        version: record.version,
        publicationStatus: record.publicationStatus,
      };
      return record.attemptId ? Object.assign(entry, { attemptId: record.attemptId }) : entry;
    });
    const snapshot = {
      schemaVersion: 1,
      kind: "openclaw-clawhub-cleanup-snapshot",
      childRunId: process.env.CHILD_RUN_ID,
      childRunAttempt: process.env.CHILD_RUN_ATTEMPT,
      completeManifestAvailable: process.env.COMPLETE_MANIFEST_AVAILABLE === "true",
      packages,
    };
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
    return;
  }
  if (operation === "execute") {
    positionals.shift();
    if (!values.manifest || !values["run-json"]) {
      throw new Error("Execute requires --manifest and --run-json.");
    }
    const manifest = validateClawHubRecoveryRun(
      JSON.parse(readFileSync(values.manifest, "utf8")),
      JSON.parse(readFileSync(values["run-json"], "utf8")),
    );
    const result = await executeClawHubRecoveryManifest({
      manifest,
      reason: values.reason,
      registry: values.registry,
      token: process.env.CLAWHUB_TOKEN,
    });
    if (values.output) {
      mkdirSync(dirname(values.output), { recursive: true });
      writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    } else {
      console.log(JSON.stringify(result));
    }
    return;
  }

  const reason = values.reason?.trim();
  if (
    !values.version ||
    !VERSION_PATTERN.test(values.version) ||
    !reason ||
    reason.length > 500 ||
    !values["clawhub-source"] ||
    !positionals.length
  ) {
    throw new Error(
      "Usage: node scripts/plugin-clawhub-recovery.mjs --version <version> --reason <reason> --clawhub-source <checkout> <publish-json>...",
    );
  }
  const names = new Set();
  const attempts = new Set();
  const commands = [];
  for (const path of positionals) {
    const record = parsePublishRecord(path);
    if (record.version !== values.version || names.has(record.name)) {
      throw new Error(`Mixed-version or duplicate publish artifact: ${path}`);
    }
    names.add(record.name);
    if (record.attemptId && attempts.has(record.attemptId)) {
      throw new Error(`Duplicate publish attempt: ${path}`);
    }
    if (record.attemptId) {
      attempts.add(record.attemptId);
    }
    const publication = await readPublicationState(record, {
      registry: values.registry,
      fetchImpl: fetch,
    });
    const recoveryOperation = selectRecoveryOperation(record, publication);
    commands.push(
      `# ${describeRecoveryOperation(record, recoveryOperation, publication.attemptId)}`,
    );
    if (recoveryOperation === "recover") {
      commands.push(
        formatClawHubRecoveryCommand({
          attemptId: record.attemptId,
          clawhubSource: resolve(values["clawhub-source"]),
          registry: values.registry,
          reason,
        }),
      );
    }
  }
  console.error(
    "Review these commands against the original child/parent attempt before executing; no recovery was performed.",
  );
  if (commands.length) {
    console.log(commands.join("\n"));
  }
}

if (process.argv[1] && isDirectRunUrl(realpathSync(process.argv[1]), import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[plugin-clawhub-recovery] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
