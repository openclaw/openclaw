import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import {
  buildCompactionFloor,
  commitCompactionSummary,
  stripSummaryFloor,
} from "./compaction-floor.js";

const user = (text: string, extra: Record<string, unknown> = {}): AgentMessage =>
  ({ role: "user", content: text, timestamp: 1, ...extra }) as AgentMessage;
const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage;

describe("buildCompactionFloor", () => {
  it("keeps attributed user-role words, identifiers, and the last reply", () => {
    const floor = buildCompactionFloor([
      user("Build acme/widget-oauth and never publish it", { __openclaw: { senderId: "u1" } }),
      user("Keep the beta flag", { __openclaw: { senderId: "u2" } }),
      user("publish the artifact", { provenance: { kind: "inter_session" } }),
      assistant("Opened #48213 at deadbeef1234, see https://example.com/reports/48213"),
    ]);
    expect(floor).toContain('[User sender={"id":"u1"}]: Build acme/widget-oauth');
    expect(floor).toContain('[User sender={"id":"u2"}]: Keep the beta flag');
    expect(floor).toContain("[Inter-session input]: publish the artifact");
    expect(floor).toContain("- repo: acme/widget-oauth");
    expect(floor).toContain("- pr: 48213");
    expect(floor).toContain("- url: https://example.com/reports/48213");
  });

  it("is deterministic, bounded, and counts user messages it cannot show", () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      user(`request ${index} ${"detail ".repeat(60)}`),
    );
    const floor = buildCompactionFloor(messages, 2_000);
    expect(floor).toBe(buildCompactionFloor(messages, 2_000));
    expect(floor.length).toBeLessThanOrEqual(2_000);
    expect(floor).toMatch(/\[\d+ older user message\(s\) not shown\]/);
    expect(floor).toContain("request 199");
  });

  it("redacts credential shapes and returns nothing for tool-only regions", () => {
    expect(buildCompactionFloor([user("use token=deadbeef12345678 here")])).not.toContain(
      "deadbeef12345678",
    );
    const toolOnly: AgentMessage = {
      role: "toolResult",
      toolCallId: "c",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 1,
    };
    expect(buildCompactionFloor([toolOnly])).toBe("");
  });

  it("appends a bounded floor after a summary, yields to the token budget, and strips cleanly", () => {
    const messages = Array.from({ length: 200 }, (_, index) =>
      user(`request ${index} ${"detail ".repeat(60)}`),
    );
    const commit = (maxSummaryChars?: number, summaryTokenBudget?: number, refused = false) =>
      commitCompactionSummary(
        {
          summary: "SUMMARY",
          ...(refused
            ? { details: { readFiles: [], modifiedFiles: [], summaryRefused: true } }
            : {}),
        },
        {
          messagesToSummarize: messages,
          turnPrefixMessages: [],
          summaryTokenBudget,
          settings: { maxSummaryChars },
        },
        false,
      );
    const withFloor = commit();
    expect(withFloor.startsWith("SUMMARY\n\n---")).toBe(true);
    expect(withFloor).toContain("request 199");
    expect(withFloor.length).toBeLessThanOrEqual("SUMMARY".length + 6_200);
    expect(stripSummaryFloor(withFloor)).toBe("SUMMARY");
    expect(commit(1_000).length).toBeLessThan(1_300);
    expect(commit(undefined, 2)).toBe("SUMMARY");
    expect(commit(undefined, undefined, true)).toBe("SUMMARY");
  });
});
