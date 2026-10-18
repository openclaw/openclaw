import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../../../test/helpers/qa-gateway-cleanup.js";
import { createExternalGates } from "./subagent-external-gate.test-support.js";

it("keeps hidden concurrent results unavailable until the external owner releases them", async () => {
  const gates = await createExternalGates();
  const first = gates.create();
  const second = gates.create();
  const firstResult = randomUUID();
  const secondResult = randomUUID();
  const settled: string[] = [];
  const requests = [first, second].map(async (gate, index) => {
    const response = await fetch(gate.url, { signal: AbortSignal.timeout(10_000) });
    const text = await response.text();
    settled.push(String(index));
    return { code: response.status, text };
  });
  // Own rejection immediately, including a failure before the release assertion.
  const joined = Promise.allSettled(requests);
  await runQaGatewayFixture(
    async () => {
      await vi.waitFor(() => {
        expect(first.snapshot().waiting).toBe(1);
        expect(second.snapshot().waiting).toBe(1);
      });
      const attempt = await fetch(first.url, {
        method: "POST",
        body: "release",
        signal: AbortSignal.timeout(10_000),
      });
      await attempt.arrayBuffer();
      expect(attempt.status, "the worker cannot release the gate over HTTP").toBe(404);
      expect(settled, "neither held request has produced a result").toEqual([]);
      first.release(firstResult);
      expect(await requests[0]).toEqual({ code: 200, text: firstResult });
      expect(second.snapshot()).toEqual({ requests: 1, waiting: 1, released: false });
      expect(settled, "releasing one worker cannot release its sibling").toEqual(["0"]);
      second.release(secondResult, 503);
      expect(await requests[1]).toEqual({ code: 503, text: secondResult });
      expect(await joined).toHaveLength(2);
    },
    () => gates.close(),
    () => joined,
  );
});
