import { createHash } from "node:crypto";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getGatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { OpenClawPluginApi, OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  PluginStateActionAuthority,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import type {
  CatalogExportItem,
  PluginServiceCatalogExports,
  PluginServiceExportCatalog,
  SessionCatalogLocator,
} from "openclaw/plugin-sdk/session-catalog";
import {
  fetchWithSsrFGuard,
  GuardedFetchRedirectError,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { asFiniteNumber, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { clampNumber, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { cleanBeamCandidate, type BeamCleanCandidate } from "./cleaner.js";
import {
  openBeamMirrorEnrollment,
  type BeamMirrorEnrollment,
  type MirrorPublicationStoreValue,
} from "./mirror-publication.js";
import {
  BEAM_MAX_ITEMS,
  BEAM_MAX_SESSIONS,
  BEAM_RETENTION_MS,
  type BeamSourceModel,
  type BeamUpload,
} from "./types.js";

const MIRROR_CONFIG_PATH = "plugins.entries.beam.config.mirror";
const MIRROR_TOKEN_PATH = `${MIRROR_CONFIG_PATH}.token`;
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_ACTIVE_WINDOW_MINUTES = 180;
const MIRROR_LIST_LIMIT = 100;
// Strictest transcript-read cap across catalog providers (the Claude Code
// provider rejects limits above 50); asking for more fails the whole read.
const MIRROR_READ_LIMIT = 50;
// Bounds concurrent remote rows and per-tick reads; oldest active sessions
// beyond the cap simply wait until newer ones go idle.
const MIRROR_MAX_SESSIONS = 32;
// Keeping twice the receiver capacity prevents independent clocks and foreign
// writers from making the sender under-retain retry ownership.
const MIRROR_RETRY_CAP = 2 * BEAM_MAX_SESSIONS;
// One warning per source per interval keeps a broken endpoint from flooding logs.
const MIRROR_WARN_INTERVAL_MS = 5 * 60_000;
const MIRROR_UPLOAD_TIMEOUT_MS = 15_000;

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

const MIRROR_KEYS = new Set([
  "endpoint",
  "token",
  "catalogs",
  "pollSeconds",
  "activeWindowMinutes",
]);

/** Returns the mirror config, undefined when mirroring is not configured, or an error string. */
export function parseBeamMirrorConfig(config: ReturnType<PluginRuntime["config"]["current"]>) {
  const mirror = config.plugins?.entries?.beam?.config?.mirror;
  if (mirror === undefined) {
    return undefined;
  }
  if (!isRecord(mirror) || !Object.keys(mirror).every((key) => MIRROR_KEYS.has(key))) {
    return `${MIRROR_CONFIG_PATH} must be a closed object with endpoint/token/catalogs/pollSeconds/activeWindowMinutes`;
  }
  const endpoint = typeof mirror.endpoint === "string" ? mirror.endpoint.trim() : "";
  const parsedEndpoint = URL.parse(endpoint);
  if (!parsedEndpoint) {
    return `${MIRROR_CONFIG_PATH}.endpoint must be an absolute URL`;
  }
  // Bearer credentials and transcripts must never cross the network in the
  // clear; plaintext HTTP is a loopback-development affordance only.
  if (parsedEndpoint.protocol === "http:") {
    if (!isLoopbackHostname(parsedEndpoint.hostname)) {
      return `${MIRROR_CONFIG_PATH}.endpoint must use https for non-loopback hosts`;
    }
  } else if (parsedEndpoint.protocol !== "https:") {
    return `${MIRROR_CONFIG_PATH}.endpoint must use http(s)`;
  }
  // Explicit per-catalog consent: an omitted or empty list mirrors nothing,
  // so one Beam setting can never silently export third-party catalogs.
  if (
    !Array.isArray(mirror.catalogs) ||
    mirror.catalogs.length === 0 ||
    !mirror.catalogs.every((id): id is string => typeof id === "string" && id.trim().length > 0)
  ) {
    return `${MIRROR_CONFIG_PATH}.catalogs must explicitly list the catalog ids to mirror`;
  }
  const normalizedPath = parsedEndpoint.pathname.replace(/\/$/, "");
  const apiV2 = normalizedPath.endsWith("/api/v2/beam");
  if (apiV2) {
    if (
      parsedEndpoint.username ||
      parsedEndpoint.password ||
      parsedEndpoint.search ||
      parsedEndpoint.hash
    )
      return `${MIRROR_CONFIG_PATH}.endpoint must name the final v2 receiver without user info, query, or fragment`;
    parsedEndpoint.pathname = normalizedPath;
  }
  // The Gateway materializes refs to strings and leaves unavailable refs as objects.
  // null means configured but unavailable; undefined keeps tokenless receivers supported.
  const token =
    mirror.token === undefined
      ? undefined
      : typeof mirror.token === "string" && mirror.token.trim()
        ? mirror.token.trim()
        : null;
  return {
    endpoint: apiV2 ? parsedEndpoint.href : endpoint,
    apiV2,
    token,
    catalogs: mirror.catalogs.map((id) => id.trim().toLowerCase()),
    pollSeconds: clampNumber(asFiniteNumber(mirror.pollSeconds) ?? DEFAULT_POLL_SECONDS, 10, 3_600),
    activeWindowMinutes: clampNumber(
      asFiniteNumber(mirror.activeWindowMinutes) ?? DEFAULT_ACTIVE_WINDOW_MINUTES,
      1,
      10_080,
    ),
  };
}

export function beamMirrorId(catalogId: string, hostId: string, threadId: string): string {
  return createHash("sha256")
    .update(`${catalogId}\0${hostId}\0${threadId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Reduce newest-first catalog items to chronological Beam uploads. Only user/agent
 * message text crosses the wire; reasoning, tool calls, tool results, and raw
 * payloads collapse into compact counts.
 */
function buildBeamMirrorItems(items: readonly CatalogExportItem[]) {
  const out: BeamCleanCandidate["items"] = [];
  const dropped = new Map<string, number>();
  const truncated = items.some((item) => item.truncated);
  const flush = () => {
    if (dropped.size > 0) {
      const counts = [...dropped].map(([kind, count]) => `${count} ${kind}`).join(", ");
      out.push({ type: "other", text: `${counts}; raw content dropped` });
      dropped.clear();
    }
  };
  const labels: Partial<Record<CatalogExportItem["type"], string>> = {
    toolCall: "tool calls",
    toolResult: "tool results",
    reasoning: "reasoning items",
  };
  for (const item of items.toReversed()) {
    const text = item.text?.trim();
    if ((item.type === "userMessage" || item.type === "agentMessage") && text) {
      flush();
      out.push({ type: item.type, text, ...(item.speakerId ? { speakerId: item.speakerId } : {}) });
      continue;
    }
    const label = labels[item.type] ?? "other entries";
    dropped.set(label, (dropped.get(label) ?? 0) + 1);
  }
  flush();
  return { items: out, truncated };
}

type BeamMirrorCandidate = SessionCatalogLocator & {
  agentId: string;
  beamId: string;
  modelProvider?: string;
  title: string;
  recencyAt: number;
};

function sourceModelForMirror(
  providerValue: string | undefined,
  items: readonly CatalogExportItem[],
): BeamSourceModel | undefined {
  const provider = providerValue?.trim().toLowerCase();
  const rawModel = items.find((item) => item.type === "agentMessage" && item.model?.trim())?.model;
  if (!provider || !/^[a-z0-9._-]+$/i.test(provider) || !rawModel) {
    return undefined;
  }
  const prefixed = rawModel.trim();
  const model = truncateUtf16Safe(
    prefixed.startsWith(`${provider}/`) ? prefixed.slice(provider.length + 1) : prefixed,
    256,
  ).trim();
  return model && /^\S+$/u.test(model) ? { provider, model } : undefined;
}

function mirrorCandidateKey(candidate: BeamMirrorCandidate): string {
  return JSON.stringify([
    candidate.catalogId,
    candidate.hostId,
    candidate.threadId,
    candidate.agentId,
    candidate.sourceHomeId ?? null,
  ]);
}

type TrackedMirrorSession = {
  candidate: BeamMirrorCandidate;
  fingerprint: string;
  expiresAt: number;
  retired?: true;
};

export function createBeamMirrorRunner(params: {
  catalogExports: PluginServiceCatalogExports;
  resolveExecutable: () => Promise<string>;
  cleanCandidate?: typeof cleanBeamCandidate;
  getPublicationStore?: (
    authority: PluginStateActionAuthority,
  ) => Pick<
    PluginStateKeyedStore<MirrorPublicationStoreValue, 2>,
    "observe" | "compareAndApply" | "registerIfAbsent"
  >;
  runtime: { config: Pick<PluginRuntime["config"], "current"> };
  logger: { warn: (message: string) => void; info: (message: string) => void };
  now?: () => number;
  signal: AbortSignal;
}) {
  const now = params.now ?? Date.now;
  const tracked = new Map<string, TrackedMirrorSession>();
  const { signal } = params;
  let lastWarnAt = 0;
  let warnedProcessHomeIsolation = false;
  let endpoint = "";
  let redirectBlocked = false;
  const stopError = new Error("Beam mirror stopped");

  // Catalog work cannot be cancelled, so detach its late result after stop.
  // Guarded transport cleanup remains joined to the active scan in upload().
  const raceCatalog = <T>(operation: Promise<T>): Promise<T> =>
    racePromiseWithAbortSignal(operation, signal, () => stopError);

  // Retry state keeps a bounded sender-owned superset until the receiver's TTL.
  // The extra capacity prevents independent clocks from dropping a live row.
  const trackSuccessfulUpload = (
    key: string,
    candidate: BeamMirrorCandidate,
    fingerprint: string,
    retired = false,
  ) => {
    tracked.delete(key);
    tracked.set(key, {
      candidate,
      fingerprint,
      expiresAt: now() + BEAM_RETENTION_MS,
      ...(retired ? { retired: true } : {}),
    });
    // At capacity, retry order is best effort; retain the just-acknowledged upload.
    pruneMapToMaxSize(tracked, MIRROR_RETRY_CAP);
  };

  const warnThrottled = (message: string) => {
    if (now() - lastWarnAt >= MIRROR_WARN_INTERVAL_MS) {
      lastWarnAt = now();
      params.logger.warn(message);
    }
  };

  const upload = async (
    payload: BeamUpload,
    candidate: BeamMirrorCandidate,
    catalog: PluginServiceExportCatalog,
  ): Promise<boolean | "retired"> => {
    if (signal.aborted || redirectBlocked) {
      return false;
    }
    // Check consent again at dispatch; a pending read may have outlived its agent
    // or catalog selection even when the receiver and credential still match.
    const config = params.runtime.config.current();
    const current = parseBeamMirrorConfig(config);
    if (
      !current ||
      typeof current === "string" ||
      current.token === null ||
      current.endpoint !== endpoint ||
      !current.catalogs.includes(candidate.catalogId) ||
      resolveSessionAgentIdsStrict({ config: config as OpenClawConfig }).defaultAgentId !==
        candidate.agentId
    ) {
      return false;
    }
    catalog.assertCurrent(candidate);
    const token = current.token;

    let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
    try {
      guarded = await fetchWithSsrFGuard({
        url: endpoint,
        timeoutMs: MIRROR_UPLOAD_TIMEOUT_MS,
        signal,
        policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(endpoint),
        auditContext: "beam.mirror_upload",
        // Only the configured receiver can acknowledge delivery. Following a redirect
        // could fingerprint a payload that the receiver never accepted.
        maxRedirects: 0,
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
        },
      });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof GuardedFetchRedirectError) {
        // Repeating the same poll cannot satisfy direct-only delivery. Hold this exact
        // endpoint for this service instance; a fresh instance probes once so a receiver
        // fixed in place can recover without a meaningless config change.
        redirectBlocked = true;
        params.logger.warn(
          `beam mirror upload blocked for ${payload.source}: receiver returned redirect (${error.status}); redirects are not followed; configure the final endpoint`,
        );
        return false;
      }
      throw error;
    }

    const { response, release } = guarded;
    try {
      signal.throwIfAborted();
      if (response.status === 409) {
        const receipt: unknown = JSON.parse(
          (
            await readResponseWithLimit(response, 4096, {
              signal,
              timeoutMs: MIRROR_UPLOAD_TIMEOUT_MS,
            })
          ).toString("utf8"),
        );
        if (
          isRecord(receipt) &&
          receipt.beamId === payload.beamId &&
          isRecord(receipt.handoff) &&
          receipt.handoff.owner === "gateway" &&
          typeof receipt.handoff.id === "string" &&
          /^[a-f0-9]{32}$/.test(receipt.handoff.id)
        ) {
          params.logger.info(
            "Beam source retired at the receiver; continue its logical conversation in Team.",
          );
          return "retired";
        }
      }
      if (!response.ok) {
        warnThrottled(`beam mirror upload failed (${response.status}) for ${payload.source}`);
      }
      return response.ok;
    } finally {
      // The mirror uses only the status; cancel the ignored payload so slow
      // receiver responses cannot retain connection slots across poll retries.
      await response.body?.cancel().catch(() => undefined);
      await release();
    }
  };

  const buildUpload = async (
    catalog: PluginServiceExportCatalog,
    candidate: BeamMirrorCandidate,
    completed: boolean,
    sourceSalt: string,
  ) => {
    const items: CatalogExportItem[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let used = 0;
    let byteLimit = false;
    for (let page = 0; page < BEAM_MAX_ITEMS / MIRROR_READ_LIMIT; page++) {
      const transcript = await raceCatalog(
        catalog.read({
          agentId: candidate.agentId,
          sourceHomeId: candidate.sourceHomeId,
          hostId: candidate.hostId,
          threadId: candidate.threadId,
          limit: MIRROR_READ_LIMIT,
          ...(cursor ? { cursor } : {}),
        }),
      );
      signal.throwIfAborted();
      if (transcript.hostId !== candidate.hostId || transcript.threadId !== candidate.threadId) {
        throw new Error("catalog returned a different source");
      }
      for (const item of transcript.items) {
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (used + bytes > 3 * 1024 * 1024 || items.length === BEAM_MAX_ITEMS) {
          byteLimit = true;
          break;
        }
        used += bytes;
        items.push(item);
      }
      cursor = transcript.nextCursor;
      if (byteLimit || !cursor || items.length >= BEAM_MAX_ITEMS) break;
      if (seen.has(cursor)) throw new Error("catalog returned a repeated history cursor");
      seen.add(cursor);
    }
    const reduced = buildBeamMirrorItems(items);
    const sourceModel = sourceModelForMirror(candidate.modelProvider, items);
    const cleaned = await (params.cleanCandidate ?? cleanBeamCandidate)(
      {
        source: candidate.catalogId,
        origin: {
          adapter: "openclaw-mirror",
          sourceHome: sourceSalt,
          nativeSession: candidate.threadId,
        },
        title: candidate.title,
        updatedAt: new Date(candidate.recencyAt || now()).toISOString(),
        completed,
        ...(sourceModel ? { sourceModel } : {}),
        completeness: byteLimit || reduced.truncated || cursor ? "partial" : "complete",
        items: reduced.items.length
          ? reduced.items
          : [{ type: "other", text: "no shareable messages yet" }],
      },
      signal,
      params.resolveExecutable,
    );
    catalog.assertCurrent(candidate);
    return cleaned;
  };

  async function deliver(
    catalog: PluginServiceExportCatalog,
    candidate: BeamMirrorCandidate,
    completed: boolean,
    oldFingerprint?: string,
  ) {
    const config = parseBeamMirrorConfig(params.runtime.config.current());
    if (
      !config ||
      typeof config === "string" ||
      config.endpoint !== endpoint ||
      config.token === null
    )
      return;
    const assertCurrent = () => {
      signal.throwIfAborted();
      catalog.assertCurrent(candidate);
      const latest = parseBeamMirrorConfig(params.runtime.config.current());
      if (
        !latest ||
        typeof latest === "string" ||
        latest.endpoint !== endpoint ||
        latest.token !== config.token ||
        !latest.catalogs.includes(candidate.catalogId)
      ) {
        throw new Error("Beam mirror selection or receiver changed during export");
      }
    };
    let binding: Awaited<ReturnType<typeof openBeamMirrorEnrollment>>;
    if (config.apiV2) {
      if (!candidate.sourceHomeId || !params.getPublicationStore) return;
      binding = await openBeamMirrorEnrollment({
        store: params.getPublicationStore({ assertCurrent }),
        endpoint,
        token: config.token,
        source: { ...candidate, sourceHomeId: candidate.sourceHomeId },
        signal,
        assertCurrent,
      });
      if (!binding?.active || binding.fenced) {
        if (binding?.fenced) return { fingerprint: "", retired: true };
        warnThrottled("beam mirror source is waiting for an explicit beam.mirror.enroll operation");
        return;
      }
    }
    const cleaned = await buildUpload(
      catalog,
      candidate,
      completed,
      binding?.sourceSalt ?? mirrorCandidateKey(candidate),
    );
    assertCurrent();
    const { packet } = cleaned;
    // The v1 receiver accepts only its historical ID and role/text fields. All
    // visible bytes have already passed through the same native sanitizer as v2.
    const legacy: BeamUpload = {
      ...packet,
      version: 1,
      beamId: candidate.beamId,
      items: packet.items.map(({ type, text }) => ({ type, text })),
    };
    const fingerprint = mirrorFingerprint(legacy);
    if (!binding && oldFingerprint === fingerprint) return;
    const acknowledged = binding
      ? await binding.publish(packet.beamId, cleaned.raw)
      : await upload(legacy, candidate, catalog);
    return acknowledged ? { fingerprint, retired: acknowledged === "retired" } : undefined;
  }

  const mirrorFingerprint = ({ updatedAt: _updatedAt, ...content }: BeamUpload): string =>
    createHash("sha256").update(JSON.stringify(content)).digest("hex");

  const scan = async (): Promise<void> => {
    try {
      signal.throwIfAborted();
      const config = params.runtime.config.current();
      const mirror = parseBeamMirrorConfig(config);
      if (mirror === undefined) {
        return;
      }
      if (typeof mirror === "string") {
        warnThrottled(`beam mirror disabled: ${mirror}`);
        return;
      }
      if (endpoint !== mirror.endpoint) {
        // Acknowledgements, terminal retries, and redirect blocks belong to one receiver.
        endpoint = mirror.endpoint;
        tracked.clear();
        redirectBlocked = false;
      }
      let agentId: string;
      try {
        agentId = resolveSessionAgentIdsStrict({ config: config as OpenClawConfig }).defaultAgentId;
      } catch (error) {
        warnThrottled(`beam mirror disabled: ${String(error)}`);
        return;
      }
      if (mirror.token === null) {
        warnThrottled(
          `beam mirror paused: ${MIRROR_TOKEN_PATH} credential unavailable; restore it and run openclaw secrets reload`,
        );
        return;
      }
      const activeSinceMs = now() - mirror.activeWindowMinutes * 60_000;
      const catalogs = params.catalogExports.listCatalogs().filter(
        (catalog) =>
          // Never mirror the local beam receiver back out: a two-gateway pair
          // would otherwise re-mirror each other's rows forever.
          catalog.id !== "beam" && mirror.catalogs.includes(catalog.id),
      );
      if (
        !warnedProcessHomeIsolation &&
        catalogs.some((catalog) => !catalog.processHomeFallbackAllowed)
      ) {
        warnedProcessHomeIsolation = true;
        params.logger.warn(
          "beam mirror process-HOME fallback disabled: isolated state; only explicit catalog roots can be mirrored",
        );
      }
      const catalogById = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
      const observed = new Map<string, BeamMirrorCandidate>();
      const observedOrigins = new Map(
        Array.from(tracked, ([key, entry]) => [entry.candidate.beamId, key] as const),
      );
      const fenced = new Set<string>();
      const fullyObservedHosts = new Set<string>();
      for (const catalog of catalogs) {
        signal.throwIfAborted();
        try {
          const hosts = await raceCatalog(
            catalog.list({ agentId, limitPerHost: MIRROR_LIST_LIMIT }),
          );
          signal.throwIfAborted();
          for (const host of hosts) {
            // Remote machines and failed local scans are not authoritative observations.
            if (host.kind !== "gateway" || !host.connected || host.error) {
              continue;
            }
            if (host.nextCursor === undefined) {
              fullyObservedHosts.add(`${catalog.id}\0${host.hostId}`);
            }
            for (const session of host.sessions) {
              const legacyId = beamMirrorId(catalog.id, host.hostId, session.threadId);
              const candidate = {
                agentId,
                beamId: legacyId,
                catalogId: catalog.id,
                ...(session.sourceHomeId !== undefined
                  ? { sourceHomeId: session.sourceHomeId }
                  : {}),
                hostId: host.hostId,
                modelProvider: session.modelProvider,
                threadId: session.threadId,
                title: session.name?.trim() || `${catalog.id} session`,
                recencyAt: session.recencyAt ?? session.updatedAt ?? 0,
              };
              const key = mirrorCandidateKey(candidate);
              const earlier = observedOrigins.get(legacyId);
              observedOrigins.set(legacyId, key);
              if (
                session.exportPolicy?.origin !== "native-local" ||
                !session.exportPolicy.automatic ||
                (mirror.apiV2
                  ? !candidate.sourceHomeId
                  : !session.exportPolicy.stableHostThreadIdentity) ||
                (earlier !== undefined && earlier !== key)
              ) {
                // An old ID may already name a released conversation. Never mint a
                // second ID or write through a selection the producer cannot identify.
                fenced.add(legacyId);
                continue;
              }
              observed.set(key, candidate);
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          warnThrottled(`beam mirror list failed for ${catalog.id}: ${String(error)}`);
        }
      }
      if (fenced.size > 0) {
        warnThrottled(
          "beam mirror skipped sources without an unambiguous automatic export grant; select the source explicitly to create a separate copy",
        );
      }
      const selected = [...observed.values()]
        .filter(
          (candidate) => candidate.recencyAt >= activeSinceMs && !fenced.has(candidate.beamId),
        )
        .toSorted((left, right) => right.recencyAt - left.recencyAt)
        .slice(0, MIRROR_MAX_SESSIONS);
      for (const candidate of selected) {
        signal.throwIfAborted();
        const key = mirrorCandidateKey(candidate);
        const trackedSource = tracked.get(key);
        if (trackedSource?.retired && trackedSource.expiresAt > now()) {
          continue;
        }
        const catalog = catalogById.get(candidate.catalogId);
        if (!catalog) {
          continue;
        }
        try {
          const result = await deliver(catalog, candidate, false, trackedSource?.fingerprint);
          signal.throwIfAborted();
          if (result) trackSuccessfulUpload(key, candidate, result.fingerprint, result.retired);
        } catch (error) {
          signal.throwIfAborted();
          warnThrottled(`beam mirror upload failed for ${candidate.catalogId}: ${String(error)}`);
        }
      }
      // Sessions that left the active window get one final completed upload so
      // remote rows flip from live to completed instead of lingering until TTL.
      const tickNow = now();
      const terminalEntries: Array<[string, TrackedMirrorSession]> = [];
      for (const [key, entry] of tracked) {
        signal.throwIfAborted();
        if (
          fenced.has(entry.candidate.beamId) ||
          entry.candidate.agentId !== agentId ||
          !mirror.catalogs.includes(entry.candidate.catalogId)
        ) {
          tracked.delete(key);
          continue;
        }
        if (entry.retired) {
          if (entry.expiresAt <= tickNow) {
            tracked.delete(key);
          }
          continue;
        }
        const candidate = observed.get(key);
        // A listed idle row is conclusive even on a partial page. Only an absent
        // row requires a complete scan, so active overflow never becomes terminal.
        const confirmedInactive = candidate
          ? candidate.recencyAt < activeSinceMs
          : fullyObservedHosts.has(`${entry.candidate.catalogId}\0${entry.candidate.hostId}`);
        if (!confirmedInactive) {
          continue;
        }
        // A terminal retry cannot update a receiver row after this shared deadline.
        if (entry.expiresAt <= tickNow) {
          tracked.delete(key);
        } else if (terminalEntries.length < MIRROR_MAX_SESSIONS) {
          terminalEntries.push([key, candidate ? { ...entry, candidate } : entry]);
        }
      }
      for (const [key, entry] of terminalEntries) {
        signal.throwIfAborted();
        let uploaded = false;
        const catalog = catalogById.get(entry.candidate.catalogId);
        if (catalog) {
          try {
            // Unlisted rows cannot donate a stale grant. Re-select this exact
            // source before a terminal read, including after a partial retry.
            const hosts = await raceCatalog(
              catalog.list({
                agentId: entry.candidate.agentId,
                threadId: entry.candidate.threadId,
                limitPerHost: MIRROR_LIST_LIMIT,
              }),
            );
            if (
              hosts.some(
                (host) =>
                  host.hostId === entry.candidate.hostId &&
                  host.sessions.some(
                    (session) =>
                      session.threadId === entry.candidate.threadId &&
                      session.sourceHomeId === entry.candidate.sourceHomeId &&
                      session.exportPolicy?.origin === "native-local" &&
                      session.exportPolicy.automatic &&
                      (mirror.apiV2 || session.exportPolicy.stableHostThreadIdentity),
                  ),
              )
            ) {
              uploaded = Boolean(await deliver(catalog, entry.candidate, true));
            }
            signal.throwIfAborted();
          } catch {
            signal.throwIfAborted();
          }
        }
        tracked.delete(key);
        if (!uploaded) {
          // Move failed work behind later entries so one broken session cannot starve them.
          tracked.set(key, entry);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  };

  const enroll = async (
    source: BeamMirrorEnrollment,
    authority: { assertCurrent(): void; revalidate(): Promise<void> },
    confirmGeneration?: string,
  ) => {
    const config = parseBeamMirrorConfig(params.runtime.config.current());
    if (
      !config ||
      typeof config === "string" ||
      !config.apiV2 ||
      !params.getPublicationStore ||
      config.token === null ||
      !config.catalogs.includes(source.catalogId)
    ) {
      throw new Error(
        "Configure the v2 Beam mirror endpoint and allow this catalog before enrolling",
      );
    }
    await authority.revalidate();
    const catalog = params.catalogExports
      .listCatalogs()
      .find((entry) => entry.id === source.catalogId);
    if (!catalog) throw new Error("The source catalog is unavailable for local export");
    const hosts = await raceCatalog(
      catalog.list({ agentId: source.agentId, limitPerHost: 100, threadId: source.threadId }),
    );
    const row = hosts
      .find((host) => host.hostId === source.hostId)
      ?.sessions.find(
        (entry) => entry.threadId === source.threadId && entry.sourceHomeId === source.sourceHomeId,
      );
    if (!row || row.exportPolicy?.origin !== "native-local" || !row.exportPolicy.automatic)
      throw new Error("Select a listed native source with its exact owner and home");
    const assertCurrent = () => {
      authority.assertCurrent();
      signal.throwIfAborted();
      catalog.assertCurrent(source);
      const next = parseBeamMirrorConfig(params.runtime.config.current());
      if (
        !next ||
        typeof next === "string" ||
        next.endpoint !== config.endpoint ||
        next.token !== config.token ||
        !next.catalogs.includes(source.catalogId)
      ) {
        throw new Error("Beam mirror receiver authorization changed");
      }
    };
    const candidate = {
      ...source,
      beamId: beamMirrorId(source.catalogId, source.hostId, source.threadId),
      title: row.name?.trim() || `${source.catalogId} session`,
      recencyAt: row.recencyAt ?? row.updatedAt ?? now(),
      modelProvider: row.modelProvider,
    };
    const binding = await openBeamMirrorEnrollment({
      store: params.getPublicationStore({ assertCurrent }),
      endpoint: config.endpoint,
      token: config.token,
      source,
      signal,
      assertCurrent,
      explicit: true,
    });
    if (!binding) throw new Error("Beam enrollment unavailable");
    if (binding.active || binding.fenced) return binding.describe();
    const cleaned = await buildUpload(catalog, candidate, false, binding.sourceSalt);
    await authority.revalidate();
    return binding.enroll(cleaned.packet.beamId, cleaned.raw, confirmGeneration);
  };
  return { tick: scan, enroll };
}

export function createBeamMirrorService(params: {
  runtime: PluginRuntime;
  resolveExecutable: () => Promise<string>;
  onRunner?: (runner: ReturnType<typeof createBeamMirrorRunner> | undefined) => void;
}): OpenClawPluginServiceV2 {
  return {
    id: "beam-mirror",
    apiVersion: 2,
    catalogExports: { allowlistPath: ["mirror", "catalogs"] },
    reload: { configPrefixes: [MIRROR_CONFIG_PATH] },
    start(ctx) {
      const mirror = parseBeamMirrorConfig(params.runtime.config.current());
      if (mirror === undefined) {
        return;
      }
      if (typeof mirror === "string") {
        ctx.logger.warn(`beam mirror disabled: ${mirror}`);
        return;
      }
      if (!ctx.catalogExports) {
        ctx.logger.warn(
          "beam mirror disabled: this Gateway does not provide background catalog export",
        );
        return;
      }
      const active = createBeamMirrorRunner({
        catalogExports: ctx.catalogExports,
        resolveExecutable: params.resolveExecutable,
        // Bind each read and commit to the selected source and current caller.
        // A module-scoped handle survives an operator disconnect or catalog removal.
        getPublicationStore: (authority) =>
          params.runtime.state.openKeyedStoreV2<MirrorPublicationStoreValue>(
            { namespace: "mirror-publications", retention: "retained" },
            authority,
          ),
        runtime: params.runtime,
        logger: ctx.logger,
        signal: ctx.scheduler.signal,
      });
      params.onRunner?.(active);
      ctx.scheduler.signal.addEventListener("abort", () => params.onRunner?.(undefined), {
        once: true,
      });
      ctx.scheduler.schedule({
        id: "mirror",
        delayMs: 0,
        everyMs: mirror.pollSeconds * 1_000,
        run: () => active.tick(),
      });
      if (mirror.token === null) {
        ctx.logger.warn(
          `beam mirror paused: ${MIRROR_TOKEN_PATH} credential unavailable; restore it and run openclaw secrets reload`,
        );
      } else {
        ctx.logger.info(
          `beam mirror active: ${mirror.catalogs.join(", ")} -> ${new URL(mirror.endpoint).origin}`,
        );
      }
    },
  };
}

export function registerBeamMirror(
  api: OpenClawPluginApi,
  resolveExecutable: () => Promise<string>,
) {
  let active: ReturnType<typeof createBeamMirrorRunner> | undefined;
  api.registerService(
    createBeamMirrorService({
      runtime: api.runtime,
      resolveExecutable,
      onRunner: (runner) => {
        active = runner;
      },
    }),
  );
  api.registerGatewayMethod(
    "beam.mirror.enroll",
    async ({ params, respond, assertHandlerCurrent }) => {
      const authority = getGatewayRequestAuthorityV1();
      if (!authority?.scopes.includes("operator.admin") || !active) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "Enable the Beam v2 mirror and connect as an administrator to enroll a source",
        });
        return;
      }
      const fields = ["catalogId", "hostId", "threadId", "agentId", "sourceHomeId"] as const;
      if (
        !isRecord(params) ||
        !isRecord(params.source) ||
        Object.keys(params).some((key) => key !== "source" && key !== "confirmGeneration")
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Supply the exact source catalog, host, thread, agent and source home",
        });
        return;
      }
      const source = params.source;
      if (
        Object.keys(source).length !== fields.length ||
        !fields.every(
          (f) => typeof source[f] === "string" && source[f].length > 0 && source[f].length <= 500,
        ) ||
        (params.confirmGeneration !== undefined &&
          (typeof params.confirmGeneration !== "string" ||
            !params.confirmGeneration ||
            params.confirmGeneration.length > 256))
      ) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "Invalid Beam source locator or confirmed generation",
        });
        return;
      }
      try {
        const result = await active.enroll(
          source as BeamMirrorEnrollment,
          {
            revalidate: () => authority.revalidate(),
            assertCurrent() {
              assertHandlerCurrent?.();
              authority.assertCurrent();
            },
          },
          params.confirmGeneration as string | undefined,
        );
        await authority.revalidate();
        authority.assertCurrent();
        respond(true, result);
      } catch {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message:
            "Beam enrollment did not complete. Verify the selected local source, original receiver, publisher credential and any pending generation before retrying.",
        });
      }
    },
    { scope: "operator.admin" },
  );
}
