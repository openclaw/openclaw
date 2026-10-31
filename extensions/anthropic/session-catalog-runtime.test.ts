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

it("skips catalog metadata for unrelated sessions and resolves the plugin identity once", () => {
  const metadata = vi.fn(() => undefined);
  const entries = Array.from({ length: 100 }, (_, index) => ({
    sessionKey: `agent:main:ordinary-${index}`,
    entry: {
      sessionId: `ordinary-${index}`,
      updatedAt: index,
      get pluginExtensions() {
        return metadata();
      },
      get execHost() {
        return metadata();
      },
    },
  }));
  const api = apiFor(entries);
  const identity = vi.fn(() => "anthropic");
  Object.defineProperty(api, "id", { get: identity });
  expect(listBoundClaudeSessions(api)).toEqual(new Map());
  expect(metadata).not.toHaveBeenCalled();
  expect(identity).toHaveBeenCalledTimes(1);
});

it.each([
  [
    {
      pluginOwnerId: "anthropic",
      modelSelectionLocked: true,
      cliSessionBindings: {},
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

it("requires locked adoption for marker fallback while preserving valid CLI bindings", () => {
  const marker: Partial<SessionEntry> = {
    pluginOwnerId: "anthropic",
    modelSelectionLocked: true,
    cliSessionBindings: {},
    pluginExtensions: {
      anthropic: { sessionCatalog: { sourceThreadId: "" } },
    },
  };
  const bound = listBoundClaudeSessions(
    apiFor([
      session("agent:main:empty-source", marker),
      session("agent:main:unlocked", { ...marker, modelSelectionLocked: false }),
      session("agent:main:foreign", { ...marker, pluginOwnerId: "other" }),
      session("agent:main:missing-marker", { ...marker, pluginExtensions: {} }),
      session("agent:main:routed", {
        ...marker,
        pluginOwnerId: "other",
        modelSelectionLocked: false,
        cliSessionBindings: { "claude-cli": { sessionId: threadId } },
      }),
    ]),
  );
  expect(bound).toEqual(
    new Map([
      [
        adoptedSourceKey("gateway:local", ""),
        { adopted: true, sessionKey: "agent:main:empty-source" },
      ],
      [
        adoptedSourceKey("gateway:local", threadId),
        { adopted: false, sessionKey: "agent:main:routed" },
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
