import { expect, it, vi } from "vitest";
import { createSteeredCliMessageInjection } from "./execute-plugin.steered-transcript.js";

it("starts a new input's reply state once native owns the steered input", async () => {
  const order: string[] = [];
  const injection = createSteeredCliMessageInjection({
    getInjection: () => ({
      isAvailable: () => true,
      queueMessage: async (_text, withCurrent) => {
        await withCurrent(() => order.push("native-submit"));
      },
    }),
    signal: new AbortController().signal,
    assertCurrent: () => {},
    context: { params: { cwd: process.cwd(), workspaceDir: process.cwd() } },
    onInputSubmitted: vi.fn(() => order.push("input-submitted")),
  });
  await injection.queueMessage("follow-up", undefined, () => {}, "run");
  expect(order).toEqual(["native-submit", "input-submitted"]);
});
