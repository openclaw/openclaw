import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { McpConnectionAuthorityError } from "../mcp-connection-authority-error.js";
import { readAuthProfileAuthorizationLifetime } from "./authorization-lifetime.js";
import { isOAuthRefreshFence, readPendingOAuthRefreshClaimId } from "./oauth-refresh-marker.js";

export type AuthProfileAuthorizationFact = {
  incarnation?: string;
  status: "absent" | "ready" | "pending" | "retired";
  expires?: number;
};

function projectAuthProfileAuthorization(
  raw: unknown,
  profileId: string,
): AuthProfileAuthorizationFact {
  const incarnation = readAuthProfileAuthorizationLifetime(raw, profileId);
  const credential =
    isRecord(raw) && isRecord(raw.profiles) && Object.hasOwn(raw.profiles, profileId)
      ? raw.profiles[profileId]
      : undefined;
  if (!isRecord(credential)) {
    return { incarnation, status: "absent" };
  }
  if (isRecord(credential.setup) && credential.setup.replacement === true) {
    return { incarnation, status: "retired" };
  }
  if (
    credential.type === "oauth" &&
    typeof credential.access === "string" &&
    typeof credential.refresh === "string" &&
    typeof credential.expires === "number"
  ) {
    const status = readPendingOAuthRefreshClaimId(credential)
      ? "pending"
      : isOAuthRefreshFence({
            type: "oauth",
            access: credential.access,
            refresh: credential.refresh,
            expires: credential.expires,
          })
        ? "retired"
        : "ready";
    return { incarnation, status, ...(!credential.refresh ? { expires: credential.expires } : {}) };
  }
  if (credential.type === "api_key" && (credential.key || credential.keyRef)) {
    return { incarnation, status: "ready" };
  }
  if (credential.type === "token" && (credential.token || credential.tokenRef)) {
    return {
      incarnation,
      status: "ready",
      ...(typeof credential.expires === "number" ? { expires: credential.expires } : {}),
    };
  }
  return { incarnation, status: "retired" };
}

type Observation = { revision: object; fact?: AuthProfileAuthorizationFact; references: number };
type Publication = { profiles: Map<string, Observation>; pending: number; uncertain: boolean };
// A token-free publication of the existing credential writer, retained only by active readers
// and unresolved writes. Canonical rows and credential decisions remain with that writer.
const publications = new Map<string, Publication>();
function publication(databasePath: string): Publication {
  let owner = publications.get(databasePath);
  if (!owner) {
    owner = { profiles: new Map(), pending: 0, uncertain: false };
    publications.set(databasePath, owner);
  }
  return owner;
}
function prune(databasePath: string, owner: Publication): void {
  if (!owner.profiles.size && !owner.pending && !owner.uncertain) {
    publications.delete(databasePath);
  }
}
export function publishAuthProfileAuthorization(inputPath: string, raw: unknown): void {
  const databasePath = resolvePathViaExistingAncestorSync(inputPath);
  const owner = publications.get(databasePath);
  if (!owner) {
    return;
  }
  for (const [profileId, observation] of owner.profiles) {
    const fact = projectAuthProfileAuthorization(raw, profileId);
    if (!isDeepStrictEqual(observation.fact, fact)) {
      observation.fact = fact;
      observation.revision = {};
    }
  }
}

/** Fence before native COMMIT admission; unknown settlement is never repaired by a plain read. */
export function fenceAuthProfileAuthorizationWrite(inputPath: string) {
  const databasePath = resolvePathViaExistingAncestorSync(inputPath);
  const owner = publication(databasePath);
  owner.pending++;
  for (const observation of owner.profiles.values()) {
    observation.revision = {};
  }
  let settled = false;
  return (known: boolean, raw?: unknown) => {
    if (settled) {
      return;
    }
    settled = true;
    owner.uncertain ||= !known;
    if (known && raw !== undefined) {
      publishAuthProfileAuthorization(databasePath, raw);
    }
    owner.pending--;
    for (const observation of owner.profiles.values()) {
      observation.revision = {};
    }
    prune(databasePath, owner);
  };
}

export function retainAuthProfileAuthorizationObservation(inputPath: string, profileId: string) {
  const databasePath = resolvePathViaExistingAncestorSync(inputPath);
  const owner = publication(databasePath);
  let observation = owner.profiles.get(profileId);
  if (!observation) {
    observation = { revision: {}, references: 0 };
    owner.profiles.set(profileId, observation);
  }
  const retained = observation;
  retained.references++;
  let disposed = false;
  const assertSettled = () => {
    if (disposed) {
      throw new McpConnectionAuthorityError("retired");
    }
    if (owner.pending || owner.uncertain) {
      throw new McpConnectionAuthorityError("unavailable");
    }
  };
  return {
    readFact() {
      assertSettled();
      return retained.fact;
    },
    prepareRead() {
      assertSettled();
      const revision = retained.revision;
      return (raw: unknown) => {
        assertSettled();
        if (retained.revision !== revision) {
          throw new McpConnectionAuthorityError("unavailable");
        }
        const fact = projectAuthProfileAuthorization(raw, profileId);
        if (!isDeepStrictEqual(retained.fact, fact)) {
          retained.fact = fact;
          retained.revision = {};
        }
        return fact;
      };
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (--retained.references === 0) {
        owner.profiles.delete(profileId);
      }
      prune(databasePath, owner);
    },
  };
}
