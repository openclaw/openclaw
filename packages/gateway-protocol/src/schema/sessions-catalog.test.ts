import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateSessionsAssignOwnerParams } from "../index.js";
import { schemaValidation } from "./protocol-validation.test-support.js";
import {
  SessionCatalogShareRouteSchema,
  SessionsCatalogHostEventSchema,
  SessionsCatalogImportParamsSchema,
  SessionsCatalogImportResultSchema,
  SessionsCatalogListParamsSchema,
  SessionsCatalogListResultSchema,
  SessionsCatalogStartTerminalParamsSchema,
  SessionsCatalogStartTerminalResultSchema,
} from "./sessions-catalog.js";
import { SessionRowSchema } from "./sessions-row.js";
import * as Sharing from "./sessions-sharing.js";
import * as Suggestions from "./sessions-suggestions.js";

const target = { sessionKey: "agent:main:main" };
const makeHuman = (id = "profile-ada", label = "Ada") => ({ type: "human", id, label });

function checkCatalog(schema: TSchema, value: Record<string, unknown>, invalid: object[] = []) {
  expect(Value.Check(schema, value)).toBe(true);
  for (const override of invalid) {
    expect(Value.Check(schema, { ...value, ...override })).toBe(false);
  }
}
const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "shared-sessions",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const;
const host = {
  hostId: "gateway:local",
  label: "Gateway",
  kind: "gateway",
  connected: true,
  sessions: [],
};
const catalog = {
  id: "codex",
  label: "Codex",
  capabilities: { continueSession: true, archive: true },
  hosts: [host],
};
describe("session catalog schemas", () => {
  it("accepts only the closed prefix-search contract", () => {
    checkCatalog(SessionCatalogShareRouteSchema, SHARE_ROUTE, [
      { kind: "future-route" },
      { identifierAlphabet: "hex" },
      { fullLength: 64 },
      { minPrefixLength: 8 },
      { lookup: "arbitrary-search" },
      { ambiguity: "first-result" },
      { unexpected: true },
    ]);
  });

  it("accepts a closed catalog result with hosts", () => {
    const session = {
      threadId: "thread-1",
      status: "idle",
      archived: false,
      createdActor: makeHuman(),
      canContinue: true,
      canArchive: false,
      canOpenTerminal: true,
    };
    checkCatalog(SessionsCatalogListResultSchema, {
      catalogs: [
        {
          ...catalog,
          capabilities: {
            ...catalog.capabilities,
            archive: false,
            createSession: { model: "fixture", startTerminal: true },
            openTerminal: true,
            startTerminal: true,
          },
          shareRoute: SHARE_ROUTE,
          hosts: [{ ...host, canStartTerminal: true, sessions: [session] }],
        },
      ],
    });
  });

  it("accepts the terminal start contract and rejects unknown fields", () => {
    const params = {
      catalogId: "codex",
      hostId: "gateway:local",
      agentId: "main",
      cwd: "/tmp/worktree",
      initialMessage: "Inspect the failing test",
    };
    const result = {
      sessionId: "terminal-1",
      agentId: "main",
      shell: "/bin/zsh",
      cwd: "/tmp/worktree",
      confined: false,
      title: "Codex",
    };

    checkCatalog(SessionsCatalogStartTerminalParamsSchema, params, [
      { unexpected: true },
      { argv: ["sh"] },
      { executable: "/bin/sh" },
      { env: {} },
      { cwd: "x".repeat(4097) },
      { initialMessage: "x".repeat(16385) },
    ]);
    checkCatalog(SessionsCatalogStartTerminalResultSchema, result, [{ unexpected: true }]);
  });

  it("accepts a locator and closed import counts, including incomplete and unchanged results", () => {
    const params = { catalogId: "c", hostId: "h", threadId: "t", sourceHomeId: "s", agentId: "a" };
    const result = {
      sessionKey: "agent:research:imported-session",
      importedItems: 0,
      totalItems: 20,
      complete: false,
      created: false,
    };

    checkCatalog(SessionsCatalogImportParamsSchema, params, [
      { displayName: "" },
      { displayName: "x".repeat(501) },
      { fork: true },
    ]);
    for (const displayName of ["Imported native session", "x".repeat(500)]) {
      checkCatalog(SessionsCatalogImportParamsSchema, { ...params, displayName });
    }
    checkCatalog(SessionsCatalogImportResultSchema, {
      ...result,
      importedItems: 20,
      complete: true,
      created: true,
    });
    checkCatalog(SessionsCatalogImportResultSchema, result, [
      { importedItems: -1 },
      { importedItems: 0.5 },
      { totalItems: -1 },
      { totalItems: 0.5 },
      { complete: "false" },
      { created: "false" },
      { unexpected: true },
    ]);
  });

  it("accepts only boolean metadata selection while retaining full-list defaults", () => {
    checkCatalog(SessionsCatalogListParamsSchema, {}, [{ metadataOnly: "true" }]);
    for (const metadataOnly of [false, true]) {
      checkCatalog(SessionsCatalogListParamsSchema, { metadataOnly });
    }
  });

  it("accepts one completed host and rejects unknown fields", () => {
    const event = { progressId: "progress-1", agentId: "main", catalog };

    checkCatalog(SessionsCatalogHostEventSchema, event, [
      { unexpected: true },
      ...[[], [host, host]].map((hosts) => ({ catalog: { ...event.catalog, hosts } })),
    ]);
    checkCatalog(SessionsCatalogHostEventSchema, {
      ...event,
      catalog: { ...event.catalog, hosts: [{ ...host, pending: true }] },
    });
  });
});

function checkRow(schema: TSchema, expected: boolean, value: unknown) {
  expect(Value.Check(schema, value)).toBe(expected);
}
const baseRow = { key: "agent:main:main", kind: "global" };
const participants = (length: number) =>
  Array.from({ length }, (_, index) => ({ identity: { type: "profile", id: `profile-${index}` } }));
describe("SessionRowSchema", () => {
  it("validates optional sharing fields", () => {
    const human = makeHuman();
    const row = {
      ...baseRow,
      lastRunId: "run-settled",
      snapshotAt: 200,
      activeLeafEntryId: "leaf-rendered",
      parentSessionKey: "agent:main:dashboard:parent",
      parentSessionId: "sess-parent",
      createdActor: { ...human, avatarUrl: "/api/users/profile-ada/avatar?v=7" },
      owner: {
        actor: { type: "agent", id: "research", label: "Research" },
        assignedBy: human,
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
    checkRow(SessionRowSchema, true, row);
    checkRow(SessionRowSchema, true, baseRow);
    checkRow(SessionRowSchema, false, { ...row, parentSessionId: 42 });
    checkRow(SessionRowSchema, false, { ...row, sandboxMode: "required" });
    checkRow(SessionRowSchema, true, { ...row, activeLeafEntryId: null });
    checkRow(SessionRowSchema, false, { ...row, participants: participants(5) });
    checkRow(SessionRowSchema, true, { ...row, expandedParticipants: participants(32) });
    checkRow(SessionRowSchema, false, { ...row, expandedParticipants: participants(33) });
    checkRow(SessionRowSchema, false, { ...row, permissionMode: "unrestricted" });
    checkRow(SessionRowSchema, false, { ...row, lastRunId: "" });
    checkRow(SessionRowSchema, true, { ...row, archiveReason: "age-retention" });
    checkRow(SessionRowSchema, false, { ...row, archiveReason: "unknown" });
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
      checkRow(SessionRowSchema, true, { ...baseRow, modelOverrideSource: source });
    },
  );

  it("rejects an invalid model override source", () => {
    checkRow(SessionRowSchema, false, { ...baseRow, modelOverrideSource: "session" });
  });
});

const visibility = schemaValidation(Sharing.SessionVisibilitySetParamsSchema);
const members = schemaValidation(Sharing.SessionMembersListResultSchema);
const evidence = schemaValidation(Sharing.SessionMembersListEvidenceResultSchema);
const sharingEvent = schemaValidation(Sharing.SessionSharingEventSchema);
const evidenceEvent = schemaValidation(Sharing.SessionSharingEvidenceEventSchema);

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
    schemaValidation(Sharing.SessionMemberAddParamsSchema).accepts({
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
    const withActor = { ...baseEvent, actor: makeHuman() };
    const unknownActor = { ...baseEvent, actorState: "unknown" };
    sharingEvent.accepts(withActor);
    sharingEvent.rejects(unknownActor, baseEvent, { ...withActor, actorState: "unknown" });
    evidenceEvent.accepts(unknownActor, baseEvent);
    evidenceEvent.rejects(withActor);
  });
});

const add = schemaValidation(Suggestions.SessionSuggestionsAddParamsSchema);
const resolve = schemaValidation(Suggestions.SessionSuggestionsResolveParamsSchema);

const suggestion = {
  id: "suggestion-1",
  ...target,
  agentId: "main",
  author: makeHuman("alice", "Alice"),
  text: "Try the smaller refactor",
  createdAt: 1,
  state: "pending",
};
const typingParams = { ...target, sessionId: "session-main", typing: true };
const typingEvent = { ...typingParams, agentId: "main", actor: suggestion.author, ts: 1 };
describe("session suggestions protocol", () => {
  it("accepts suggestion RPC and event payloads", () => {
    add.accepts({ ...target, text: suggestion.text });
    resolve.accepts({ ...target, id: suggestion.id, resolution: "queue" });
    schemaValidation(Suggestions.SessionSuggestionsListResultSchema).accepts({
      suggestions: [suggestion],
      role: "owner",
    });
    schemaValidation(Suggestions.SessionSuggestionEventSchema).accepts({
      action: "added",
      suggestion,
    });
    schemaValidation(Suggestions.SessionTypingParamsSchema).accepts(typingParams);
    schemaValidation(Suggestions.SessionTypingEventSchema).accepts(typingEvent);
  });

  it("rejects empty suggestions and unknown resolutions", () => {
    add.rejects({ ...target, text: "" });
    resolve.rejects({ ...target, id: suggestion.id, resolution: "accept" });
  });

  it("accepts optional bounded typing previews without requiring them", () => {
    for (const [schema, base] of [
      [Suggestions.SessionTypingParamsSchema, typingParams],
      [Suggestions.SessionTypingEventSchema, typingEvent],
    ] as const) {
      const typing = schemaValidation(schema);
      typing.accepts(
        ...[0, 4, 800].map((cursor) => Object.assign({}, base, { preview: "draft", cursor })),
        {
          ...base,
          preview: "draft",
        },
      );
      typing.rejects(...[-1, 0.5, 801, "2"].map((cursor) => Object.assign({}, base, { cursor })), {
        ...base,
        preview: "x".repeat(401),
      });
    }
  });
});
