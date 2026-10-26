import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogEntrySnapshot } from "openclaw/plugin-sdk/session-catalog";
import { expect, it, vi } from "vitest";
import { adoptedSourceKey } from "./session-catalog-adoption.js";
import { listBoundClaudeSessions } from "./session-catalog-runtime.js";

type SessionEntry = ReturnType<
  OpenClawPluginApi["runtime"]["agent"]["session"]["listSessionEntries"]
>[number]["entry"];
const threadId = "shared-thread";
function session(sessionKey: string, entry: Partial<SessionEntry> = {}) {
  return {
    sessionKey,
    entry: { cliSessionBindings: { "claude-cli": { sessionId: threadId } }, ...entry },
  };
}

function apiFor(entries: { sessionKey: string; entry: Partial<SessionEntry> }[] = []) {
  const config = {};
  return {
    id: "anthropic",
    config,
    runtime: {
      config: { current: () => config },
      agent: { session: { listSessionEntries: () => entries } },
    },
  } as unknown as OpenClawPluginApi;
}

it("reuses revision-bound projections and reads unversioned entries every time", () => {
  const api = apiFor();
  const binding = { sessionId: "before" };
  const entries = [
    {
      agentId: "main",
      sessionKey: "agent:main:bound",
      entry: {
        sessionId: "local",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": binding },
      },
    },
  ];
  const snapshot: SessionCatalogEntrySnapshot = {
    revision: {},
    entriesForAgent: () => entries,
    entriesForCatalog: vi.fn(() => entries),
  };
  const lookup = () => listBoundClaudeSessions(api, "main", snapshot);
  const key = (id: string) => adoptedSourceKey("gateway:local", id);
  const before = lookup();
  expect(before.get(key("before"))?.sessionKey).toBe("agent:main:bound");
  expect(lookup()).toEqual(before);
  expect(snapshot.entriesForCatalog).toHaveBeenCalledTimes(1);
  binding.sessionId = "after";
  snapshot.revision = {};
  expect([...lookup().keys()]).toEqual([key("after")]);
  expect(snapshot.entriesForCatalog).toHaveBeenCalledTimes(2);
  delete snapshot.revision;
  lookup();
  binding.sessionId = "unversioned";
  expect(lookup().has(key("unversioned"))).toBe(true);
  expect(snapshot.entriesForCatalog).toHaveBeenCalledTimes(4);
});

it.each([
  [
    {
      pluginOwnerId: "anthropic",
      modelSelectionLocked: true,
      pluginExtensions: {
        anthropic: {
          sessionCatalog: { sourceHostId: "node:node-a", sourceThreadId: "shared-thread" },
        },
      },
    },
    true,
  ],
  [{ execHost: "node", execNode: "node-a" }, false],
] as const)("separates host bindings %j", (nodeEntry, nodeAdopted) => {
  const bound = listBoundClaudeSessions(
    apiFor([session("agent:main:local"), session("agent:main:node", nodeEntry)]),
  );

  expect(bound).toEqual(
    new Map([
      [
        adoptedSourceKey("gateway:local", threadId),
        { adopted: false, sessionKey: "agent:main:local" },
      ],
      [
        adoptedSourceKey("node:node-a", threadId),
        { adopted: nodeAdopted, sessionKey: "agent:main:node" },
      ],
    ]),
  );
});

it("keeps an adopted session on a source key a sibling agent's CLI binding shares", () => {
  const sessionKey = "plugin:anthropic:catalog-adopt:claude:adopted";
  const bound = listBoundClaudeSessions(
    apiFor([
      session(sessionKey, { pluginOwnerId: "anthropic", modelSelectionLocked: true }),
      // A later sibling binding must not displace the adopted owner of this source key.
      session("agent:other:routed"),
    ]),
  );

  expect(bound).toEqual(
    new Map([[adoptedSourceKey("gateway:local", threadId), { adopted: true, sessionKey }]]),
  );
});
