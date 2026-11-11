import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import { buildCompactionFloor } from "./compaction-floor.js";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 1 }) as AgentMessage;

describe("buildCompactionFloor", () => {
  it("keeps user words, referenced identifiers, and the last reply", () => {
    const floor = buildCompactionFloor([
      user("Build the plugin in acme/widget-oauth and never publish it"),
      assistant("Opened #48213 at deadbeef1234 for acme/widget-oauth"),
    ]);
    expect(floor).toContain("never publish it");
    expect(floor).toContain("- repo: acme/widget-oauth");
    expect(floor).toContain("- pr: 48213");
    expect(floor).toContain("Opened #48213");
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
    expect(buildCompactionFloor([user("use token=abcdefgh12345678 here")])).not.toContain(
      "abcdefgh12345678",
    );
    expect(
      buildCompactionFloor([
        {
          role: "toolResult",
          toolCallId: "c",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: 1,
        } as AgentMessage,
      ]),
    ).toBe("");
  });
});
