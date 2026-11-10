import { expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { extractOpaqueIdentifiers } from "./compaction-safeguard-quality.js";
import {
  arraySafeguardSource,
  buildSplitTurnContextSectionFromSource,
  prepareCompactionSafeguardSource,
  type SafeguardMessageSource,
} from "./compaction-safeguard-source.js";

// A snapshot may release its previously parsed row on every access. No planner
// result may rely on that row staying alive until the summarizer finishes.
function transientSource(
  messages: AgentMessage[],
  onRead?: (index: number) => void,
): SafeguardMessageSource {
  let revoke = () => {};
  return {
    ...arraySafeguardSource(messages),
    get(index) {
      onRead?.(index);
      revoke();
      const message = messages[index];
      if (!message) {
        return undefined;
      }
      const current = Proxy.revocable(message, {});
      revoke = current.revoke;
      return current.proxy;
    },
  };
}

it("prepares complete safeguard facts without retaining hydrated transcript messages", () => {
  const history: AgentMessage[] = [
    { role: "user", content: "Investigate service failure abcdef123456.", timestamp: 1 },
    makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "read-1", name: "read", arguments: { path: "/tmp/service.log" } },
      ],
    }),
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "failed to read service log" }],
      isError: true,
      timestamp: 2,
    },
    { role: "user", content: "Repair the service now.", timestamp: 3 },
    makeAgentAssistantMessage({ content: [{ type: "text", text: "Repair started." }] }),
  ];
  const source = prepareCompactionSafeguardSource({
    history: transientSource(history),
    turnPrefix: transientSource([]),
    isSplitTurn: false,
    recentTurnsPreserve: 1,
    qualityGuardEnabled: true,
  });
  expect(source.hasRealConversation).toBe(true);
  expect(source.latestUserAsk).toBe("Repair the service now.");
  expect(source.requiredAskContext).toBe("Repair the service now.");
  expect(source.identifiers).toContain("ABCDEF123456");
  expect(source.toolFailureSection).toBe(
    "\n\n## Tool Failures\n- read: failed to read service log",
  );
  expect(source.preservedTurnsSection.text).toBe(
    "\n\n## Recent turns preserved verbatim\n- User: Repair the service now.\n- Assistant: Repair started.",
  );
  expect(source.reconciliation.length).toBe(5);
  expect(source.reconciliation.get(0)?.role).toBe("user");
  expect(source.reconciliation.get(2)?.role).toBe("toolResult");

  const split = buildSplitTurnContextSectionFromSource(transientSource(history));
  expect(split.text).toContain("- Tool result (read): failed to read service log");
  expect(split.text).toContain("- User: Investigate service failure abcdef123456.");
  expect(split.segmentStarts).toHaveLength(4);
});

it("does not summarize an orphan-only older slice beside a preserved turn", () => {
  const source = prepareCompactionSafeguardSource({
    history: transientSource([
      {
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "read",
        content: [{ type: "text", text: "old output" }],
        isError: false,
        timestamp: 0,
      },
      { role: "user", content: "Keep working", timestamp: 1 },
    ]),
    turnPrefix: transientSource([]),
    isSplitTurn: false,
    recentTurnsPreserve: 1,
    qualityGuardEnabled: false,
  });
  expect(source.reconciliation.length).toBe(0);
  expect(source.preservedTurnsSection.text).toContain("Keep working");
});

it.each([100, 1000])(
  "reads only bounded retained payloads from a %i-message active window",
  (count) => {
    const messages: AgentMessage[] = [
      { role: "user", content: "First request", timestamp: 0 },
      { role: "user", content: "Second request", timestamp: 1 },
      { role: "user", content: "Current request", timestamp: 2 },
      ...Array.from({ length: count }, (_, index) =>
        makeAgentAssistantMessage({
          content: [
            { type: "text", text: `row-${index.toString().padStart(4, "0")}: ${"x".repeat(900)}` },
          ],
        }),
      ),
    ];
    let reads = 0;
    const source = prepareCompactionSafeguardSource({
      history: transientSource(messages, () => {
        reads++;
      }),
      turnPrefix: transientSource([]),
      isSplitTurn: false,
      recentTurnsPreserve: 3,
      qualityGuardEnabled: true,
    });
    // Three user turns preserve the entire active window. Rendering must stop at
    // the section budget, not reparse every preserved row or scan backwards for the ask.
    expect(reads).toBeLessThanOrEqual(30);
    expect(source.reconciliation.length).toBe(messages.length);
    expect(source.latestUserAsk).toBe("Current request");
    expect(source.hasRealConversation).toBe(true);
    expect(source.preservedTurnsSection.truncatedLoss).toBe("preserved-turn-head");
    expect(source.preservedTurnsSection.segmentStarts).toHaveLength(12);
    expect(source.preservedTurnsSection.text).toContain(
      `row-${(count - 1).toString().padStart(4, "0")}`,
    );
    expect(source.preservedTurnsSection.text).toContain(
      `row-${(count - 12).toString().padStart(4, "0")}`,
    );
    expect(source.preservedTurnsSection.text).not.toContain(
      `row-${(count - 13).toString().padStart(4, "0")}`,
    );
  },
);

it("extracts ordered unique identifiers without reading beyond the audit limit", () => {
  function* outputs() {
    yield "abcdef123456 abcdef123456";
    yield "ABCDEF123456 https://example.test/first";
    for (let index = 0; index < 10; index++) {
      yield `https://example.test/item-${index}`;
    }
    throw new Error("must not fetch another large tool output once the audit is full");
  }
  expect(extractOpaqueIdentifiers(outputs())).toEqual([
    "ABCDEF123456",
    "https://example.test/first",
    ...Array.from({ length: 10 }, (_, index) => `https://example.test/item-${index}`),
  ]);
});
