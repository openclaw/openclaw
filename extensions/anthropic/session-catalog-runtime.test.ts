import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { adoptedSourceKey } from "./session-catalog-adoption.js";
import { listBoundClaudeSessions } from "./session-catalog-runtime.js";

describe("Claude bound session resolution", () => {
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
  it("keeps an adopted session adopted while its turn is in flight", () => {
    const threadId = "adopted-running-thread";
    const catalogEntry = (agentId: string, sessionKey: string, entry: Record<string, unknown>) => ({
      agentId,
      sessionKey,
      entry,
    });
    const api = {
      id: "anthropic",
      config: {},
      runtime: { config: { current: () => ({}) } },
    } as unknown as OpenClawPluginApi;
    const sessionEntries = {
      entriesForAgent: () => [],
      entriesForCatalog: () => [
        {
          ...catalogEntry("main", "plugin:anthropic:catalog-adopt:claude:running", {
            pluginOwnerId: "anthropic",
            modelSelectionLocked: true,
            cliSessionBindings: { "claude-cli": { sessionId: threadId } },
          }),
          activeNativeSession: { backendId: "claude-cli", hostId: "gateway:local", threadId },
        },
        catalogEntry("other", "agent:other:routed", {
          cliSessionBindings: { "claude-cli": { sessionId: threadId } },
        }),
      ],
    };

    expect(listBoundClaudeSessions(api, undefined, sessionEntries as never)).toEqual(
      new Map([
        [
          adoptedSourceKey("gateway:local", threadId),
          { adopted: true, sessionKey: "plugin:anthropic:catalog-adopt:claude:running" },
        ],
      ]),
    );
  });
});
