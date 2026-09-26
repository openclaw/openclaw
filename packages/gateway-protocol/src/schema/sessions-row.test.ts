import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateSessionsAssignOwnerParams } from "../index.js";
import { SessionRowSchema } from "./sessions-row.js";

describe("SessionRowSchema", () => {
  it("accepts optional sharing fields", () => {
    const row = {
      key: "agent:main:main",
      kind: "global",
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
      sessionRoot: "/workspace/project",
    };

    expect(SessionRowSchema.properties.activeLeafEntryId).toBeDefined();
    expect(SessionRowSchema.properties.activeModel).toBeDefined();
    expect(SessionRowSchema.properties.activeModelProvider).toBeDefined();
    expect(SessionRowSchema.properties.lastRunId).toBeDefined();
    expect(SessionRowSchema.properties.parentSessionId).toBeDefined();
    expect(Value.Check(SessionRowSchema, row)).toBe(true);
    expect(Value.Check(SessionRowSchema, { key: "agent:main:main", kind: "global" })).toBe(true);
    expect(Value.Check(SessionRowSchema, { ...row, parentSessionId: 42 })).toBe(false);
    expect(Value.Check(SessionRowSchema, { ...row, sandboxMode: "required" })).toBe(false);
    expect(Value.Check(SessionRowSchema, { ...row, activeLeafEntryId: null })).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        ...row,
        participants: Array.from({ length: 5 }, (_, index) => ({
          identity: { type: "profile", id: `profile-${index}` },
        })),
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionRowSchema, {
        ...row,
        expandedParticipants: Array.from({ length: 32 }, (_, index) => ({
          identity: { type: "profile", id: `profile-${index}` },
        })),
      }),
    ).toBe(true);
    expect(
      Value.Check(SessionRowSchema, {
        ...row,
        expandedParticipants: Array.from({ length: 33 }, (_, index) => ({
          identity: { type: "profile", id: `profile-${index}` },
        })),
      }),
    ).toBe(false);
    expect(Value.Check(SessionRowSchema, { ...row, permissionMode: "unrestricted" })).toBe(false);
    expect(Value.Check(SessionRowSchema, { ...row, lastRunId: "" })).toBe(false);
    expect(Value.Check(SessionRowSchema, { ...row, archiveReason: "age-retention" })).toBe(true);
    expect(Value.Check(SessionRowSchema, { ...row, archiveReason: "unknown" })).toBe(false);
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
      expect(
        Value.Check(SessionRowSchema, {
          key: "agent:main:main",
          kind: "global",
          modelOverrideSource: source,
        }),
      ).toBe(true);
    },
  );

  it("rejects an invalid model override source", () => {
    expect(
      Value.Check(SessionRowSchema, {
        key: "agent:main:main",
        kind: "global",
        modelOverrideSource: "session",
      }),
    ).toBe(false);
  });
});
