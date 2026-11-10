import { expect, it } from "vitest";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";

const identity = { sessionId: "child-session", lifecycleRevision: "child-revision" };
const owned = {
  childSessionKey: "agent:worker:subagent:child",
  requesterSessionKey: "agent:parent:main",
  childSessionIdentity: identity,
};
const noIdentity = { childSessionIdentity: undefined };
const sessionOnly = { sessionId: identity.sessionId };
const noRevision = { childSessionIdentity: sessionOnly };
const ownership = { childAgentId: "worker", requesterAgentId: "parent" };

it.each([
  ["verified qualified owner", {}, identity, "verified"],
  ["unobserved current identity", {}, undefined, "verified"],
  ["raw owner", { childSessionKey: "global", childAgentId: "worker" }, identity, "verified"],
  ["missing original identity", noIdentity, identity, "legacy-unverified"],
  ["missing original revision", noRevision, identity, "legacy-unverified"],
  ["missing both revisions", noRevision, sessionOnly, "legacy-unverified"],
  ["unknown child owner", { childSessionKey: "global" }, identity, "mismatch"],
  ["unknown requester", { ...noIdentity, requesterSessionKey: "global" }, identity, "mismatch"],
  ["conflicting explicit owner", { childAgentId: "other" }, identity, "mismatch"],
  ["changed session", {}, { ...identity, sessionId: "replacement-session" }, "mismatch"],
  ["changed revision", {}, { ...identity, lifecycleRevision: "new-revision" }, "mismatch"],
  ["lost known revision", {}, sessionOnly, "mismatch"],
  ["lost known session", {}, null, "mismatch"],
] as const)("%s", (_name, entry, current, status) => {
  const result = resolveSubagentChildAuthority({ ...owned, ...entry }, current);
  expect(result).toMatchObject(status === "mismatch" ? { status } : { status, ...ownership });
});
