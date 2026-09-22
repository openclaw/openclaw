import type { OpenClawPluginApi, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginStateCompareIntent,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CrabboxOperatingSystem } from "./crabbox-worker-profile.js";
import {
  legacyLeaseSelector,
  LEGACY_WARM_LEASE_MAX_ENTRIES,
  projectCrabboxLegacyWarmLeases,
  WARM_IMAGE_MAX_ENTRIES,
} from "./crabbox-worker-warm-image-records.js";

export type CrabboxState = Pick<OpenClawPluginApi["runtime"]["state"], "openKeyedStore">;

type WorkerNodeRuntimeIdentity = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["nodeRuntimeIdentity"]
>;

export type WarmImageRecord = {
  checkpointId: string;
  kind: string;
  state: "pending" | "available";
  createdAtMs: number;
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  lastDemandAtMs: number | null;
  pinned?: { atMs: number };
  baseCommit?: string;
  /** Runtime content attested by successful preparation before this capture. */
  runtimeIdentity?: WorkerNodeRuntimeIdentity;
};

export type WarmAllocationRecord = {
  choice: { kind: "cold" } | { kind: "checkpoint"; checkpointId: string };
  machineClass: string;
  /** Absent in existing Linux allocations. */
  os?: CrabboxOperatingSystem;
  phase: "pending" | "prepared" | "enrolled";
  preparationKey: string | null;
  cacheKey: string | null;
  purpose: "session" | "reserve" | null;
  demandAtMs: number | null;
  imageGeneration: { checkpointId: string; createdAtMs: number } | null;
  /** A cold preparation admitted against a pin may replace only that publication. */
  publicationBase?: { checkpointId: string; createdAtMs: number };
  baseCommit?: string;
  /** Frozen target; preparation/enrollment must verify it before capture can publish it. */
  runtimeIdentity?: WorkerNodeRuntimeIdentity;
};

export type WarmProfileRecord = {
  version: 3;
  /** Configured profile that most recently allocated from this key; display only. */
  profileId?: string;
  backend?: string;
  machineClass?: string;
  os?: CrabboxOperatingSystem;
  projectLabel?: string;
  projectRoot?: string;
  projectKey?: string;
  image?: WarmImageRecord;
  previous?: WarmImageRecord;
  allocations: Record<string, WarmAllocationRecord>;
  operation?:
    | {
        type: "capture";
        id: string;
        startedAtMs: number;
        leaseId?: string;
        provider?: string;
        phase: "scrubbing" | "creating" | "uncertain";
      }
    | { type: "retire"; checkpointId: string };
};

export class CrabboxWarmImageRequestError extends Error {}
// Match the former enrollment registry's capacity without evicting replay obligations;
// 256 bounded lease records leave ample room under the plugin store's 1 MiB row limit.
const WARM_IMAGE_MAX_ALLOCATIONS = 256;
const CAPTURE_WARNING_AGE_MS = 1_200_000;

const openLegacyLeases = (state: CrabboxState, env?: NodeJS.ProcessEnv) =>
  state.openKeyedStore<unknown>({
    namespace: "warm-leases",
    maxEntries: LEGACY_WARM_LEASE_MAX_ENTRIES,
    overflowPolicy: "evict-oldest",
    ...(env ? { env } : {}),
  });
export async function listCrabboxLegacyWarmLeases(state: CrabboxState, env?: NodeJS.ProcessEnv) {
  return projectCrabboxLegacyWarmLeases(await openLegacyLeases(state, env).entries());
}

export async function assertCrabboxWarmImageMigrationReady(state: CrabboxState): Promise<void> {
  const leases = openLegacyLeases(state);
  if ((leases.count ? await leases.count() : (await leases.entries()).length) > 0) {
    throw new Error(
      "Crabbox has legacy worker allocations whose original image choices are unknown; run openclaw doctor --fix and follow its provider-cleanup recovery instructions before provisioning workers.",
    );
  }
}

function requireCanonicalProfile(record: WarmProfileRecord | undefined) {
  if (record && record.version !== 3) {
    throw new Error(
      "Crabbox warm-image state requires migration; run openclaw doctor --fix before provisioning workers.",
    );
  }
  const preparationKey = (value: unknown) =>
    value === null || (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  const demandAtMs = (value: unknown) =>
    value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  const cacheIdentity = (value: { preparationKey: unknown; cacheKey: unknown; purpose: unknown }) =>
    preparationKey(value.cacheKey) &&
    (value.cacheKey === null
      ? value.purpose === null
      : value.preparationKey !== null &&
        (value.purpose === "session" || value.purpose === "reserve"));
  const validImage = (image: WarmImageRecord) =>
    isRecord(image) &&
    preparationKey(image.preparationKey) &&
    cacheIdentity(image) &&
    demandAtMs(image.lastDemandAtMs) &&
    (image.pinned === undefined ||
      (isRecord(image.pinned) &&
        Number.isSafeInteger(image.pinned.atMs) &&
        image.pinned.atMs >= 0));
  const validGeneration = (value: unknown) =>
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.checkpointId === "string" &&
    Boolean(value.checkpointId.trim()) &&
    typeof value.createdAtMs === "number" &&
    Number.isSafeInteger(value.createdAtMs) &&
    value.createdAtMs >= 0;
  if (
    record &&
    (!isRecord(record.allocations) ||
      (record.image && !validImage(record.image)) ||
      (record.previous && !validImage(record.previous)) ||
      Object.values(record.allocations).some(
        (allocation) =>
          !isRecord(allocation) ||
          !preparationKey(allocation.preparationKey) ||
          !cacheIdentity(allocation) ||
          !demandAtMs(allocation.demandAtMs) ||
          (allocation.preparationKey !== null && allocation.demandAtMs === null) ||
          (allocation.imageGeneration !== null && !validGeneration(allocation.imageGeneration)) ||
          (allocation.publicationBase !== undefined &&
            !validGeneration(allocation.publicationBase)),
      ))
  ) {
    throw new Error("Crabbox warm-image preparation state is invalid; run openclaw doctor --fix.");
  }
  return record;
}

export const sameCrabboxWarmImageGeneration = (
  left: WarmAllocationRecord["imageGeneration"] | undefined,
  right: WarmAllocationRecord["imageGeneration"] | undefined,
) => left?.checkpointId === right?.checkpointId && left?.createdAtMs === right?.createdAtMs;

export function withCrabboxWarmImageGeneration(
  record: WarmProfileRecord | undefined,
  generation: WarmAllocationRecord["imageGeneration"] | undefined,
  update: (image: WarmImageRecord) => WarmImageRecord | undefined,
): WarmProfileRecord | undefined {
  if (!record || !generation) {
    return undefined;
  }
  const field = sameCrabboxWarmImageGeneration(record.image, generation) ? "image" : "previous";
  const image = record[field];
  if (!image || !sameCrabboxWarmImageGeneration(image, generation)) {
    return undefined;
  }
  const next = update(image);
  return next ? { ...record, [field]: next } : undefined;
}

export const isCrabboxWarmImageHeld = (
  record: Pick<WarmProfileRecord, "allocations">,
  checkpointId: string,
) =>
  Object.values(record.allocations).some(
    ({ choice, imageGeneration }) =>
      (choice.kind === "checkpoint" && choice.checkpointId === checkpointId) ||
      imageGeneration?.checkpointId === checkpointId,
  );

type WarmProfileDisplayFacts = Pick<
  WarmProfileRecord,
  "profileId" | "backend" | "machineClass" | "os" | "projectLabel" | "projectRoot"
>;

export function withCrabboxWarmImageDisplayFacts(
  record: WarmProfileRecord,
  facts: WarmProfileDisplayFacts = {},
): WarmProfileRecord {
  const next = { ...record, ...facts };
  // Unavailable facts clear stale labels; plugin state cannot persist undefined values.
  for (const field of [
    "profileId",
    "backend",
    "machineClass",
    "os",
    "projectLabel",
    "projectRoot",
  ] as const) {
    if (next[field] === undefined) {
      delete next[field];
    }
  }
  return next;
}

async function compareProfile<T>(
  store: PluginStateKeyedStore<T>,
  key: string,
  prepare: (current: T | undefined) => PluginStateCompareIntent<T>,
): Promise<boolean> {
  if (!store.observe || !store.compareAndApply) {
    throw new Error("Crabbox warm images require atomic asynchronous plugin state support.");
  }
  let observation = await store.observe(key);
  for (;;) {
    const result = await store.compareAndApply(
      key,
      observation.comparison,
      prepare(observation.value),
    );
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    // Only an explicit comparison conflict can retry; uncertain writes must settle with their owner.
    observation = result.current;
  }
}

export function openCrabboxWarmImageStore(state: CrabboxState, env?: NodeJS.ProcessEnv) {
  const store = state.openKeyedStore<WarmProfileRecord>({
    namespace: "warm-images",
    maxEntries: WARM_IMAGE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    ...(env ? { env } : {}),
  });
  const canonical = {
    count: () => (store.count ? store.count() : store.entries().then((entries) => entries.length)),
    deleteIf(key: string, predicate: (current: WarmProfileRecord) => boolean) {
      return compareProfile(store, key, (current) => ({
        operation: "delete",
        action: current && predicate(requireCanonicalProfile(current)!) ? "delete" : "keep",
      }));
    },
    async lookup(key: string) {
      return requireCanonicalProfile(await store.lookup(key));
    },
    async entries() {
      const entries = await store.entries();
      for (const entry of entries) {
        requireCanonicalProfile(entry.value);
      }
      return entries;
    },
    update(
      key: string,
      update: (current: WarmProfileRecord | undefined) => WarmProfileRecord | undefined,
    ) {
      return compareProfile(store, key, (current) => {
        const value = update(requireCanonicalProfile(current));
        return value === undefined
          ? { operation: "update", action: "keep" }
          : { operation: "update", action: "set", value };
      });
    },
  };
  const lookupLease = async (id: string) => {
    const entries = (await canonical.entries()).filter(({ value }) =>
      Object.hasOwn(value.allocations, id),
    );
    if (entries.length > 1) {
      throw new Error(
        `Crabbox lease ${id} has conflicting warm-image owners; run openclaw doctor --fix.`,
      );
    }
    const entry = entries[0];
    return entry
      ? { key: entry.key, projectKey: entry.value.projectKey, ...entry.value.allocations[id]! }
      : undefined;
  };

  const markPhase = async (
    id: string,
    phase: "prepared" | "enrolled",
    baseCommit?: string,
    assertCurrent?: () => void,
  ) => {
    const owner = await lookupLease(id);
    if (!owner) {
      return;
    }
    if (
      phase === "prepared" &&
      (!baseCommit || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit))
    ) {
      throw new Error("Crabbox project preparation requires a verified Git commit.");
    }
    let rejection: string | undefined;
    await canonical.update(owner.key, (record) => {
      assertCurrent?.();
      rejection = undefined;
      const allocation = record?.allocations[id];
      if (!record || !allocation) {
        rejection = "Crabbox allocation closed before preparation completed.";
        return undefined;
      }
      if (record.operation?.type === "capture" && record.operation.leaseId === id) {
        rejection = "Crabbox allocation cannot enroll while its image capture is unresolved.";
        return undefined;
      }
      if (baseCommit && allocation.baseCommit && baseCommit !== allocation.baseCommit) {
        rejection = "Crabbox provision retry changed its prepared Git commit.";
        return undefined;
      }
      if (phase === "enrolled" && record.projectKey && allocation.phase === "pending") {
        rejection = "Crabbox project allocation must be prepared before enrollment.";
        return undefined;
      }
      return {
        ...record,
        allocations: {
          ...record.allocations,
          [id]: {
            ...allocation,
            phase: allocation.phase === "enrolled" ? "enrolled" : phase,
            ...(baseCommit ? { baseCommit } : {}),
          },
        },
      };
    });
    if (rejection) {
      throw new Error(rejection);
    }
  };

  return {
    ...canonical,
    lookupLease,
    async recordAllocation(params: {
      key: string;
      id: string;
      projectKey?: string;
      availableImage?: WarmImageRecord;
      displayFacts?: WarmProfileDisplayFacts;
      allocation: Omit<WarmAllocationRecord, "choice" | "imageGeneration">;
      assertCurrent: () => void;
    }) {
      let rejection: string | undefined;
      let acceptedOwnerJson: string | undefined;
      await canonical.update(params.key, (current) => {
        params.assertCurrent();
        rejection = undefined;
        acceptedOwnerJson = undefined;
        const record = withCrabboxWarmImageDisplayFacts(
          current ?? {
            version: 3,
            allocations: {},
            ...(params.projectKey ? { projectKey: params.projectKey } : {}),
          },
          params.displayFacts,
        );
        if (Object.hasOwn(record.allocations, params.id)) {
          acceptedOwnerJson = JSON.stringify({
            key: params.key,
            projectKey: record.projectKey,
            ...record.allocations[params.id],
          });
          return params.displayFacts ? record : undefined;
        }
        if (Object.keys(record.allocations).length >= WARM_IMAGE_MAX_ALLOCATIONS) {
          rejection =
            "Crabbox warm-image allocation capacity is full; stop outstanding workers before retrying.";
          return undefined;
        }
        // Verification happened before this transaction; its image may have changed or retired.
        const choice: WarmAllocationRecord["choice"] =
          params.availableImage &&
          record.image &&
          sameCrabboxWarmImageGeneration(record.image, params.availableImage) &&
          !(
            record.operation?.type === "retire" &&
            record.operation.checkpointId === record.image.checkpointId
          )
            ? { kind: "checkpoint", checkpointId: record.image.checkpointId }
            : { kind: "cold" };
        const next = {
          ...record,
          allocations: {
            ...record.allocations,
            [params.id]: {
              choice,
              ...params.allocation,
              imageGeneration:
                choice.kind === "checkpoint"
                  ? { checkpointId: choice.checkpointId, createdAtMs: record.image!.createdAtMs }
                  : null,
              ...(choice.kind === "cold" && record.image?.pinned
                ? {
                    publicationBase: {
                      checkpointId: record.image.checkpointId,
                      createdAtMs: record.image.createdAtMs,
                    },
                  }
                : {}),
            },
          },
        };
        acceptedOwnerJson = JSON.stringify({
          key: params.key,
          projectKey: next.projectKey,
          ...next.allocations[params.id],
        });
        return next;
      });
      // Publish only the rejection from the observation accepted by the store.
      if (rejection) {
        throw new Error(rejection);
      }
      const owner = await lookupLease(params.id);
      if (!owner || JSON.stringify(owner) !== acceptedOwnerJson) {
        throw new Error(
          "Crabbox allocation changed before provisioning completed; retry the worker operation.",
        );
      }
      return owner;
    },
    markPrepared: (id: string, baseCommit: string, assertCurrent?: () => void) =>
      markPhase(id, "prepared", baseCommit, assertCurrent),
    markEnrolled: (id: string, assertCurrent?: () => void) =>
      markPhase(id, "enrolled", undefined, assertCurrent),
    async notePreparedDemand(
      id: string,
      preparation: { preparationKey: string; demandAtMs: number },
    ) {
      const owner = await lookupLease(id);
      const generation = owner?.imageGeneration;
      if (
        !owner ||
        owner.phase !== "enrolled" ||
        owner.preparationKey !== preparation.preparationKey ||
        owner.cacheKey === null ||
        !generation ||
        !Number.isSafeInteger(preparation.demandAtMs) ||
        preparation.demandAtMs < 0
      ) {
        return;
      }
      // Assignment has no fork: refresh only the generation selected or produced
      // by this lease, even after demotion; never renew a different publication.
      await canonical.update(owner.key, (record) =>
        record &&
        record.allocations[id]?.preparationKey === owner.preparationKey &&
        record.allocations[id]?.cacheKey === owner.cacheKey &&
        record.allocations[id]?.purpose === owner.purpose &&
        record.allocations[id]?.phase === "enrolled" &&
        sameCrabboxWarmImageGeneration(record.allocations[id]?.imageGeneration, generation)
          ? withCrabboxWarmImageGeneration(record, generation, (image) =>
              image.cacheKey === owner.cacheKey
                ? {
                    ...image,
                    lastDemandAtMs: Math.max(image.lastDemandAtMs ?? 0, preparation.demandAtMs),
                  }
                : undefined,
            )
          : undefined,
      );
    },
  };
}

export function withoutCrabboxWarmImageOperation(record: WarmProfileRecord): WarmProfileRecord {
  const profile = { ...record };
  delete profile.operation;
  return profile;
}

export function crabboxWarmImageCaptureStatus(_key: string, record: WarmProfileRecord) {
  const capture = record.operation?.type === "capture" ? record.operation : undefined;
  if (!capture) {
    return undefined;
  }
  return {
    selector: capture.id,
    startedAtMs: capture.startedAtMs,
    ...(capture.leaseId ? { leaseId: capture.leaseId } : {}),
    ...(capture.provider ? { provider: capture.provider } : {}),
    phase: capture.phase,
    stale: Date.now() - capture.startedAtMs >= CAPTURE_WARNING_AGE_MS,
  };
}

export function isCrabboxWarmImageCaptureUncertain(
  capture: NonNullable<ReturnType<typeof crabboxWarmImageCaptureStatus>>,
): boolean {
  return capture.phase === "uncertain";
}

export const CRABBOX_WARM_IMAGE_WAIT_HINT =
  "The capture may still be preparing its source or waiting for provider readiness. Inspect openclaw crabbox warm-images --json and allow the owning capture to settle.";

export function crabboxWarmImageRecoveryHint(selector: string): string {
  return `Stop the owning Gateway and capture processes, confirm any worker being recovered is stopped, and resolve any untracked checkpoint in the Crabbox catalog before running: openclaw crabbox warm-images --recover ${selector} --acknowledge-provider-cleanup. Then restart the Gateway; the next eligible worker can capture again.`;
}

export async function listCrabboxWarmImages(state: CrabboxState, env?: NodeJS.ProcessEnv) {
  return (await openCrabboxWarmImageStore(state, env).entries()).map(({ key, value }) =>
    projectCrabboxWarmImage(key, value),
  );
}

export function projectCrabboxWarmImage(key: string, value: WarmProfileRecord) {
  requireCanonicalProfile(value);
  return {
    profileKey: key,
    profileId: value.profileId,
    backend: value.backend,
    machineClass: value.machineClass,
    os: value.os,
    projectLabel: value.projectLabel,
    projectRoot: value.projectRoot,
    projectKey: value.projectKey,
    checkpointId: value.image?.checkpointId,
    state: value.image?.state ?? "no-image",
    createdAtMs: value.image?.createdAtMs,
    preparationKey: value.image?.preparationKey,
    cacheKey: value.image?.cacheKey,
    purpose: value.image?.purpose,
    lastDemandAtMs: value.image?.lastDemandAtMs,
    baseCommit: value.image?.baseCommit,
    runtimeIdentity: value.image?.runtimeIdentity,
    pinned: value.image?.pinned,
    previous: value.previous
      ? {
          checkpointId: value.previous.checkpointId,
          createdAtMs: value.previous.createdAtMs,
          baseCommit: value.previous.baseCommit,
          runtimeIdentity: value.previous.runtimeIdentity,
          pinned: value.previous.pinned,
          held: isCrabboxWarmImageHeld(value, value.previous.checkpointId),
        }
      : undefined,
    allocations: value.allocations,
    capture: crabboxWarmImageCaptureStatus(key, value),
    retirement:
      value.operation?.type === "retire"
        ? { checkpointId: value.operation.checkpointId }
        : undefined,
  };
}

/** Recovery closes only the capture generation; allocation decisions remain authoritative. */
export async function clearCrabboxWarmImageCapture(
  store: ReturnType<typeof openCrabboxWarmImageStore>,
  key: string,
  selector: string,
): Promise<boolean> {
  const matches = (current: WarmProfileRecord) =>
    current.operation?.type === "capture" && current.operation.id === selector;
  if (
    await store.deleteIf(
      key,
      (current) =>
        !current.image &&
        !current.previous &&
        Object.keys(current.allocations).length === 0 &&
        matches(current),
    )
  ) {
    return true;
  }
  return store.update(key, (current) =>
    current && matches(current) ? withoutCrabboxWarmImageOperation(current) : undefined,
  );
}

export async function recoverCrabboxWarmImageCapture(
  state: CrabboxState,
  selector: string,
  acknowledgeProviderCleanup: boolean,
): Promise<void> {
  if (!acknowledgeProviderCleanup) {
    throw new Error(
      "Recovery requires --acknowledge-provider-cleanup: confirm the original Gateway/capture processes and any worker being recovered are stopped, and any untracked provider artifact has been resolved. No state was changed.",
    );
  }
  if (selector.startsWith("legacy-lease-")) {
    const store = openLegacyLeases(state);
    const entry = (await store.entries()).find(
      ({ key, value }) => legacyLeaseSelector(key, value) === selector,
    );
    if (
      !entry ||
      !(await compareProfile(store, entry.key, (value) => ({
        operation: "delete",
        action:
          value !== undefined && legacyLeaseSelector(entry.key, value) === selector
            ? "delete"
            : "keep",
      })))
    ) {
      throw new Error(
        "Legacy allocation selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
      );
    }
    return;
  }
  const store = openCrabboxWarmImageStore(state);
  const entry = (await store.entries()).find(
    ({ key, value }) => crabboxWarmImageCaptureStatus(key, value)?.selector === selector,
  );
  if (!entry || !(await clearCrabboxWarmImageCapture(store, entry.key, selector))) {
    throw new Error(
      "Capture selector is absent or changed; rerun openclaw crabbox warm-images --json. No state was changed.",
    );
  }
}
