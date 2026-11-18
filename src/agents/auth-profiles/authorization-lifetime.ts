import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AuthProfileCredential, AuthProfileSecretsStore } from "./types.js";

/** Private metadata in the existing secrets row. Absent-profile entries fence inheritance ABA. */
export type AuthProfileAuthorizationLifetimes = Record<string, string>;
type AuthorizationWriteIntent =
  | { kind: "replace" }
  | { kind: "refresh"; previous: AuthProfileCredential };
type WriteIntent = AuthorizationWriteIntent & { used: boolean };
export type AuthProfileAuthorizationWriteIntents = Array<{
  profileId: string;
  inherited: boolean;
  intent: AuthorizationWriteIntent;
}>;
const intents = new WeakMap<object, WriteIntent>();
const prepared = new WeakMap<object, unknown>();
const inheritedContinuations = new WeakMap<object, Map<string, WriteIntent>>();

/** Only the peer-settlement owner may retire a verified shared-credential mirror without reauthorizing. */
export function continueAuthProfileAuthorizationInheritance(
  profiles: Record<string, AuthProfileCredential>,
  profileId: string,
  previous: AuthProfileCredential,
): void {
  let entries = inheritedContinuations.get(profiles);
  if (!entries) {
    entries = new Map();
    inheritedContinuations.set(profiles, entries);
  }
  entries.set(profileId, { kind: "refresh", previous: structuredClone(previous), used: false });
}
export function copyAuthProfileAuthorizationInheritance(source: object, target: object): void {
  const entries = inheritedContinuations.get(source);
  if (entries) {
    inheritedContinuations.set(target, entries);
  }
}

/** Only refresh-owner CAS producers carry continuity; a supplied JSON field cannot grant it. */
export function continueAuthProfileAuthorization<T extends AuthProfileCredential>(
  previous: AuthProfileCredential,
  next: T,
): T {
  intents.set(next, { kind: "refresh", previous: structuredClone(previous), used: false });
  return next;
}

/** Explicit login/upsert is replacement even when the operator supplies identical bytes. */
export function replaceAuthProfileAuthorization<T extends AuthProfileCredential>(next: T): T {
  intents.set(next, { kind: "replace", used: false });
  return next;
}

export function copyAuthProfileAuthorizationIntent(source: object, target: object): void {
  const intent = intents.get(source);
  if (intent) {
    intents.set(target, intent);
  }
}

/** Transfer native callback intent separately from caller-controlled credential JSON. */
export function takeAuthProfileAuthorizationWriteIntents(
  profiles: Record<string, AuthProfileCredential>,
): AuthProfileAuthorizationWriteIntents {
  const captured: AuthProfileAuthorizationWriteIntents = [];
  const take = (profileId: string, inherited: boolean, intent: WriteIntent | undefined) => {
    if (intent && !intent.used) {
      const { used: _used, ...value } = intent;
      captured.push({ profileId, inherited, intent: value });
      intent.used = true;
    }
  };
  for (const [profileId, credential] of Object.entries(profiles)) {
    take(profileId, false, intents.get(credential));
  }
  for (const [profileId, intent] of inheritedContinuations.get(profiles) ?? []) {
    take(profileId, true, intent);
  }
  return captured;
}

/** Only the private host/worker exchange may reattach transferred write intent. */
export function restoreAuthProfileAuthorizationWriteIntents(
  profiles: Record<string, AuthProfileCredential>,
  captured: AuthProfileAuthorizationWriteIntents,
): void {
  for (const { profileId, inherited, intent } of captured) {
    if (inherited && intent.kind === "refresh") {
      continueAuthProfileAuthorizationInheritance(profiles, profileId, intent.previous);
    } else if (!inherited && Object.hasOwn(profiles, profileId)) {
      intents.set(profiles[profileId]!, { ...intent, used: false });
    }
  }
}

export function readAuthProfileAuthorizationLifetimes(
  raw: unknown,
): AuthProfileAuthorizationLifetimes {
  if (!isRecord(raw) || raw.authorizationLifetimes === undefined) {
    return {};
  }
  if (!isRecord(raw.authorizationLifetimes)) {
    throw new Error("Invalid auth profile authorization metadata");
  }
  const entries: Array<[string, string]> = [];
  for (const [profileId, value] of Object.entries(raw.authorizationLifetimes)) {
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) {
      throw new Error("Invalid auth profile authorization metadata");
    }
    entries.push([profileId, value]);
  }
  return Object.fromEntries(entries);
}

export function readAuthProfileAuthorizationLifetime(
  raw: unknown,
  profileId: string,
): string | undefined {
  const lifetimes = readAuthProfileAuthorizationLifetimes(raw);
  return Object.hasOwn(lifetimes, profileId) ? lifetimes[profileId] : undefined;
}

/** Canonical writer reduction; incoming metadata is never replacement/refresh authority. */
export function prepareAuthProfileAuthorizationWrite(
  existing: unknown,
  incoming: AuthProfileSecretsStore,
): AuthProfileSecretsStore;
export function prepareAuthProfileAuthorizationWrite(existing: unknown, incoming: unknown): unknown;
export function prepareAuthProfileAuthorizationWrite(
  existing: unknown,
  incoming: unknown,
): unknown {
  const lifetimes = readAuthProfileAuthorizationLifetimes(existing);
  if (!isRecord(incoming) || !isRecord(incoming.profiles)) {
    if (Object.keys(lifetimes).length) {
      throw new Error("Invalid auth profile credential payload");
    }
    return incoming;
  }
  if (prepared.has(incoming) && isDeepStrictEqual(prepared.get(incoming), existing)) {
    return incoming;
  }
  // Enrollment is explicit and worker-owned; unrelated auth writes do not grow this map.
  if (Object.keys(lifetimes).length === 0) {
    for (const credential of Object.values(incoming.profiles)) {
      const intent = isRecord(credential) ? intents.get(credential) : undefined;
      if (intent) {
        intent.used = true;
      }
    }
    const { authorizationLifetimes: _untrusted, ...payload } = incoming;
    return payload;
  }
  const previousProfiles =
    isRecord(existing) && isRecord(existing.profiles) ? existing.profiles : {};
  for (const profileId of Object.keys(lifetimes)) {
    const previous = previousProfiles[profileId];
    const next = incoming.profiles[profileId];
    const intent = isRecord(next)
      ? intents.get(next)
      : inheritedContinuations.get(incoming.profiles)?.get(profileId);
    const continuing =
      intent &&
      !intent.used &&
      intent.kind === "refresh" &&
      isDeepStrictEqual(intent.previous, previous);
    if (
      (intent && !intent.used && intent.kind === "replace") ||
      (!isDeepStrictEqual(previous, next) && !continuing)
    ) {
      lifetimes[profileId] = randomUUID();
    }
    if (intent) {
      intent.used = true;
    }
  }
  const payload = { ...incoming, authorizationLifetimes: lifetimes };
  prepared.set(payload, existing);
  return payload;
}

/** Enrollment changes no credential bytes and must run in the canonical writer transaction. */
export function enrollAuthProfileAuthorization(raw: unknown, profileId: string): unknown {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    throw new Error("Invalid auth profile credential payload");
  }
  const lifetimes = readAuthProfileAuthorizationLifetimes(raw);
  if (Object.hasOwn(lifetimes, profileId)) {
    return raw;
  }
  return { ...raw, authorizationLifetimes: { ...lifetimes, [profileId]: randomUUID() } };
}
