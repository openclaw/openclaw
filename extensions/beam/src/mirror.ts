import { createHash, createHmac } from "node:crypto";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateActionAuthority } from "openclaw/plugin-sdk/plugin-state-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import type {
  CatalogExportItem,
  PluginServiceCatalogExports,
  PluginServiceExportCatalog,
} from "openclaw/plugin-sdk/session-catalog";
import {
  fetchWithSsrFGuard,
  GuardedFetchRedirectError,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { cleanBeamCandidate, type BeamCleanCandidate } from "./cleaner.js";
import {
  beamMirrorId,
  buildBeamMirrorItems,
  mirrorCandidateKey,
  sourceModelForMirror,
  type BeamMirrorCandidate,
} from "./mirror-candidate.js";
import { MIRROR_TOKEN_PATH, parseBeamMirrorConfig } from "./mirror-config.js";
import { openBeamMirrorEnrollment, type BeamMirrorEnrollment } from "./mirror-publication.js";
import {
  MIRROR_LIST_LIMIT,
  scheduleBeamEnrollments,
  selectBeamEnrollment,
  type BeamPublicationStore,
  type BeamScheduleStore,
} from "./mirror-schedule.js";
import type { BeamMirrorV2Head } from "./mirror-v2.js";
import { BEAM_MAX_ITEMS, BEAM_MAX_SESSIONS, BEAM_RETENTION_MS, type BeamUpload } from "./types.js";

// Strictest transcript-read cap across catalog providers (the Claude Code
// provider rejects limits above 50); asking for more fails the whole read.
const MIRROR_READ_LIMIT = 50;
// Active work and terminal work have separate per-tick budgets. V1 selects
// recent sources; v2 rotates existing enrollments across durable checkpoints.
const MIRROR_MAX_SESSIONS = 32;
// Keeping twice the receiver capacity prevents independent clocks and foreign
// writers from making the sender under-retain retry ownership.
const MIRROR_RETRY_CAP = 2 * BEAM_MAX_SESSIONS;
// One warning per source per interval keeps a broken endpoint from flooding logs.
const MIRROR_WARN_INTERVAL_MS = 5 * 60_000;
const MIRROR_UPLOAD_TIMEOUT_MS = 15_000;

function resolveMirrorAgentId(config: ReturnType<PluginRuntime["config"]["current"]>): string {
  // Selection only reads the live snapshot. Both discovery and dispatch must resolve the same owner.
  return resolveSessionAgentIdsStrict({ config: config as OpenClawConfig }).defaultAgentId;
}

type Acknowledgment = {
  credential: string;
  inputDigest: string;
  receipt: string | BeamMirrorV2Head;
};
type Delivery =
  | { acknowledged: Acknowledgment; retired?: never }
  | { retired: true; acknowledged?: never };
type TrackedMirrorSession = Delivery & {
  candidate: BeamMirrorCandidate;
  expiresAt: number;
};

export function createBeamMirrorRunner(params: {
  catalogExports: PluginServiceCatalogExports;
  resolveExecutable: () => Promise<string>;
  getPublicationStore?: (authority: PluginStateActionAuthority) => BeamPublicationStore;
  getScheduleStore?: (authority: PluginStateActionAuthority) => BeamScheduleStore;
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
    delivery: Delivery,
  ) => {
    tracked.delete(key);
    tracked.set(key, {
      candidate,
      ...delivery,
      expiresAt: now() + BEAM_RETENTION_MS,
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
      resolveMirrorAgentId(config) !== candidate.agentId
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

  const buildCleanerInput = async (
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
      if (byteLimit || !cursor || items.length >= BEAM_MAX_ITEMS) {
        break;
      }
      if (seen.has(cursor)) {
        throw new Error("catalog returned a repeated history cursor");
      }
      seen.add(cursor);
    }
    const reduced = buildBeamMirrorItems(items);
    const sourceModel = sourceModelForMirror(candidate.modelProvider, items);
    catalog.assertCurrent(candidate);
    return JSON.stringify({
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
    } satisfies BeamCleanCandidate);
  };

  async function deliver(
    catalog: PluginServiceExportCatalog,
    candidate: BeamMirrorCandidate,
    completed: boolean,
    previous?: Acknowledgment,
  ): Promise<Delivery | undefined> {
    const config = parseBeamMirrorConfig(params.runtime.config.current());
    if (
      !config ||
      typeof config === "string" ||
      config.endpoint !== endpoint ||
      config.token === null
    ) {
      return undefined;
    }
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
      if (!candidate.sourceHomeId || !params.getPublicationStore) {
        return undefined;
      }
      binding = await openBeamMirrorEnrollment({
        store: params.getPublicationStore({ assertCurrent }),
        endpoint,
        token: config.token,
        source: { ...candidate, sourceHomeId: candidate.sourceHomeId },
        signal,
        assertCurrent,
      });
      if (!binding?.active || binding.fenced) {
        if (binding?.fenced) {
          return { retired: true };
        }
        warnThrottled("beam mirror source is waiting for an explicit beam.mirror.enroll operation");
        return undefined;
      }
    }
    const input = await buildCleanerInput(
      catalog,
      candidate,
      completed,
      binding?.sourceSalt ?? mirrorCandidateKey(candidate),
    );
    assertCurrent();
    // Only an acknowledged input from this runner and credential can be reused.
    // Never trust catalog timestamps: two edits can share one native timestamp.
    const credential = createHmac("sha256", config.token ?? "")
      .update(mirrorCandidateKey(candidate))
      .digest("hex");
    const inputDigest = createHash("sha256").update(input).digest("hex");
    const match =
      previous?.credential === credential && previous.inputDigest === inputDigest
        ? previous
        : undefined;
    if (binding) {
      const next = await binding.afterSourceRead(
        typeof match?.receipt === "object" ? match.receipt : undefined,
      );
      if (next === "retired") {
        return { retired: true };
      }
      if (next === "defer") {
        return undefined;
      }
      if (next === "acknowledged" && match) {
        return { acknowledged: match };
      }
    } else if (typeof match?.receipt === "string") {
      return undefined;
    }
    const cleaned = await cleanBeamCandidate(input, signal, params.resolveExecutable);
    assertCurrent();
    const { packet } = cleaned;
    if (binding) {
      const receipt = await binding.publish(packet.beamId, cleaned.raw, packet.completed);
      if (receipt === "retired") {
        return { retired: true };
      }
      return receipt ? { acknowledged: { credential, inputDigest, receipt } } : undefined;
    }
    // The v1 receiver accepts only its historical ID and role/text fields. All
    // visible bytes have already passed through the same native sanitizer as v2.
    const legacy: BeamUpload = {
      ...packet,
      version: 1,
      beamId: candidate.beamId,
      items: packet.items.map(({ type, text }) => ({ type, text })),
    };
    const fingerprint = mirrorFingerprint(legacy);
    if (previous?.receipt === fingerprint) {
      // This credential's earlier v1 upload covers the same sanitized content.
      // Remember this input without extending the receiver's actual acknowledgement TTL.
      if (previous.credential === credential) {
        previous.inputDigest = inputDigest;
      }
      return undefined;
    }
    const result = await upload(legacy, candidate, catalog);
    if (result === "retired") {
      return { retired: true };
    }
    return result ? { acknowledged: { credential, inputDigest, receipt: fingerprint } } : undefined;
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
        agentId = resolveMirrorAgentId(config);
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
      if (mirror.apiV2) {
        if (!params.getPublicationStore || !params.getScheduleStore || !catalogs.length) {
          return;
        }
        const assertCurrent = () => {
          signal.throwIfAborted();
          if (params.runtime.config.current() !== config || enrolling) {
            throw new Error("Beam mirror service configuration or source selection changed");
          }
        };
        await raceCatalog(
          scheduleBeamEnrollments({
            agentId,
            endpoint,
            token: mirror.token,
            catalogs: catalogById,
            assertCurrent,
            getStore: params.getPublicationStore,
            schedule: params.getScheduleStore({ assertCurrent }),
            activeSinceMs,
            workLimit: MIRROR_MAX_SESSIONS,
            pageSize: MIRROR_LIST_LIMIT,
            warn: (reason) =>
              warnThrottled(
                reason === "credential"
                  ? "beam mirror publisher credential changed; repeat beam.mirror.enroll with the original source and confirmed generation"
                  : "beam mirror could not update an enrolled source; check its local visibility, receiver, and publisher authorization",
              ),
            async deliver(catalog, candidate, completed) {
              const key = mirrorCandidateKey(candidate);
              const result = await deliver(
                catalog,
                candidate,
                completed,
                tracked.get(key)?.acknowledged,
              );
              if (result) {
                trackSuccessfulUpload(key, candidate, result);
              }
            },
          }),
        );
        return;
      }
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
                !session.exportPolicy.stableHostThreadIdentity ||
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
          const result = await deliver(catalog, candidate, false, trackedSource?.acknowledged);
          signal.throwIfAborted();
          if (result) {
            trackSuccessfulUpload(key, candidate, result);
          }
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
                source: entry.candidate,
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
                      session.exportPolicy.stableHostThreadIdentity,
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
    if (!catalog) {
      throw new Error("The source catalog is unavailable for local export");
    }
    const candidate = await raceCatalog(selectBeamEnrollment(catalog, source));
    if (!candidate) {
      throw new Error("Select a listed native source with its exact owner and home");
    }
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
    const binding = await openBeamMirrorEnrollment({
      store: params.getPublicationStore({ assertCurrent }),
      endpoint: config.endpoint,
      token: config.token,
      source,
      signal,
      assertCurrent,
      explicit: true,
      confirmGeneration,
      revalidate: () => authority.revalidate(),
    });
    if (!binding) {
      throw new Error("Beam enrollment unavailable");
    }
    if (binding.active || binding.fenced) {
      return binding.describe();
    }
    const input = await buildCleanerInput(catalog, candidate, false, binding.sourceSalt);
    const cleaned = await cleanBeamCandidate(input, signal, params.resolveExecutable);
    catalog.assertCurrent(candidate);
    await authority.revalidate();
    return binding.enroll(cleaned.packet.beamId, cleaned.raw, confirmGeneration);
  };
  // Each catalog enumeration retires earlier grants. An operator enrollment may
  // supersede a poll, but a later timer must not revoke that same enrollment.
  let enrolling = false;
  return {
    async tick() {
      if (!enrolling) {
        await scan();
      }
    },
    async enroll(...args: Parameters<typeof enroll>) {
      if (enrolling) {
        throw new Error("A Beam source enrollment is in progress. Retry after it completes.");
      }
      enrolling = true;
      try {
        return await enroll(...args);
      } finally {
        enrolling = false;
      }
    },
  };
}
