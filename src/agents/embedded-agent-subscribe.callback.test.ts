import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { serializeAgentEventCallback } from "./embedded-agent-subscribe.callback.js";
import type { EmbeddedAgentEvent } from "./embedded-agent-subscribe.shared-types.js";

const event = (phase: string): EmbeddedAgentEvent => ({ stream: "run_status", data: { phase } });

it("delivers idle synchronous callbacks before returning", () => {
  const callback = vi.fn(() => {});
  const deliver = expectDefined(serializeAgentEventCallback(callback), "event callback");
  const first = event("waiting_for_model");
  const second = event("starting_model");

  expect(deliver(first)).toBeUndefined();
  expect(deliver(second)).toBeUndefined();
  expect(callback.mock.calls).toEqual([[first], [second]]);
});

it("preserves callback rejection and delivers the next queued event", async () => {
  const held = createDeferredCore();
  const callback = vi.fn((value: EmbeddedAgentEvent) =>
    value.data.phase === "waiting_for_model" ? held.promise : undefined,
  );
  const deliver = expectDefined(serializeAgentEventCallback(callback), "event callback");
  const first = event("waiting_for_model");
  const second = event("starting_model");
  const pending = deliver(first);
  const next = deliver(second);
  expect(callback.mock.calls).toEqual([[first]]);

  const failure = new Error("synthetic delivery failure");
  const rejected = expect(pending).rejects.toBe(failure);
  held.reject(failure);
  await rejected;
  await next;
  expect(callback.mock.calls).toEqual([[first], [second]]);
});
