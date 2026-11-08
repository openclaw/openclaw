import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionProvider } from "../../plugins/compaction-provider.js";
import {
  requireActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "../../plugins/runtime.js";
import {
  configuredSession,
  createCompactionEvent,
  expectCompactionResult,
  runCompactionScenario,
  testing,
  toolCallMessage,
  toolResultMessage,
  userMessage,
} from "./compaction-safeguard.test-support.js";

const { MAX_COMPACTION_SUMMARY_CHARS, SUMMARY_TRUNCATED_MARKER } = testing;

afterEach(() => resetPluginRuntimeStateForTest());

function installCompactionProviderForTest(
  id: string,
  summarize: CompactionProvider["summarize"],
): void {
  requireActivePluginRegistry().compactionProviders.push({
    provider: { id, label: id, summarize },
  });
}

describe("compaction-safeguard generated summary priority", () => {
  it("keeps a generated summary whole when verbatim preserved turns overflow the cap", async () => {
    const body = `BODY-START${"b".repeat(10_000)}BODY-END`;
    installCompactionProviderForTest("body-priority-provider", vi.fn().mockResolvedValue(body));
    const session = configuredSession({
      provider: "body-priority-provider",
      recentTurnsPreserve: 6,
    });
    const messagesToSummarize = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `preserved-${index}-${"p".repeat(580)}`,
      timestamp: index + 1,
    })) as AgentMessage[];
    const { result } = await runCompactionScenario(
      session,
      createCompactionEvent({ preparation: { messagesToSummarize } }),
      {
        apiKey: null,
      },
    );
    const { summary } = expectCompactionResult(result);
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(body);
    expect(summary).not.toContain(SUMMARY_TRUNCATED_MARKER);
    expect(summary).toContain(`BODY-END\n\n## Recent turns preserved verbatim`);
    expect(summary).toContain("preserved-11-");
    expect(summary).not.toContain("preserved-0-");
  });

  it("keeps only a head excerpt of preserved tool output", async () => {
    installCompactionProviderForTest(
      "tool-excerpt-provider",
      vi.fn().mockResolvedValue("provider body"),
    );
    const session = configuredSession({
      provider: "tool-excerpt-provider",
      recentTurnsPreserve: 1,
    });
    const output = `tool-head-${"o".repeat(150)}tool-tail-${"t".repeat(400)}`;
    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: [
          userMessage("read the file", 1),
          toolCallMessage("excerpt_call", "read", 2),
          toolResultMessage("excerpt_call", output, { toolName: "read", timestamp: 3 }),
        ],
      },
    });
    const { result } = await runCompactionScenario(session, event, { apiKey: null });
    const { summary } = expectCompactionResult(result);
    expect(summary).toContain("- Tool result (read): tool-head-");
    expect(summary).toContain(`[${output.length - 160} more chars omitted at compaction]`);
    expect(summary).not.toContain("tool-tail-");
  });
});
