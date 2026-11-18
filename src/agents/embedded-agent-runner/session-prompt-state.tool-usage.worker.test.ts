import { expect, it } from "vitest";
import { seedUnindexedTranscriptForTest } from "../../config/sessions/session-accessor.sqlite-import.test-support.js";
import {
  flushAgentToolUsage,
  importAgentToolUsage,
  readAgentToolUsage,
} from "../../config/sessions/tool-usage.js";
import { seedAgentToolUsageRunForTest } from "../../config/sessions/tool-usage.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildCodeModeCatalogPrompt } from "../code-mode.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { registerHeadlessToolSearchCatalog } from "../tool-search-catalog.js";
import { buildToolSchemaDirectoryPrompt } from "../tool-search-directory.js";
import type { ToolSearchCatalogRef } from "../tool-search-types.js";
import type { ToolUsageRankingSnapshot } from "../tool-usage-ranking.js";
import { decayToolUsage } from "../tool-usage.js";
import {
  buildSystemPromptRouteKey,
  persistSessionSystemPrompt,
  prepareSessionSystemPrompt,
  prepareSessionToolUsageRanking,
  retainEmbeddedSessionPromptState,
} from "./session-prompt-state.js";

it("imports stored transcript calls into both real listings and freezes bytes while worker scores change", async () => {
  await withOpenClawTestState(
    { label: "usage-ranked-prefix", scenario: "minimal" },
    async ({ env }) => {
      const now = Date.UTC(2026, 10, 1);
      const hot = "zzz_fixture_hot";
      const later = "zzz_fixture_later";
      const hotId = `openclaw:core:${hot}`;
      const laterId = `openclaw:core:${later}`;
      const options = { agentId: "main", env, now };
      const tools = [
        ...Array.from({ length: 100 }, (_, index) => `fixture_${String(index).padStart(3, "0")}`),
        hot,
        later,
      ].map((name) =>
        Object.assign(createStubTool(name), {
          description: "Search a synthetic collection. ".repeat(10),
          parameters: {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 8 }, (_, index) => [
                `collection_filter_scope_${index}`,
                { type: "string" },
              ]),
            ),
          },
        }),
      );
      const ref: ToolSearchCatalogRef = {};
      registerHeadlessToolSearchCatalog({ catalogRef: ref, tools });
      const catalog = ref.current!.entries;
      const ctx = { catalogRef: ref };
      const render = (usageRanking?: ToolUsageRankingSnapshot) => [
        buildCodeModeCatalogPrompt(ctx, catalog, usageRanking),
        buildToolSchemaDirectoryPrompt(ctx, { usageRanking, contextTokenBudget: 7680 }),
      ];
      const baseline = render();
      baseline.forEach((text) => expect(text).not.toContain(hot));
      await seedUnindexedTranscriptForTest({
        agentId: "main",
        env,
        sessionKey: "agent:main:usage-prefix-fixture",
        entry: { sessionId: "usage-prefix-fixture", updatedAt: now },
        events: [
          {
            session_id: "usage-prefix-fixture",
            seq: 0,
            created_at: now - 101,
            event_json: JSON.stringify({
              type: "message",
              id: "call",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "toolCall",
                    id: "target-call",
                    name: "dispatch_action",
                    arguments: { id: hotId },
                  },
                ],
              },
            }),
          },
          {
            session_id: "usage-prefix-fixture",
            seq: 1,
            created_at: now - 100,
            event_json: JSON.stringify({
              type: "message",
              id: "result",
              parentId: "call",
              message: {
                role: "toolResult",
                toolName: "dispatch_action",
                toolCallId: "target-call",
                isError: false,
                content: [],
                timestamp: now - 100,
              },
            }),
          },
        ],
      });
      expect((await importAgentToolUsage({ ...options, catalog })).successfulCalls).toBe(1);
      const { generation } = await seedAgentToolUsageRunForTest(options);
      const entries: SessionEntry[] = [];
      const routeKey = buildSystemPromptRouteKey({
        provider: "synthetic",
        model: "fixture",
        harness: "openclaw",
        surface: "tools",
      });
      let reads = 0;
      const readRankedIds = async () => {
        reads++;
        return (await readAgentToolUsage(options))
          .toSorted(
            (a, b) =>
              decayToolUsage(b, now) - decayToolUsage(a, now) || a.toolId.localeCompare(b.toolId),
          )
          .map((row) => row.toolId);
      };
      const lease = retainEmbeddedSessionPromptState("usage-worker-prefix");
      const input = {
        state: lease.state,
        routeKey,
        entries,
        enabled: true,
        catalogIds: catalog.map((entry) => entry.id),
        now,
        readRankedIds,
      };
      try {
        const snapshot = await prepareSessionToolUsageRanking(input);
        const initial = render(snapshot);
        initial.forEach((text) => expect(text).toContain(hot));
        initial.forEach((text) => expect(text).not.toContain(later));
        prepareSessionSystemPrompt({ ...input, systemPrompt: initial.join("\n\n") }).commit();
        await persistSessionSystemPrompt(lease.state, async (customType, data) => {
          entries.push({
            type: "custom",
            customType,
            data: structuredClone(data),
            id: "frozen",
            parentId: null,
            timestamp: new Date(now).toISOString(),
          });
        });
        for (let turn = 1; turn <= 3; turn++) {
          await flushAgentToolUsage({
            ...options,
            generation,
            rows: [{ toolId: laterId, score: 10, updatedAt: now + turn }],
          });
          const frozen = await prepareSessionToolUsageRanking({ ...input, now: now + turn });
          expect(render(frozen)).toEqual(initial);
        }
        expect(
          (await readAgentToolUsage(options)).find((row) => row.toolId === laterId)?.score,
        ).toBeGreaterThan(29);
        expect(reads).toBe(1);
        entries.push({
          type: "compaction",
          id: "compacted",
          parentId: "frozen",
          timestamp: new Date(now + 10).toISOString(),
          summary: "Synthetic compaction",
          firstKeptEntryId: "frozen",
          tokensBefore: 1000,
        });
        const refreshed = await prepareSessionToolUsageRanking({ ...input, now: now + 10 });
        expect(reads).toBe(2);
        render(refreshed).forEach((text) => expect(text).toContain(later));
        expect(render(undefined)).toEqual(baseline);
        expect(render({ version: 1, at: now, orderedToolIds: [] })).toEqual(baseline);
      } finally {
        lease[Symbol.dispose]();
      }
    },
  );
});
