import { expect, it } from "vitest";
import { createSessionCompactionRequest } from "./request.js";

it("records one bounded request and rejects retained capabilities after their owner closes", () => {
  const owner = createSessionCompactionRequest();
  const controller = new AbortController();
  const capability = owner.bind(() => controller.signal.throwIfAborted());
  expect(capability.request({ focus: "🦞".repeat(801) })).toEqual({ status: "requested" });
  expect(capability.request({ focus: "replacement" })).toEqual({ status: "already_requested" });
  expect(owner.pending?.focus).toBe("🦞".repeat(800));
  expect(owner.takePending()?.focus).toBe("🦞".repeat(800));
  expect(owner.pending).toBeUndefined();
  expect(owner.takePending()).toBeUndefined();
  expect(capability.request({})).toEqual({ status: "already_requested" });
  controller.abort(new Error("owner closed"));
  expect(() => capability.request({})).toThrow("owner closed");
  expect(createSessionCompactionRequest().pending).toBeUndefined();
});
