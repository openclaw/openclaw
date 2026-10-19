import type { TSchema } from "typebox";
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

function check(schema: TSchema, value: Record<string, unknown>, invalid: object[] = []) {
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
    check(SessionCatalogShareRouteSchema, SHARE_ROUTE, [
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
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      canContinue: true,
      canArchive: false,
      canOpenTerminal: true,
    };
    check(SessionsCatalogListResultSchema, {
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

    check(SessionsCatalogStartTerminalParamsSchema, params, [
      { unexpected: true },
      { argv: ["sh"] },
      { executable: "/bin/sh" },
      { env: {} },
      { cwd: "x".repeat(4097) },
      { initialMessage: "x".repeat(16385) },
    ]);
    check(SessionsCatalogStartTerminalResultSchema, result, [{ unexpected: true }]);
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

    check(SessionsCatalogImportParamsSchema, params, [
      { displayName: "" },
      { displayName: "x".repeat(501) },
      { fork: true },
    ]);
    for (const displayName of ["Imported native session", "x".repeat(500)]) {
      check(SessionsCatalogImportParamsSchema, { ...params, displayName });
    }
    check(SessionsCatalogImportResultSchema, {
      ...result,
      importedItems: 20,
      complete: true,
      created: true,
    });
    check(SessionsCatalogImportResultSchema, result, [
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
    check(SessionsCatalogListParamsSchema, {}, [{ metadataOnly: "true" }]);
    for (const metadataOnly of [false, true]) {
      check(SessionsCatalogListParamsSchema, { metadataOnly });
    }
  });

  it("accepts one completed host and rejects unknown fields", () => {
    const event = { progressId: "progress-1", agentId: "main", catalog };

    check(SessionsCatalogHostEventSchema, event, [
      { unexpected: true },
      ...[[], [host, host]].map((hosts) => ({ catalog: { ...event.catalog, hosts } })),
    ]);
    check(SessionsCatalogHostEventSchema, {
      ...event,
      catalog: { ...event.catalog, hosts: [{ ...host, pending: true }] },
    });
  });
});
