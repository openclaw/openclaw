import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionMemberAddParamsSchema,
  SessionMembersListEvidenceResultSchema,
  SessionMembersListResultSchema,
  SessionSharingEvidenceEventSchema,
  SessionSharingEventSchema,
  SessionVisibilitySetParamsSchema,
} from "./sessions-sharing.js";

function check(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}

const baseEvent = {
  action: "visibility",
  sessionKey: "agent:main:main",
  agentId: "main",
  visibility: "draft",
  ts: 1,
} as const;

describe("session sharing protocol", () => {
  it("accepts additive visibility and membership payloads", () => {
    const list = {
      sessionKey: "agent:main:main",
      identities: [],
      role: "owner",
      allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
    };
    check(SessionVisibilitySetParamsSchema, true, {
      sessionKey: "agent:main:main",
      visibility: "draft",
    });
    check(SessionMemberAddParamsSchema, true, {
      sessionKey: "agent:main:main",
      identityId: "alice@example.com",
    });
    check(SessionMembersListResultSchema, true, {
      ...list,
      members: [{ identityId: "alice", addedBy: "profile-ada", addedAt: 1 }],
    });
    check(SessionMembersListResultSchema, false, {
      ...list,
      members: [{ identityId: "bob", addedByState: "unknown", addedAt: 2 }],
      allowedVisibilities: [],
    });
    for (const member of [
      { identityId: "alice", addedBy: "profile-ada", addedAt: 1 },
      { identityId: "bob", addedByState: "unknown", addedAt: 2 },
      { identityId: "carol", addedAt: 3 },
    ]) {
      check(SessionMembersListEvidenceResultSchema, true, { ...list, members: [member] });
    }
    check(SessionMembersListEvidenceResultSchema, false, {
      ...list,
      members: [
        { identityId: "mixed", addedBy: "profile-ada", addedByState: "unknown", addedAt: 4 },
      ],
      allowedVisibilities: [],
    });
  });

  it("rejects unknown visibility modes", () => {
    check(SessionVisibilitySetParamsSchema, false, {
      sessionKey: "agent:main:main",
      visibility: "private",
    });
  });

  it("keeps the legacy event actor required", () => {
    const withActor = { ...baseEvent, actor: { type: "human", id: "profile-ada", label: "Ada" } };
    const unknownActor = { ...baseEvent, actorState: "unknown" };
    check(SessionSharingEventSchema, true, withActor);
    check(SessionSharingEventSchema, false, unknownActor);
    check(SessionSharingEventSchema, false, baseEvent);
    check(SessionSharingEventSchema, false, { ...withActor, actorState: "unknown" });
    check(SessionSharingEvidenceEventSchema, true, unknownActor);
    check(SessionSharingEvidenceEventSchema, true, baseEvent);
    check(SessionSharingEvidenceEventSchema, false, withActor);
  });
});
