import { readFileSync, realpathSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "../packages/normalization-core/src/record-coerce.js";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.js";
import {
  createPublicationObservations,
  publicationObservationJson,
  publicationPendingAuthority,
  validatePublicationSourceBinding,
  type PublicationSourceFact,
} from "./full-release-publication-contract.mjs";
import { compareAscii } from "./lib/canonical-json.mjs";
import {
  collectPluginClawHubReleasePlan,
  observeClawHubPackage,
  type ClawHubPackageObservation,
} from "./lib/plugin-clawhub-release.ts";
import {
  collectPluginReleasePlan,
  observeNpmPackage,
  type NpmPackageObservation,
} from "./lib/plugin-npm-release.ts";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-publication-candidates.ts";
import { collectPublishablePluginPackagesFromCandidates } from "./lib/plugin-publication-collector.ts";

const MAX_NPM_NAMES = 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_COLLECTION_MS = 300_000;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

type SelectedPackage = { name: string; version: string; targets: string[] };
type NpmRead = {
  name: string;
  version: string | null;
  required: boolean;
  observedAt: string;
} & (
  | { outcome: "observed"; state: NpmPackageObservation }
  | { outcome: "unavailable"; error: string }
);
type ClawHubRead = {
  name: string;
  version: string;
  observedAt: string;
  state: ClawHubPackageObservation;
};

class PublicationObservationFailure extends Error {
  constructor(registry: string, name: string, reason: string) {
    super(`${name}: required ${registry} observation ${reason}.`);
  }
}

function selectedPackages(source: PublicationSourceFact): SelectedPackage[] {
  return (source.projection?.packages ?? []).map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      !PACKAGE_NAME.test(entry.name) ||
      typeof entry.version !== "string" ||
      !Array.isArray(entry.targets) ||
      !entry.targets.every((target): target is string => typeof target === "string")
    ) {
      throw new Error("Invalid verified publication package projection.");
    }
    return { name: entry.name, version: entry.version, targets: entry.targets };
  });
}

function failureClass(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const status = /\bHTTP ([1-5][0-9]{2})\b/u.exec(message)?.[1];
  if (status) {
    return `http-${status}`;
  }
  if (/empty version history/u.test(message)) {
    return "empty-version-history";
  }
  if (/bootstrap is unsupported/u.test(message)) {
    return "unsupported-bootstrap";
  }
  if (/bytes|byte limit/u.test(message)) {
    return "response-too-large";
  }
  if (/invalid|parse|JSON/u.test(message)) {
    return "invalid-response";
  }
  if (/abort|deadline|timed out|timeout/iu.test(message)) {
    return "cancelled-or-timeout";
  }
  return "read-failed";
}

async function collectObservations(params: {
  snapshot: string;
  source: PublicationSourceFact;
  prerequisitesCompletedAt: string;
}) {
  const source = validatePublicationSourceBinding({
    sourceAdmissionContract: "1",
    sourceAdmission: params.source,
  });
  if (!source || source.status !== "source-admitted" || !source.publicationSelection) {
    throw new Error("Registry observations require verified publication source.");
  }
  const selection = source.publicationSelection;
  const roster = selectedPackages(source);
  const prerequisites = Date.parse(params.prerequisitesCompletedAt);
  const startedAt = Date.now();
  if (!Number.isFinite(prerequisites) || prerequisites > startedAt) {
    throw new Error("Invalid publication prerequisite time.");
  }
  const remainingMs = prerequisites + MAX_COLLECTION_MS - startedAt;
  if (remainingMs <= 0) {
    throw new Error("Publication observation deadline exceeded.");
  }
  const controller = new AbortController();
  const signal = controller.signal;
  let advisoryController: AbortController | undefined;
  const readSignal = () =>
    advisoryController ? AbortSignal.any([signal, advisoryController.signal]) : signal;
  const assertActive = () => {
    if (Date.now() >= prerequisites + MAX_COLLECTION_MS) {
      controller.abort(new Error("Publication observation deadline exceeded."));
    }
    signal.throwIfAborted();
  };
  const onTerminate = () => controller.abort(new Error("Publication observations cancelled."));
  let bytesConsumed = 0;
  const bodyCleanups = new Set<Promise<void>>();
  const npm = new Map<string, NpmRead>();
  const clawhub = new Map<string, ClawHubRead>();
  const requiredNpm = roster.filter((entry) => entry.targets.includes("npm"));
  const requiredClawHub = roster.filter((entry) => entry.targets.includes("clawhub"));
  const selected = new Set(roster.map((entry) => entry.name));
  const candidates = collectExtensionPackageJsonCandidates(params.snapshot);
  const npmPlugins = collectPublishablePluginPackagesFromCandidates(
    candidates,
    "npm",
    selection.route === "extended-stable"
      ? { npmDistTag: "extended-stable", rootVersion: source.projection!.version }
      : {},
  ).filter((entry) => selected.has(entry.packageName));
  const plugins = [
    ...npmPlugins,
    ...(requiredClawHub.length
      ? collectPublishablePluginPackagesFromCandidates(candidates, "clawhub")
      : []),
  ].filter((entry) => selected.has(entry.packageName));
  const npmNames = new Set([
    ...requiredNpm.map((entry) => entry.name),
    ...plugins.flatMap((entry) =>
      (entry.requiredLatestDependencies ?? []).map((dependency) => dependency.packageName),
    ),
  ]);
  const permitted = new Set<string>();
  for (const name of npmNames) {
    if (!PACKAGE_NAME.test(name) || name.length > 256 || npmNames.size > MAX_NPM_NAMES) {
      throw new Error("Invalid or oversized publication npm roster.");
    }
    permitted.add(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  }
  for (const entry of requiredClawHub) {
    const base = `https://clawhub.ai/api/v1/packages/${encodeURIComponent(entry.name)}`;
    permitted.add(base);
    permitted.add(`${base}/trusted-publisher`);
    permitted.add(`${base}/versions/${encodeURIComponent(entry.version)}`);
  }
  // The two required registries share one task pool. Each task's retries/body
  // finish before its slot is released; advisory-only tasks start afterward.
  const fetchPublic: typeof fetch = async (input, init = {}) => {
    assertActive();
    const phaseSignal = readSignal();
    phaseSignal.throwIfAborted();
    const url = input instanceof Request ? input.url : String(input);
    if (!permitted.has(url) || (init.method ?? "GET") !== "GET") {
      throw new Error("Unplanned public registry request.");
    }
    const headers = new Headers(init.headers);
    if ([...headers.keys()].some((key) => key !== "accept")) {
      throw new Error("Public registry request contains unexpected headers.");
    }
    const requestSignal = init.signal ? AbortSignal.any([phaseSignal, init.signal]) : phaseSignal;
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: requestSignal,
    });
    if (requestSignal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      requestSignal.throwIfAborted();
    }
    if (response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new Error("Unexpected registry response origin.");
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return response;
    }
    let output: ReadableStreamDefaultController<Uint8Array>;
    const cancel = () => {
      const cleanup = reader.cancel().catch(() => undefined);
      bodyCleanups.add(cleanup);
      void cleanup.finally(() => bodyCleanups.delete(cleanup));
      return cleanup;
    };
    const onAbort = () => {
      void cancel();
      output.error(requestSignal.reason);
    };
    const dispose = () => requestSignal.removeEventListener("abort", onAbort);
    // Count decoded bytes across successful, malformed and retried bodies.
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        output = stream;
        requestSignal.addEventListener("abort", onAbort, { once: true });
        if (requestSignal.aborted) {
          onAbort();
        }
      },
      async pull(stream) {
        try {
          requestSignal.throwIfAborted();
          const next = await reader.read();
          requestSignal.throwIfAborted();
          if (next.done) {
            dispose();
            stream.close();
            reader.releaseLock();
            return;
          }
          bytesConsumed += next.value.byteLength;
          if (bytesConsumed > MAX_RESPONSE_BYTES) {
            const error = new Error("Publication aggregate response byte limit exceeded.");
            // Required observations have already completed before this optional
            // phase. Exhaustion cancels its remaining reads, not validation.
            (advisoryController ?? controller).abort(error);
            throw error;
          }
          stream.enqueue(next.value);
        } catch (error) {
          dispose();
          await cancel();
          stream.error(error);
        }
      },
      async cancel() {
        dispose();
        await cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const sleep = async (ms: number) => {
    signal.throwIfAborted();
    await delay(ms, undefined, { signal: readSignal() });
  };
  const pendingAuthority: Array<{
    registry: "npm" | "clawhub";
    name: string;
    action: string;
    status: "unresolved";
  }> = [];
  const readNpm = async (name: string, version: string | null) => {
    if (npm.has(name)) {
      throw new Error("Duplicate logical npm observation.");
    }
    const observedAt = new Date().toISOString();
    try {
      const state = await observeNpmPackage({
        packageName: name,
        packageUrl: `https://registry.npmjs.org/${encodeURIComponent(name)}`,
        version: version ?? undefined,
        signal: readSignal(),
        deadlineMs: prerequisites + MAX_COLLECTION_MS,
        maxBytes: 16 * 1024 * 1024,
        redirect: "manual",
        fetchImpl: fetchPublic,
        sleep,
      });
      npm.set(name, {
        name,
        version,
        required: version !== null,
        observedAt,
        outcome: "observed",
        state,
      });
      if (version !== null) {
        const pending = publicationPendingAuthority(source, "npm", { name, version, state });
        if (pending) {
          pendingAuthority.push(pending);
        }
      }
    } catch (error) {
      const classification = failureClass(error);
      npm.set(name, {
        name,
        version,
        required: version !== null,
        observedAt,
        outcome: "unavailable",
        error: classification,
      });
      if (version !== null) {
        throw new PublicationObservationFailure("npm", name, classification);
      }
      signal.throwIfAborted();
    }
  };
  const requiredTasks: Array<() => Promise<void>> = [
    ...requiredNpm.map((entry) => () => readNpm(entry.name, entry.version)),
    ...requiredClawHub.map((entry) => async () => {
      const observedAt = new Date().toISOString();
      let state: ClawHubPackageObservation;
      try {
        state = await observeClawHubPackage(entry.name, entry.version, {
          registryBaseUrl: "https://clawhub.ai",
          fetchImpl: fetchPublic,
          sleep,
        });
      } catch (error) {
        throw new PublicationObservationFailure("ClawHub", entry.name, failureClass(error));
      }
      clawhub.set(entry.name, { name: entry.name, version: entry.version, observedAt, state });
      const pending = publicationPendingAuthority(source, "clawhub", { ...entry, state });
      if (pending) {
        pendingAuthority.push(pending);
      }
    }),
  ];
  const run = async (tasks: Array<() => Promise<void>>) => {
    assertActive();
    const result = await runTasksWithConcurrency({
      tasks,
      limit: 8,
      errorMode: "stop",
      onTaskError: (error) => controller.abort(error),
    });
    if (result.hasError) {
      throw result.firstError;
    }
    assertActive();
  };
  const deadline = setTimeout(
    () => controller.abort(new Error("Publication observation deadline exceeded.")),
    Math.max(1, prerequisites + MAX_COLLECTION_MS - Date.now()),
  );
  process.once("SIGTERM", onTerminate);
  process.once("SIGINT", onTerminate);
  try {
    await run(requiredTasks);
    advisoryController = new AbortController();
    await run(
      [...npmNames].filter((name) => !npm.has(name)).map((name) => () => readNpm(name, null)),
    );
    const resolveLatestVersion = (name: string) => {
      const row = npm.get(name);
      if (!row) {
        throw new Error("Unplanned advisory npm key.");
      }
      if (row.outcome !== "observed" || !row.state.latestVersion) {
        throw new Error("Public latest observation unavailable.");
      }
      return row.state.latestVersion;
    };
    const npmPluginNames = plugins
      .filter((plugin) => requiredNpm.some((entry) => entry.name === plugin.packageName))
      .map((plugin) => plugin.packageName);
    const npmPlan = npmPluginNames.length
      ? await collectPluginReleasePlan({
          rootDir: params.snapshot,
          selection: [...new Set(npmPluginNames)],
          selectionMode: "selected",
          npmDistTag: selection.route === "extended-stable" ? "extended-stable" : undefined,
          resolveLatestVersion,
          resolvePublishedVersion: async (name, version) => {
            const row = npm.get(name);
            if (!row || row.outcome !== "observed" || row.version !== version) {
              throw new Error("Unplanned required npm key.");
            }
            return row.state.selectedVersionExists;
          },
        })
      : { all: [], candidates: [], skippedPublished: [], warnings: [] };
    const clawhubPlan = requiredClawHub.length
      ? await collectPluginClawHubReleasePlan({
          rootDir: params.snapshot,
          selection: requiredClawHub.map((entry) => entry.name),
          selectionMode: "selected",
          resolveLatestVersion,
          resolvePackageState: async (name, version) => {
            const row = clawhub.get(name);
            if (!row || row.version !== version) {
              throw new Error("Unplanned required ClawHub key.");
            }
            return row.state;
          },
        })
      : {
          all: [],
          candidates: [],
          bootstrapCandidates: [],
          missingTrustedPublisher: [],
          skippedPublished: [],
          warnings: [],
        };
    assertActive();
    const entries = (
      rows: Array<{ packageName: string; version: string; alreadyPublished: boolean }>,
    ) =>
      rows.map((row) => ({
        name: row.packageName,
        version: row.version,
        alreadyPublished: row.alreadyPublished,
      }));
    const names = (rows: Array<{ packageName: string }>) => rows.map((row) => row.packageName);
    return createPublicationObservations(source, {
      sourceDigest: source.digest,
      prerequisitesCompletedAt: params.prerequisitesCompletedAt,
      collectionStartedAt: new Date(startedAt).toISOString(),
      collectionCompletedAt: new Date().toISOString(),
      npm: [...npm.values()].toSorted((a, b) => compareAscii(a.name, b.name)),
      clawhub: [...clawhub.values()].toSorted((a, b) => compareAscii(a.name, b.name)),
      pendingAuthority: pendingAuthority.toSorted((a, b) =>
        compareAscii(`${a.registry}/${a.name}`, `${b.registry}/${b.name}`),
      ),
      plans: {
        npm: {
          all: entries(npmPlan.all),
          candidates: names(npmPlan.candidates),
          skippedPublished: names(npmPlan.skippedPublished),
          warnings: npmPlan.warnings,
        },
        clawhub: {
          all: entries(clawhubPlan.all),
          candidates: names(clawhubPlan.candidates),
          bootstrapCandidates: names(clawhubPlan.bootstrapCandidates),
          missingTrustedPublisher: names(clawhubPlan.missingTrustedPublisher),
          skippedPublished: names(clawhubPlan.skippedPublished),
          warnings: clawhubPlan.warnings,
        },
      },
    });
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", onTerminate);
    process.off("SIGINT", onTerminate);
    await Promise.allSettled(bodyCleanups);
  }
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // Pure imports need no filesystem entrypoint.
  }
}
if (invokedAsMain) {
  try {
    const input = process.argv[2];
    if (!input || process.argv.length !== 3) {
      throw new Error("One internal publication observation request is required.");
    }
    const bytes = readFileSync(input);
    if (bytes.length > 1024 * 1024) {
      throw new Error("Publication observation request exceeds byte limit.");
    }
    const result = await collectObservations(JSON.parse(bytes.toString("utf8")));
    const serialized = publicationObservationJson(result);
    if (Buffer.byteLength(serialized) > 1024 * 1024) {
      throw new Error("Publication observations exceed artifact byte limit.");
    }
    process.stdout.write(serialized);
  } catch (error) {
    console.error(
      JSON.stringify({
        stage: "publication-observations",
        error: error instanceof PublicationObservationFailure ? error.message : failureClass(error),
      }),
    );
    process.exitCode = 1;
  }
}
