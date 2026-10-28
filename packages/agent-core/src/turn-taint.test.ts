import { expect, it } from "vitest";
import { user } from "./agent-loop.test-support.js";
import { isActiveTurnTainted, withToolResultContentSource } from "./turn-taint.js";
import type { AgentMessage } from "./types.js";

it("checks current turn taint without reading history before its user boundary", () => {
  const result = {
    role: "toolResult" as const,
    toolCallId: "call-ready",
    toolName: "read",
    content: [{ type: "text" as const, text: "ready" }],
    isError: false,
    timestamp: 1,
  };
  const messages: AgentMessage[] = Array.from({ length: 1000 }, () => user("earlier turn"));
  messages.push(user("current turn"), result);
  let historicalReads = 0;
  const observed = new Proxy(messages, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key) && Number(key) < 1000) {
        historicalReads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  expect(isActiveTurnTainted(observed)).toBe(false);
  messages[1001] = withToolResultContentSource(result, "network");
  expect(isActiveTurnTainted(observed)).toBe(true);
  messages.push(user("next turn"));
  expect(isActiveTurnTainted(observed)).toBe(false);
  expect(historicalReads).toBe(0);
});
