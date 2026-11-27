import { createHash } from "node:crypto";
import type {
  PluginStateActionAuthority,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PluginServiceExportCatalog } from "openclaw/plugin-sdk/session-catalog";
import { beamMirrorId, type BeamMirrorCandidate } from "./mirror-candidate.js";
import {
  beamMirrorEnrollmentKey,
  canScheduleBeamPublication,
  type BeamMirrorEnrollment,
  type MirrorPublicationStoreValue,
} from "./mirror-publication.js";

export const MIRROR_LIST_LIMIT = 100;

export type BeamPublicationStore = Pick<
  PluginStateKeyedStore<MirrorPublicationStoreValue, 2>,
  "observe" | "compareAndApply" | "registerIfAbsent" | "entriesInKeyRange" | "lookupMany"
>;
export type BeamScheduleStore = Pick<
  PluginStateKeyedStore<string, 2>,
  "lookup" | "register" | "delete"
>;
type Scope = {
  agentId: string;
  endpoint: string;
  token?: string;
  catalogs: Map<string, PluginServiceExportCatalog>;
  getStore: (authority: PluginStateActionAuthority) => BeamPublicationStore;
  schedule: BeamScheduleStore;
  assertCurrent(): void;
  warn(reason: "source" | "credential"): void;
};
type HostPage = Awaited<ReturnType<PluginServiceExportCatalog["list"]>>[number];
function eligible(host: HostPage, row: HostPage["sessions"][number]) {
  return (
    host.kind === "gateway" &&
    host.connected &&
    !host.error &&
    row.exportPolicy?.origin === "native-local" &&
    row.exportPolicy.automatic
  );
}

function candidateFromPage(
  hosts: HostPage[],
  source: BeamMirrorEnrollment,
): BeamMirrorCandidate | undefined {
  const host = hosts.find((entry) => entry.hostId === source.hostId);
  const row = host?.sessions.find(
    (entry) => entry.threadId === source.threadId && entry.sourceHomeId === source.sourceHomeId,
  );
  if (!host || !row || !eligible(host, row)) {
    return undefined;
  }
  return {
    ...source,
    beamId: beamMirrorId(source.catalogId, source.hostId, source.threadId),
    title: row.name?.trim() || `${source.catalogId} session`,
    recencyAt: row.recencyAt ?? row.updatedAt ?? 0,
    modelProvider: row.modelProvider,
  };
}

export async function selectBeamEnrollment(
  catalog: PluginServiceExportCatalog,
  source: BeamMirrorEnrollment,
) {
  return candidateFromPage(
    await catalog.list({ agentId: source.agentId, limitPerHost: MIRROR_LIST_LIMIT, source }),
    source,
  );
}

function checkpointKey(scope: Scope, ...parts: string[]) {
  return createHash("sha256")
    .update(JSON.stringify([scope.endpoint, scope.agentId, ...parts]))
    .digest("hex");
}

async function checkpoint(scope: Scope, key: string, old: string | undefined, next?: string) {
  if (old === next) {
    return;
  }
  scope.assertCurrent();
  if (next === undefined) {
    await scope.schedule.delete(key);
  } else {
    await scope.schedule.register(key, next);
  }
}

// Older receipts have only a one-way source hash. Walk one producer/host page per
// migration tick. Only an eligible row that recreates an existing key can gain a locator.
async function recoverLegacyPage(scope: Scope, store: BeamPublicationStore, pageSize: number) {
  const ids = [...scope.catalogs.keys()].toSorted();
  const catalogKey = checkpointKey(scope, "catalog");
  const last = await scope.schedule.lookup(catalogKey);
  const id = ids.find((item) => !last || item > last) ?? ids[0];
  const catalog = id && scope.catalogs.get(id);
  if (!id || !catalog) {
    return;
  }
  const hostKey = checkpointKey(scope, "nextHost", id);
  const wanted = await scope.schedule.lookup(hostKey);
  const pageKey = (hostId: string) => checkpointKey(scope, "page", id, hostId);
  const cursor = wanted ? await scope.schedule.lookup(pageKey(wanted)) : undefined;
  try {
    const hosts = await catalog.list({
      agentId: scope.agentId,
      limitPerHost: pageSize,
      ...(wanted && cursor ? { cursors: { [wanted]: cursor } } : {}),
    });
    const local = hosts
      .filter((host) => host.kind === "gateway" && host.connected && !host.error)
      .toSorted((a, b) => (a.hostId < b.hostId ? -1 : Number(a.hostId > b.hostId)));
    const position = local.findIndex((entry) => entry.hostId === wanted);
    if (position < 0 && wanted && cursor) {
      // One failed host can be absent while its siblings are healthy. Retire that
      // host's failed checkpoint before rotating so its first page can recover.
      await checkpoint(scope, pageKey(wanted), cursor);
    }
    const index = Math.max(0, position);
    const host = local[index];
    if (!host) {
      await checkpoint(scope, hostKey, wanted);
      return;
    }
    const sources = host.sessions.slice(0, pageSize).flatMap((row) =>
      eligible(host, row) && row.sourceHomeId
        ? [
            {
              catalogId: id,
              agentId: scope.agentId,
              hostId: host.hostId,
              threadId: row.threadId,
              sourceHomeId: row.sourceHomeId,
            },
          ]
        : [],
    );
    const keys = sources.map((source) => beamMirrorEnrollmentKey(scope.endpoint, source));
    const found = await store.lookupMany(keys);
    for (const [i, source] of sources.entries()) {
      const result = found[i];
      if (
        !result?.ok ||
        !result.value ||
        result.value.source ||
        !canScheduleBeamPublication(result.value, scope.token)
      ) {
        continue;
      }
      const key = keys[i]!;
      const localStore = scope.getStore({
        assertCurrent() {
          scope.assertCurrent();
          catalog.assertCurrent(source);
        },
      });
      const observed = await localStore.observe(key);
      if (
        observed.value &&
        !observed.value.source &&
        canScheduleBeamPublication(observed.value, scope.token)
      ) {
        await localStore.compareAndApply(key, observed.comparison, {
          operation: "update",
          action: "set",
          value: { ...observed.value, source },
        });
      }
    }
    // Replace stalled, expired, or oversized provider cursors with a fresh first page.
    const previous =
      host.hostId === wanted ? cursor : await scope.schedule.lookup(pageKey(host.hostId));
    const next = host.nextCursor;
    await checkpoint(
      scope,
      pageKey(host.hostId),
      previous,
      next && next !== cursor && Buffer.byteLength(next) <= 4096 ? next : undefined,
    );
    await checkpoint(scope, hostKey, wanted, local[(index + 1) % local.length]?.hostId);
  } catch {
    scope.assertCurrent();
    if (wanted && cursor) {
      await checkpoint(scope, pageKey(wanted), cursor);
    }
    scope.warn("source");
  } finally {
    await checkpoint(scope, catalogKey, last, id);
  }
}

export async function scheduleBeamEnrollments(
  scope: Scope & {
    activeSinceMs: number;
    workLimit: number;
    pageSize: number;
    deliver(
      catalog: PluginServiceExportCatalog,
      candidate: BeamMirrorCandidate,
      completed: boolean,
    ): Promise<void>;
  },
) {
  const store = scope.getStore(scope);
  const key = checkpointKey(scope, "enrollments");
  const after = await scope.schedule.lookup(key);
  const limit = scope.workLimit * 2;
  // Fixed-length hex enrollment keys sort before their own appended zero.
  // The extra row determines whether the next tick must resume or wrap.
  const rows = await store.entriesInKeyRange({
    keyStartInclusive: after ? after + "0" : "0",
    keyEndExclusive: "g",
    limit: limit + 1,
  });
  type Work = {
    source: BeamMirrorEnrollment;
    row: MirrorPublicationStoreValue;
    candidate?: BeamMirrorCandidate;
  };
  const byCatalog = new Map<PluginServiceExportCatalog, Work[]>();
  const byKey = new Map<string, Work>();
  let legacy = false;
  for (const { key: sourceKey, value } of rows.slice(0, limit)) {
    if (!value.head || value.fenced) {
      continue;
    }
    const source = value.source;
    if (!source) {
      legacy ||= canScheduleBeamPublication(value, scope.token);
      continue;
    }
    const catalog = scope.catalogs.get(source.catalogId);
    if (
      !catalog ||
      source.agentId !== scope.agentId ||
      beamMirrorEnrollmentKey(scope.endpoint, source) !== sourceKey
    ) {
      continue;
    }
    if (!canScheduleBeamPublication(value, scope.token)) {
      scope.warn("credential");
      continue;
    }
    const work = { source, row: value };
    const group = byCatalog.get(catalog) ?? [];
    group.push(work);
    byCatalog.set(catalog, group);
    byKey.set(sourceKey, work);
  }
  // Dense enrollments share the first page's grant. A sparse source goes straight
  // to its native selector; absent rows always need their own exact selection.
  for (const [catalog, group] of byCatalog) {
    if (group.length > 1) {
      try {
        const page = await catalog.list({ agentId: scope.agentId, limitPerHost: scope.pageSize });
        for (const item of group) {
          item.candidate = candidateFromPage(page, item.source);
        }
      } catch {
        scope.assertCurrent();
        scope.warn("source");
      }
    }
  }
  const ready = new Set<Work>();
  let active = scope.workLimit,
    terminal = scope.workLimit,
    processed = 0;
  for (const { key: sourceKey } of rows.slice(0, limit)) {
    const work = byKey.get(sourceKey);
    if (work) {
      const candidate = work.candidate;
      const idle = candidate && candidate.recencyAt < scope.activeSinceMs;
      // Reserve both possible slots for a point lookup until its live timestamp
      // is known. Stop before the first unserved key so bursts stay fair on restart.
      if (!idle || !work.row.completed || work.row.pending) {
        if (((!candidate || !idle) && !active) || ((!candidate || idle) && !terminal)) {
          break;
        }
        if (!candidate || !idle) {
          active--;
        }
        if (!candidate || idle) {
          terminal--;
        }
        ready.add(work);
      }
    }
    processed++;
  }
  for (const [catalog, group] of byCatalog) {
    // Exact selection replaces this catalog's prior page grant. Finish all reads
    // from the shared listing before selecting even the first missing source.
    for (const work of group
      .filter((item) => ready.has(item))
      .toSorted(
        (a, b) =>
          Number(Boolean(b.candidate)) - Number(Boolean(a.candidate)) ||
          Number(Boolean(b.row.pending)) - Number(Boolean(a.row.pending)),
      )) {
      try {
        scope.assertCurrent();
        const candidate = work.candidate ?? (await selectBeamEnrollment(catalog, work.source));
        if (!candidate) {
          continue;
        }
        catalog.assertCurrent(work.source);
        const completed = candidate.recencyAt < scope.activeSinceMs;
        if (!completed || !work.row.completed || work.row.pending) {
          await scope.deliver(catalog, candidate, completed);
        }
      } catch {
        scope.assertCurrent();
        scope.warn("source");
      }
    }
  }
  await checkpoint(
    scope,
    key,
    after,
    processed < rows.length ? rows[processed - 1]?.key : undefined,
  );
  if (legacy) {
    await recoverLegacyPage(scope, store, scope.pageSize);
  }
}
