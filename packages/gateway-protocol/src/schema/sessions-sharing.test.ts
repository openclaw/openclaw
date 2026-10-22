import { describe, it } from "vitest";
import { schemaValidation } from "./protocol-validation.test-support.js";
import * as S from "./sessions-sharing.js";

const visibility = schemaValidation(S.SessionVisibilitySetParamsSchema);
const members = schemaValidation(S.SessionMembersListResultSchema);
const evidence = schemaValidation(S.SessionMembersListEvidenceResultSchema);
const event = schemaValidation(S.SessionSharingEventSchema);
const evidenceEvent = schemaValidation(S.SessionSharingEvidenceEventSchema);
const target = { sessionKey: "agent:main:main" };

const baseEvent = {
  action: "visibility",
  ...target,
  agentId: "main",
  visibility: "draft",
  ts: 1,
} as const;

describe("session sharing protocol", () => {
  it("accepts additive visibility and membership payloads", () => {
    const list = {
      ...target,
      identities: [],
      role: "owner",
      allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
    };
    visibility.accepts({ ...target, visibility: "draft" });
    schemaValidation(S.SessionMemberAddParamsSchema).accepts({
      ...target,
      identityId: "alice@example.com",
    });
    members.accepts({
      ...list,
      members: [{ identityId: "alice", addedBy: "profile-ada", addedAt: 1 }],
    });
    members.rejects({
      ...list,
      members: [{ identityId: "bob", addedByState: "unknown", addedAt: 2 }],
      allowedVisibilities: [],
    });
    for (const member of [
      { identityId: "alice", addedBy: "profile-ada", addedAt: 1 },
      { identityId: "bob", addedByState: "unknown", addedAt: 2 },
      { identityId: "carol", addedAt: 3 },
    ]) {
      evidence.accepts({ ...list, members: [member] });
    }
    evidence.rejects({
      ...list,
      members: [
        { identityId: "mixed", addedBy: "profile-ada", addedByState: "unknown", addedAt: 4 },
      ],
      allowedVisibilities: [],
    });
  });

  it("rejects unknown visibility modes", () => {
    visibility.rejects({ ...target, visibility: "private" });
  });

  it("keeps the legacy event actor required", () => {
    const withActor = { ...baseEvent, actor: { type: "human", id: "profile-ada", label: "Ada" } };
    const unknownActor = { ...baseEvent, actorState: "unknown" };
    event.accepts(withActor);
    event.rejects(unknownActor, baseEvent, { ...withActor, actorState: "unknown" });
    evidenceEvent.accepts(unknownActor, baseEvent);
    evidenceEvent.rejects(withActor);
  });
});
