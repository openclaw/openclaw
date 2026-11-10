import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { SessionsMessagesSubscribeParamsSchema } from "./sessions.js";

it("accepts bounded initial history for the subscribed session only", () => {
  const params = { key: "agent:main:chat", subscriptionId: "foreground" };
  expect(Value.Check(SessionsMessagesSubscribeParamsSchema, params)).toBe(true);
  expect(
    Value.Check(SessionsMessagesSubscribeParamsSchema, {
      ...params,
      initialHistory: {
        cursor: "retained-cursor",
        knownState: { pendingInputs: "receipt" },
        limit: 80,
        maxBytes: 256 * 1024,
        toolResultMaxChars: 2_000,
        inputRunIds: ["pending-run"],
      },
    }),
  ).toBe(true);
  for (const initialHistory of [
    { sessionKey: "agent:main:another-chat" },
    { agentId: "another-agent" },
    { limit: 0 },
    { maxBytes: 1 },
    { inputRunIds: [] },
  ]) {
    expect(Value.Check(SessionsMessagesSubscribeParamsSchema, { ...params, initialHistory })).toBe(
      false,
    );
  }
});
