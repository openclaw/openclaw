import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogEntrySnapshot } from "openclaw/plugin-sdk/session-catalog";
import { describe, expect, it, vi } from "vitest";
import { adoptedSourceKey } from "./session-catalog-adoption.js";
import { listBoundClaudeSessions } from "./session-catalog-runtime.js";

describe("Claude bound session resolution", () => {
  it("reuses revision-bound projections and reads unversioned entries every time", () => {
    const config = {};
    const api = { id: "anthropic", config, runtime: {} } as OpenClawPluginApi;
    const entries = [
      {
        agentId: "main",
        sessionKey: "agent:main:bound",
        entry: {
          sessionId: "local",
          updatedAt: 1,
          cliSessionBindings: { "claude-cli": { sessionId: "before" } },
        },
      },
    ];
    const snapshot: SessionCatalogEntrySnapshot = {
      revision: {},
      entriesForAgent: () => entries,
      entriesForCatalog: vi.fn(() => entries),
    };
    const before = listBoundClaudeSessions(api, "main", snapshot);
    expect(before.get(adoptedSourceKey("gateway:local", "before"))?.sessionKey).toBe(
      "agent:main:bound",
    );
    expect(listBoundClaudeSessions(api, "main", snapshot)).toEqual(before);
    expect(snapshot.entriesForCatalog).toHaveBeenCalledTimes(1);
    entries[0]!.entry.cliSessionBindings["claude-cli"].sessionId = "after";
    snapshot.revision = {};
    const after = listBoundClaudeSessions(api, "main", snapshot);
    expect(after.has(adoptedSourceKey("gateway:local", "before"))).toBe(false);
    expect(after.has(adoptedSourceKey("gateway:local", "after"))).toBe(true);
    expect(snapshot.entriesForCatalog).toHaveBeenCalledTimes(2);
    delete snapshot.revision;
    listBoundClaudeSessions(api, "main", snapshot);
    entries[0]!.entry.cliSessionBindings["claude-cli"].sessionId = "unversioned";
    expect(
      listBoundClaudeSessions(api, "main", snapshot).has(
        adoptedSourceKey("gateway:local", "unversioned"),
      ),
    ).toBe(true);
    expect(snapshot.entriesForCatalog).toHaveBeenCalledTimes(4);
  });

  it.each([
    {
      label: "catalog marker",
      nodeAdopted: true,
      nodeEntry: {
        pluginOwnerId: "anthropic",
        modelSelectionLocked: true,
        pluginExtensions: {
          anthropic: {
            sessionCatalog: { sourceHostId: "node:node-a", sourceThreadId: "shared-thread" },
          },
        },
      },
    },
    {
      label: "exec binding",
      nodeAdopted: false,
      nodeEntry: { execHost: "node", execNode: "node-a" },
    },
  ])("keeps local and paired-node bindings distinct via $label", ({ nodeAdopted, nodeEntry }) => {
    const threadId = "shared-thread";
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        agent: {
          session: {
            listSessionEntries: () => [
              {
                sessionKey: "agent:main:local",
                entry: { cliSessionBindings: { "claude-cli": { sessionId: threadId } } },
              },
              {
                sessionKey: "agent:main:node",
                entry: {
                  cliSessionBindings: { "claude-cli": { sessionId: threadId } },
                  ...nodeEntry,
                },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawPluginApi;

    expect(listBoundClaudeSessions(api)).toEqual(
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
    const threadId = "shared-thread";
    const api = {
      id: "anthropic",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        agent: {
          session: {
            listSessionEntries: () => [
              {
                sessionKey: "plugin:anthropic:catalog-adopt:claude:adopted",
                entry: {
                  cliSessionBindings: { "claude-cli": { sessionId: threadId } },
                  pluginOwnerId: "anthropic",
                  modelSelectionLocked: true,
                },
              },
              // Listed last on purpose: the source key carries no agent, so
              // last-write-wins would report this thread unadopted and drop the
              // adopted row out of the catalog entirely.
              {
                sessionKey: "agent:other:routed",
                entry: { cliSessionBindings: { "claude-cli": { sessionId: threadId } } },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawPluginApi;

    expect(listBoundClaudeSessions(api)).toEqual(
      new Map([
        [
          adoptedSourceKey("gateway:local", threadId),
          { adopted: true, sessionKey: "plugin:anthropic:catalog-adopt:claude:adopted" },
        ],
      ]),
    );
  });
});
