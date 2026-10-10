import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const REEF_REGISTRATION_NAMESPACE = "registration";
export const REEF_REGISTRATION_IDENTITY_KEY = "identity";
export const REEF_REGISTRATION_SESSION_KEY = "setup-session";
export const REEF_REGISTRATION_MAX_ENTRIES = 2;

export type ReefIdentityBinding = { handle: string; relayUrl: string };
type ReefIdentityPendingRecord = ReefIdentityBinding & {
  kind: "pending";
  owner: string;
  expiresAt: number;
};
type ReefIdentityReservation = {
  binding: ReefIdentityBinding;
  owner?: string;
};
export type ReefSetupSession = { session: string; relayUrl: string; email: string };

const REEF_IDENTITY_RESERVATION_MS = 10 * 60_000;

type ReefRegistrationRecord = ReefIdentityBinding | ReefIdentityPendingRecord | ReefSetupSession;

const registrationStoreOptions = {
  namespace: REEF_REGISTRATION_NAMESPACE,
  maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
  overflowPolicy: "reject-new",
} satisfies OpenKeyedStoreOptions;

function openRegistrationStore(
  runtime: PluginRuntime,
): PluginStateKeyedStore<ReefRegistrationRecord> {
  return runtime.state.openKeyedStore<ReefRegistrationRecord>(registrationStoreOptions);
}

export function parseReefIdentityBinding(value: unknown): ReefIdentityBinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefIdentityBinding & { kind?: unknown }>;
  if (parsed.kind === "pending") {
    return undefined;
  }
  return typeof parsed.handle === "string" &&
    parsed.handle.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0
    ? { handle: parsed.handle, relayUrl: parsed.relayUrl }
    : undefined;
}

function parseReefIdentityPendingRecord(value: unknown): ReefIdentityPendingRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefIdentityPendingRecord>;
  return parsed.kind === "pending" &&
    typeof parsed.handle === "string" &&
    parsed.handle.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0 &&
    typeof parsed.owner === "string" &&
    parsed.owner.length > 0 &&
    Number.isSafeInteger(parsed.expiresAt) &&
    (parsed.expiresAt ?? 0) > 0
    ? {
        kind: "pending",
        handle: parsed.handle,
        relayUrl: parsed.relayUrl,
        owner: parsed.owner,
        expiresAt: parsed.expiresAt!,
      }
    : undefined;
}

function reefIdentityConflict(binding: ReefIdentityBinding): Error {
  return new Error(
    `This OpenClaw state already holds the Reef identity @${binding.handle} on ${binding.relayUrl}. Re-register the same handle and relay.`,
  );
}

export function parseReefSetupSession(value: unknown): ReefSetupSession | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefSetupSession>;
  return typeof parsed.session === "string" &&
    parsed.session.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0 &&
    typeof parsed.email === "string" &&
    parsed.email.length > 0
    ? { session: parsed.session, relayUrl: parsed.relayUrl, email: parsed.email }
    : undefined;
}

export async function loadReefIdentityBinding(
  runtime: PluginRuntime,
): Promise<ReefIdentityBinding | undefined> {
  return parseReefIdentityBinding(
    await openRegistrationStore(runtime).lookup(REEF_REGISTRATION_IDENTITY_KEY),
  );
}

export async function assertReefIdentityBinding(
  runtime: PluginRuntime,
  binding: ReefIdentityBinding,
): Promise<void> {
  const existing = await loadReefIdentityBinding(runtime);
  if (!existing) {
    throw new Error(
      "Reef identity binding is missing; run openclaw doctor --fix or register this claw",
    );
  }
  if (existing.handle !== binding.handle || existing.relayUrl !== binding.relayUrl) {
    throw reefIdentityConflict(existing);
  }
}

function openIdentityReservationStore(runtime: PluginRuntime) {
  const { observe, compareAndApply } = openRegistrationStore(runtime);
  if (observe && compareAndApply) {
    return { kind: "worker" as const, observe, compareAndApply };
  }
  // Shipped hosts without comparisons retain their atomic native callbacks.
  // Remove only when an approved minimum host version guarantees comparisons.
  return {
    kind: "legacy" as const,
    store: runtime.state.openSyncKeyedStore<ReefRegistrationRecord>(registrationStoreOptions),
  };
}

type IdentityUpdate<T> = { value: ReefRegistrationRecord; result: T };

async function updateIdentityBinding<T>(
  runtime: PluginRuntime,
  decide: (current: ReefRegistrationRecord | undefined) => IdentityUpdate<T>,
): Promise<T> {
  const access = openIdentityReservationStore(runtime);
  if (access.kind === "legacy") {
    const update = access.store.update;
    if (!update) {
      throw new Error("Reef identity reservation requires atomic plugin-state updates");
    }
    const outcome: { decision?: IdentityUpdate<T>; failure?: { error: unknown } } = {};
    update(REEF_REGISTRATION_IDENTITY_KEY, (current) => {
      try {
        outcome.decision = decide(current);
        return outcome.decision.value;
      } catch (error) {
        // The native SDK wraps callback exceptions. Publish domain errors only
        // after the atomic update settles, as the original Reef owner did.
        outcome.failure = { error };
        return current;
      }
    });
    if (outcome.failure) {
      throw outcome.failure.error;
    }
    if (!outcome.decision) {
      throw new Error("Reef identity reservation update did not run");
    }
    return outcome.decision.result;
  }
  let observation = await access.observe(REEF_REGISTRATION_IDENTITY_KEY);
  for (;;) {
    const decision = decide(observation.value);
    const result = await access.compareAndApply(
      REEF_REGISTRATION_IDENTITY_KEY,
      observation.comparison,
      { operation: "update", action: "set", value: decision.value },
    );
    if (result.status !== "conflict") {
      return decision.result;
    }
    observation = result.current;
  }
}

export async function reserveReefIdentityBinding(
  runtime: PluginRuntime,
  binding: ReefIdentityBinding,
): Promise<ReefIdentityReservation> {
  const parsed = parseReefIdentityBinding(binding);
  if (!parsed) {
    throw new Error("invalid Reef identity binding");
  }
  return await updateIdentityBinding<ReefIdentityReservation>(runtime, (current) => {
    const existing = parseReefIdentityBinding(current);
    if (existing) {
      if (existing.handle !== parsed.handle || existing.relayUrl !== parsed.relayUrl) {
        throw reefIdentityConflict(existing);
      }
      return { value: existing, result: { binding: parsed } };
    }
    const pending = parseReefIdentityPendingRecord(current);
    if (pending) {
      const sameBinding = pending.handle === parsed.handle && pending.relayUrl === parsed.relayUrl;
      // Never transfer a live reservation. After expiry, only the same target
      // may retry because the original relay request may already have committed.
      if (pending.expiresAt > Date.now() || !sameBinding) {
        throw reefIdentityConflict(pending);
      }
    }
    const owner = randomUUID();
    return {
      value: {
        kind: "pending",
        ...parsed,
        owner,
        expiresAt: Date.now() + REEF_IDENTITY_RESERVATION_MS,
      },
      result: { binding: parsed, owner },
    };
  });
}

export async function finalizeReefIdentityBinding(
  runtime: PluginRuntime,
  reservation: ReefIdentityReservation,
): Promise<void> {
  if (!reservation.owner) {
    return;
  }
  await updateIdentityBinding(runtime, (current) => {
    const existing = parseReefIdentityBinding(current);
    if (
      existing?.handle === reservation.binding.handle &&
      existing.relayUrl === reservation.binding.relayUrl
    ) {
      return { value: existing, result: undefined };
    }
    const pending = parseReefIdentityPendingRecord(current);
    if (pending?.owner !== reservation.owner) {
      throw new Error("Reef identity reservation was replaced before registration completed");
    }
    return { value: reservation.binding, result: undefined };
  });
}

export async function releaseReefIdentityReservation(
  runtime: PluginRuntime,
  reservation: ReefIdentityReservation,
): Promise<void> {
  if (!reservation.owner) {
    return;
  }
  const ownsReservation = (current: ReefRegistrationRecord | undefined) =>
    parseReefIdentityPendingRecord(current)?.owner === reservation.owner;
  const access = openIdentityReservationStore(runtime);
  if (access.kind === "legacy") {
    const deleteIf = access.store.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef identity reservation requires atomic plugin-state updates");
    }
    deleteIf(REEF_REGISTRATION_IDENTITY_KEY, ownsReservation);
    return;
  }
  let observation = await access.observe(REEF_REGISTRATION_IDENTITY_KEY);
  while (ownsReservation(observation.value)) {
    const result = await access.compareAndApply(
      REEF_REGISTRATION_IDENTITY_KEY,
      observation.comparison,
      {
        operation: "delete",
        action: "delete",
      },
    );
    if (result.status !== "conflict") {
      return;
    }
    observation = result.current;
  }
}

export async function loadReefSetupSession(
  runtime: PluginRuntime,
): Promise<ReefSetupSession | undefined> {
  return parseReefSetupSession(
    await openRegistrationStore(runtime).lookup(REEF_REGISTRATION_SESSION_KEY),
  );
}

export async function saveReefSetupSession(
  runtime: PluginRuntime,
  session: ReefSetupSession,
): Promise<void> {
  const parsed = parseReefSetupSession(session);
  if (!parsed) {
    throw new Error("invalid Reef setup session");
  }
  await openRegistrationStore(runtime).register(REEF_REGISTRATION_SESSION_KEY, parsed);
}

export async function clearReefSetupSession(runtime: PluginRuntime): Promise<void> {
  await openRegistrationStore(runtime).delete(REEF_REGISTRATION_SESSION_KEY);
}
