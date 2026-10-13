import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
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

describe("SessionCatalogShareRouteSchema", () => {
  it("accepts only the closed prefix-search contract", () => {
    expect(Value.Check(SessionCatalogShareRouteSchema, SHARE_ROUTE)).toBe(true);
    for (const invalid of [
      { ...SHARE_ROUTE, kind: "future-route" },
      { ...SHARE_ROUTE, identifierAlphabet: "hex" },
      { ...SHARE_ROUTE, fullLength: 64 },
      { ...SHARE_ROUTE, minPrefixLength: 8 },
      { ...SHARE_ROUTE, lookup: "arbitrary-search" },
      { ...SHARE_ROUTE, ambiguity: "first-result" },
      { ...SHARE_ROUTE, unexpected: true },
    ]) {
      expect(Value.Check(SessionCatalogShareRouteSchema, invalid)).toBe(false);
    }
  });
});

describe("SessionsCatalogListResultSchema", () => {
  it("accepts a closed catalog result with hosts", () => {
    expect(
      Value.Check(SessionsCatalogListResultSchema, {
        catalogs: [
          {
            id: "claude",
            label: "Claude Code",
            capabilities: {
              continueSession: true,
              archive: false,
              createSession: {
                model: "anthropic/claude-opus-4-8",
                startTerminal: true,
              },
              openTerminal: true,
              startTerminal: true,
            },
            shareRoute: SHARE_ROUTE,
            hosts: [
              {
                hostId: "gateway:local",
                label: "Gateway",
                kind: "gateway",
                connected: true,
                canStartTerminal: true,
                sessions: [
                  {
                    threadId: "thread-1",
                    status: "idle",
                    archived: false,
                    createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                    canContinue: true,
                    canArchive: false,
                    canOpenTerminal: true,
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("SessionsCatalogStartTerminal schemas", () => {
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

    expect(Value.Check(SessionsCatalogStartTerminalParamsSchema, params)).toBe(true);
    expect(
      Value.Check(SessionsCatalogStartTerminalParamsSchema, { ...params, unexpected: true }),
    ).toBe(false);
    for (const invalid of [
      { argv: ["sh"] },
      { executable: "/bin/sh" },
      { env: {} },
      { cwd: "x".repeat(4097) },
      { initialMessage: "x".repeat(16385) },
    ]) {
      expect(Value.Check(SessionsCatalogStartTerminalParamsSchema, { ...params, ...invalid })).toBe(
        false,
      );
    }
    expect(Value.Check(SessionsCatalogStartTerminalResultSchema, result)).toBe(true);
    expect(
      Value.Check(SessionsCatalogStartTerminalResultSchema, { ...result, unexpected: true }),
    ).toBe(false);
  });
});

describe("SessionsCatalogImport schemas", () => {
  it("accepts a locator and closed import counts, including incomplete and unchanged results", () => {
    const params = {
      catalogId: "claude",
      hostId: "gateway:local",
      threadId: "thread-1",
      sourceHomeId: "home-1",
      agentId: "research",
    };
    const result = {
      sessionKey: "agent:research:imported-session",
      importedItems: 0,
      totalItems: 20,
      complete: false,
      created: false,
    };

    expect(Value.Check(SessionsCatalogImportParamsSchema, params)).toBe(true);
    for (const displayName of ["Imported native session", "x".repeat(500)]) {
      expect(Value.Check(SessionsCatalogImportParamsSchema, { ...params, displayName })).toBe(true);
    }
    for (const displayName of ["", "x".repeat(501)]) {
      expect(Value.Check(SessionsCatalogImportParamsSchema, { ...params, displayName })).toBe(
        false,
      );
    }
    expect(Value.Check(SessionsCatalogImportParamsSchema, { ...params, fork: true })).toBe(false);
    expect(Value.Check(SessionsCatalogImportResultSchema, result)).toBe(true);
    expect(
      Value.Check(SessionsCatalogImportResultSchema, {
        ...result,
        importedItems: 20,
        complete: true,
        created: true,
      }),
    ).toBe(true);
    for (const invalid of [
      { importedItems: -1 },
      { importedItems: 0.5 },
      { totalItems: -1 },
      { totalItems: 0.5 },
      { complete: "false" },
      { created: "false" },
      { unexpected: true },
    ]) {
      expect(Value.Check(SessionsCatalogImportResultSchema, { ...result, ...invalid })).toBe(false);
    }
  });
});

describe("SessionsCatalogListParamsSchema", () => {
  it("accepts only boolean metadata selection while retaining full-list defaults", () => {
    for (const params of [{}, { metadataOnly: false }, { metadataOnly: true }]) {
      expect(Value.Check(SessionsCatalogListParamsSchema, params)).toBe(true);
    }
    expect(Value.Check(SessionsCatalogListParamsSchema, { metadataOnly: "true" })).toBe(false);
  });
});

describe("SessionsCatalogHostEventSchema", () => {
  it("accepts one completed host and rejects unknown fields", () => {
    const event = {
      progressId: "progress-1",
      agentId: "main",
      catalog: {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [],
          },
        ],
      },
    };

    expect(Value.Check(SessionsCatalogHostEventSchema, event)).toBe(true);
    expect(
      Value.Check(SessionsCatalogHostEventSchema, {
        ...event,
        catalog: { ...event.catalog, hosts: [{ ...event.catalog.hosts[0], pending: true }] },
      }),
    ).toBe(true);
    expect(Value.Check(SessionsCatalogHostEventSchema, { ...event, unexpected: true })).toBe(false);
    expect(
      Value.Check(SessionsCatalogHostEventSchema, {
        ...event,
        catalog: { ...event.catalog, hosts: [] },
      }),
    ).toBe(false);
    expect(
      Value.Check(SessionsCatalogHostEventSchema, {
        ...event,
        catalog: { ...event.catalog, hosts: [event.catalog.hosts[0], event.catalog.hosts[0]] },
      }),
    ).toBe(false);
  });
});
