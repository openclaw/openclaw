import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import type { JsonValue } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

const clients: CodexAppServerClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  vi.restoreAllMocks();
});

describe("Codex inbound request lifetime", () => {
  it.each([
    { method: "item/commandExecution/requestApproval", outcome: "answer" },
    { method: "item/tool/call", outcome: "error" },
  ])(
    "resolves only the exact thread and typed request id, suppressing a late $outcome for $method",
    async ({ method, outcome }) => {
      const harness = createClientHarness();
      clients.push(harness.client);
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const response = createDeferred<JsonValue>();
      const signals = new Map<string | number, AbortSignal | undefined>();
      harness.client.addRequestHandler((request, signal) => {
        signals.set(request.id, signal);
        return request.id === 7 ? response.promise : new Promise<never>(() => {});
      });
      for (const id of [7, "7"]) {
        harness.send({ id, method, params: { threadId: "thread-1" } });
      }
      harness.send({
        method: "serverRequest/resolved",
        params: { threadId: "other-thread", requestId: 7 },
      });
      expect(signals.get(7)?.aborted).toBe(false);
      harness.send({
        method: "serverRequest/resolved",
        params: { threadId: "thread-1", requestId: 7 },
      });
      expect(signals.get(7)?.aborted).toBe(true);
      expect(signals.get("7")?.aborted).toBe(false);
      expect(harness.writes).toEqual([]);
      if (outcome === "answer") {
        response.resolve({ decision: "accept" });
      } else {
        response.reject(new Error("late handler failure"));
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(harness.writes).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("aborts pending handlers when the physical client closes", async () => {
    const harness = createClientHarness();
    clients.push(harness.client);
    let requestSignal: AbortSignal | undefined;
    const response = createDeferred<JsonValue>();
    harness.client.addRequestHandler((_request, signal) => {
      requestSignal = signal;
      return response.promise;
    });
    harness.send({
      id: "pending",
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1" },
    });
    harness.client.close();
    expect(requestSignal?.aborted).toBe(true);
    response.resolve({ answers: {} });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(harness.writes).toEqual([]);
  });
});
