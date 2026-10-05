import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { enrollAuthProfileAuthorization } from "./authorization-lifetime.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { inspectAuthProfileJsonCell, writeAuthProfileJsonCell } from "./sqlite-json.js";
import type { AuthProfileRowRead } from "./types.js";

export type AuthProfileAuthorizationEnrollment = {
  profileId: string;
  expected: AuthProfileRowRead["store"];
};
export type AuthProfileAuthorizationOperations = {
  "authProfiles.enrollAuthorization": {
    input: AuthProfileAuthorizationEnrollment;
    output: { raw: unknown };
  };
};

/** The existing auth row is the only durable owner; enrollment is a credential-preserving CAS. */
export function enrollAuthProfileAuthorizationInDatabase(
  database: DatabaseSync,
  kind: "agent" | "shared-state",
  input: AuthProfileAuthorizationEnrollment,
): AuthProfileAuthorizationOperations["authProfiles.enrollAuthorization"]["output"] {
  const existing = inspectAuthProfileJsonCell(database, "store", kind);
  const wasMissing = input.expected.status === "missing" && existing.status === "missing";
  if (
    existing.status === "unreadable" ||
    (!wasMissing && !isDeepStrictEqual(existing, input.expected))
  ) {
    throw new Error("Auth profile changed before authorization enrollment");
  }
  const raw =
    existing.status === "readable" ? existing.raw : { version: AUTH_STORE_VERSION, profiles: {} };
  const next = enrollAuthProfileAuthorization(raw, input.profileId);
  if (next !== raw) {
    writeAuthProfileJsonCell(database, "store", kind, next);
  }
  return { raw: next };
}
