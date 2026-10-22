import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateSessionsAssignOwnerParams } from "../index.js";
import { SessionRowSchema } from "./sessions-row.js";

function check(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}
const baseRow = { key: "agent:main:main", kind: "global" };
const participants = (length: number) =>
  Array.from({ length }, (_, index) => ({ identity: { type: "profile", id: `profile-${index}` } }));

describe("SessionRowSchema", () => {
  it("validates optional sharing fields", () => {
    const row = {
      ...baseRow,
      lastRunId: "run-settled",
      snapshotAt: 200,
      activeLeafEntryId: "leaf-rendered",
      parentSessionKey: "agent:main:dashboard:parent",
      parentSessionId: "sess-parent",
      createdActor: {
        type: "human",
        id: "profile-ada",
        label: "Ada",
        avatarUrl: "/api/users/profile-ada/avatar?v=7",
      },
      owner: {
        actor: { type: "agent", id: "research", label: "Research" },
        assignedBy: { type: "human", id: "profile-ada", label: "Ada" },
        assignedAt: 42,
      },
      participants: [
        { identity: { type: "profile", id: "profile-bob" }, label: "Bob" },
        { identity: { type: "agent", id: "research" }, label: "Research" },
      ],
      participantCount: 2,
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      archiveReason: "manual",
      icon: "🦞",
      channelAvatarUrl: "/__openclaw__/channel-avatar/agent%3Amain%3Amain",
      visibility: "suggest",
      sharingRole: "owner",
      restartRecoveryStatus: "tombstoned",
      permissionMode: "workspace",
      sandboxMode: "off",
      communication: { receive: "ask" },
      effectiveCommunication: { send: "always", receive: "ask" },
      sessionRoot: "/workspace/project",
    };
    expect(SessionRowSchema.properties.activeLeafEntryId).toBeDefined();
    expect(SessionRowSchema.properties.activeModel).toBeDefined();
    expect(SessionRowSchema.properties.activeModelProvider).toBeDefined();
    expect(SessionRowSchema.properties.lastRunId).toBeDefined();
    expect(SessionRowSchema.properties.parentSessionId).toBeDefined();
    check(SessionRowSchema, true, row);
    check(SessionRowSchema, true, baseRow);
    check(SessionRowSchema, false, { ...row, parentSessionId: 42 });
    check(SessionRowSchema, false, { ...row, sandboxMode: "required" });
    check(SessionRowSchema, true, { ...row, activeLeafEntryId: null });
    check(SessionRowSchema, false, { ...row, participants: participants(5) });
    check(SessionRowSchema, true, { ...row, expandedParticipants: participants(32) });
    check(SessionRowSchema, false, { ...row, expandedParticipants: participants(33) });
    check(SessionRowSchema, false, { ...row, permissionMode: "unrestricted" });
    check(SessionRowSchema, false, { ...row, lastRunId: "" });
    check(SessionRowSchema, true, { ...row, archiveReason: "age-retention" });
    check(SessionRowSchema, false, { ...row, archiveReason: "unknown" });
  });

  it("keeps sessions.assignOwner target actors closed and non-empty", () => {
    const accepted = [
      { key: "agent:main:handoff", owner: { type: "human", id: "profile-ada" } },
      { key: "agent:main:handoff", owner: { type: "agent", id: "research" }, agentId: "main" },
    ];
    const rejected = [
      { key: "agent:main:handoff", owner: { type: "system", id: "system" } },
      { key: "agent:main:handoff", owner: { type: "human", id: "" } },
      { key: "agent:main:handoff", owner: { type: "human", id: "ada", label: "Ada" } },
    ];

    expect(accepted.every(validateSessionsAssignOwnerParams)).toBe(true);
    expect(rejected.every((value) => !validateSessionsAssignOwnerParams(value))).toBe(true);
  });

  it.each(["user", "auto", "inherited", null] as const)(
    "accepts model override source %s",
    (source) => {
      check(SessionRowSchema, true, { ...baseRow, modelOverrideSource: source });
    },
  );

  it("rejects an invalid model override source", () => {
    check(SessionRowSchema, false, { ...baseRow, modelOverrideSource: "session" });
  });
});
