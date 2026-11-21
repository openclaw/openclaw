import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import { createTestPluginGatewayRuntime } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  normalizeSessionDeliveryState,
  resolveStorePath,
  updateLastRoute,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { resetMemoryToolMockState, setMemorySearchImpl } from "./memory-tool-manager.test-mocks.js";
import * as sessionVisibility from "./session-search-visibility.js";
import { testing as memoryToolsTesting } from "./tools.js";
import { asOpenClawConfig, createMemorySearchToolOrThrow } from "./tools.test-helpers.js";

const recalls = vi.hoisted(() => ({
  recordShortTermRecalls: vi.fn(async (_params: unknown) => {}),
}));
// mock-isolation: keep recall persistence observable without writing promotion state.
vi.mock("./short-term-promotion-record.js", () => recalls);

it.each(["route", "incarnation", "new-alias"] as const)(
  "withholds transcript citations and recall effects after %s revocation during wiki aggregation",
  async (change) => {
    await withOpenClawTestState({ label: "memory-channel-final-disclosure" }, async (state) => {
      clearMemoryPluginState();
      resetMemoryToolMockState();
      memoryToolsTesting.resetMemorySearchToolCooldowns();
      recalls.recordShortTermRecalls.mockClear();
      const requester = "agent:main:slack:channel:c111:thread:1.001";
      const revoked = "agent:main:slack:channel:c111:thread:1.002";
      const retained = "agent:main:slack:channel:c111:thread:1.003";
      const cfg = asOpenClawConfig({
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        tools: { sessions: { visibility: "channel" } },
        memory: {
          citations: "on",
          search: { sources: ["memory", "sessions"], experimental: { sessionMemory: true } },
        },
        plugins: { entries: { "memory-core": { config: { dreaming: { enabled: true } } } } },
      });
      const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      const store = async (sessionKey: string, sessionId: string, to = "channel:c111") => {
        await upsertSessionEntry({
          agentId: "main",
          storePath,
          sessionKey,
          entry: {
            sessionId,
            updatedAt: 1,
            chatType: "channel",
            space: "t111",
            delivery: normalizeSessionDeliveryState({
              context: { channel: "slack", accountId: "default", to },
              origin: { provider: "slack", accountId: "default", chatType: "channel" },
            }),
          },
        });
      };
      for (const { sessionKey, sessionId } of [
        { sessionKey: requester, sessionId: "requester" },
        { sessionKey: revoked, sessionId: "revoked" },
        { sessionKey: retained, sessionId: "retained" },
      ]) {
        await store(sessionKey, sessionId);
      }
      const hit = (id: string, source: "memory" | "sessions" = "sessions"): MemorySearchResult => ({
        path: source === "sessions" ? `sessions/main/${id}.jsonl` : `memory/${id}.md`,
        source,
        snippet: `${id}-synthetic-evidence`,
        score: 0.9,
        startLine: 1,
        endLine: 2,
      });
      setMemorySearchImpl(async () => [hit("revoked"), hit("retained"), hit("durable", "memory")]);
      const tool = createMemorySearchToolOrThrow({
        config: cfg,
        agentId: "main",
        agentSessionKey: requester,
      });
      const gateway = await createTestPluginGatewayRuntime({
        pluginId: "memory-core",
        config: cfg,
      });
      const wikiEntered = createDeferred<void>();
      const releaseWiki = createDeferred<void>();
      const filtered = createDeferred<void>();
      let execution: ReturnType<typeof tool.execute> | undefined;
      try {
        const positive = await gateway.runInGatewayScope(() =>
          tool.execute("before-revocation", { query: "synthetic" }),
        );
        expect(JSON.stringify(positive)).toContain("revoked-synthetic-evidence");
        expect(JSON.stringify(positive)).toContain("retained-synthetic-evidence");
        await vi.dynamicImportSettled();
        recalls.recordShortTermRecalls.mockClear();
        const filter = sessionVisibility.filterMemorySearchHitsBySessionVisibility;
        using observed = vi
          .spyOn(sessionVisibility, "filterMemorySearchHitsBySessionVisibility")
          .mockImplementation(async (params) => {
            const results = await filter(params);
            filtered.resolve();
            return results;
          });
        registerMemoryCorpusSupplement("synthetic-wiki", {
          search: async () => {
            wikiEntered.resolve();
            await releaseWiki.promise;
            return [
              {
                corpus: "wiki",
                path: "entities/public.md",
                snippet: "wiki-synthetic-evidence",
                score: 0.5,
              },
            ];
          },
          get: async () => null,
        });
        execution = gateway.runInGatewayScope(() =>
          tool.execute("revoked-during-wiki", { query: "synthetic", corpus: "all", maxResults: 6 }),
        );
        await Promise.all([wikiEntered.promise, filtered.promise]);
        expect(observed).toHaveBeenCalled();
        if (change === "route") {
          await updateLastRoute({
            storePath,
            sessionKey: revoked,
            channel: "slack",
            accountId: "default",
            to: "channel:c222",
            createIfMissing: false,
          });
        } else if (change === "incarnation") {
          await store(revoked, "replacement");
        } else {
          await store("agent:main:slack:channel:c222:thread:1.004", "revoked", "channel:c222");
        }
        releaseWiki.resolve();
        const result = await execution;
        const output = JSON.stringify(result);
        expect(output).toContain("retained-synthetic-evidence");
        expect(output).toContain("wiki-synthetic-evidence");
        expect(output).toContain("durable-synthetic-evidence");
        expect(output).not.toContain("revoked-synthetic-evidence");
        expect(output).not.toContain("sessions/main/revoked.jsonl");
        await vi.dynamicImportSettled();
        expect(recalls.recordShortTermRecalls).toHaveBeenCalled();
        const bookkeeping = JSON.stringify(recalls.recordShortTermRecalls.mock.calls);
        expect(bookkeeping).toContain("retained-synthetic-evidence");
        expect(bookkeeping).not.toContain("revoked-synthetic-evidence");
      } finally {
        releaseWiki.resolve();
        await execution?.catch(() => {});
        await gateway.close();
        clearMemoryPluginState();
      }
    });
  },
);
