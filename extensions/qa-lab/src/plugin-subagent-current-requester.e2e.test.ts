import { afterEach, expect, it } from "vitest";
import { startSubagentFixture } from "./plugin-subagent.e2e.test-support.ts";

const COMPLETION_MARKER = "QA-CURRENT-REQUESTER-COMPLETION-OK";
const conversation = { id: "requester-user", kind: "direct" as const };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("delivers to the captured requester and rejects forged lineage outside hook scope", async () => {
  const { gateway, outbound, transport } = await startSubagentFixture(
    "current-requester",
    cleanups,
  );
  const response = await fetch(`${gateway.baseUrl}/qa/current-requester/outside-hook`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gateway.token}` },
  });
  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("requester-bound plugin hook invocation"),
  });
  const waitOptions = { conversation, sinceIndex: outbound().length };
  await transport.sendInbound({
    accountId: "default",
    conversation,
    senderId: conversation.id,
    text: "qa current requester completion",
  });
  const spawn = await transport.waitForOutbound({ ...waitOptions, timeoutMs: 30_000 });
  expect(spawn.text).toContain("QA-CURRENT-REQUESTER-SPAWNED");
  const completion = await transport.waitForOutbound({
    ...waitOptions,
    textIncludes: COMPLETION_MARKER,
    timeoutMs: 90_000,
  });
  expect(completion.accountId).toBe("default");
  expect(outbound().some((message) => message.conversation.id === "attacker")).toBe(false);
  expect(outbound().filter((message) => message.text.includes(COMPLETION_MARKER))).toHaveLength(1);
}, 180_000);
