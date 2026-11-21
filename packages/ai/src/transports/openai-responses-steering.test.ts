import type { ResponseInput } from "openai/resources/responses/responses.js";
import { assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { StreamOptions, UserMessage } from "../types.js";
import { createResponsesSteering, omitAcceptedSteering } from "./openai-responses-steering.js";

const messages: UserMessage[] = [{ role: "user", content: "change direction", timestamp: 1 }];
const input: ResponseInput = [{ role: "user", content: "change direction" }];
const created = { type: "response.created", response: { id: "resp_1" } };
const acknowledgement = (type: string, id = "steer_1", responseId = "resp_1") => ({
  type: `response.steer.${type}`,
  steer: { id, previous_response_id: responseId },
});

function setup(options: Partial<Parameters<typeof createResponsesSteering>[0]> = {}) {
  let control!: Parameters<NonNullable<StreamOptions["onActiveResponse"]>>[0];
  const send = vi.fn();
  const steering = createResponsesSteering({
    onActiveResponse: (next) => {
      control = next;
    },
    toInput: () => input,
    send,
    assertActive: vi.fn(),
    ...options,
  });
  return {
    steering,
    get control() {
      return control;
    },
    send,
  };
}

it("matches rejection before ID allocation to the returned pending input", async () => {
  const later: UserMessage[] = [{ role: "user", content: "later update", timestamp: 2 }];
  const laterInput: ResponseInput = [{ role: "user", content: "later update" }];
  const harness = setup({
    toInput: vi
      .fn<(messages: readonly UserMessage[]) => ResponseInput>()
      .mockReturnValueOnce(input)
      .mockReturnValueOnce(laterInput),
  });
  harness.steering.handle(created);
  const first = harness.control.steer(messages);
  const second = harness.control.steer(later);
  const failure = {
    type: "response.steer.failed",
    steer: { previous_response_id: "resp_1", input: laterInput },
    error: { code: "response_already_completed" },
  };
  expect(harness.steering.handle(failure)).toBe(true);
  expect(await second).toBe(false);
  expect(harness.steering.pending).toBe(true);
  expect(harness.steering.acceptedInput).toEqual([]);
  expect(() => harness.steering.handle(failure)).toThrow("no pending submission");
  harness.steering.handle(acknowledgement("accepted"));
  expect(await first).toBe(true);
  expect(harness.steering.pending).toBe(false);
  expect(harness.steering.acceptedInput).toEqual(input);
  harness.steering.seal();
});

it.each([
  acknowledgement("accepted", "steer_1", "resp_other"),
  acknowledgement("accepted", ""),
  { type: "response.steer.accepted", steer: { previous_response_id: "resp_1" } },
  { type: "response.steer.pending", steer: { previous_response_id: "resp_1" } },
  { type: "response.steer.failed", steer: { previous_response_id: "resp_other", input } },
  acknowledgement("pending", "steer_unknown"),
])("rejects unowned acknowledgements without consuming pending input: $type", async (event) => {
  const harness = setup();
  harness.steering.handle(created);
  const pending = harness.control.steer(messages);
  expect(() => harness.steering.handle(event)).toThrow(/identity|no accepted submission/);
  expect(harness.steering.pending).toBe(true);
  const rejection = expect(pending).rejects.toThrow("connection closed");
  harness.steering.close(new Error("connection closed"));
  await rejection;
});

it("does not apply a duplicate failed acknowledgement to a later submission", async () => {
  const harness = setup();
  harness.steering.handle(created);
  const first = harness.control.steer(messages);
  harness.steering.handle(acknowledgement("failed"));
  await first;
  const second = harness.control.steer(messages);
  expect(() => harness.steering.handle(acknowledgement("failed"))).toThrow("already applied");
  expect(harness.steering.pending).toBe(true);
  const rejection = expect(second).rejects.toThrow("connection closed");
  harness.steering.close(new Error("connection closed"));
  await rejection;
  expect(harness.steering.acceptedInput).toEqual([]);
});

it.each([
  ["sync", "closed"],
  ["sync", "replaced"],
  ["async", "closed"],
  ["async", "replaced"],
])("fences %s projection when ownership is %s", async (timing, reason) => {
  const projection = createDeferred<ResponseInput>();
  let active = true;
  const loseOwnership = () => {
    if (reason === "closed") {
      harness.steering.seal();
    } else {
      active = false;
    }
  };
  const harness = setup({
    toInput: () => {
      if (timing === "async") {
        return projection.promise;
      }
      loseOwnership();
      return input;
    },
    assertActive: () => {
      assert(active, "stale response");
    },
  });
  harness.steering.handle(created);
  if (timing === "sync" && reason === "replaced") {
    expect(() => harness.control.steer(messages)).toThrow("stale response");
  } else {
    const admission = harness.control.steer(messages);
    if (timing === "async") {
      loseOwnership();
    }
    const outcome =
      reason === "closed"
        ? expect(admission).resolves.toBe(false)
        : expect(admission).rejects.toThrow("stale response");
    projection.resolve(input);
    await outcome;
  }
  expect(harness.send).not.toHaveBeenCalled();
  expect(harness.steering.pending).toBe(false);
  harness.steering.seal();
});

it.each(["registration", "cleanup"])("cleans up once when %s closes the owner", (phase) => {
  const cleanup = vi.fn(() => {
    if (phase === "cleanup") {
      harness.steering.seal();
    }
  });
  const harness = setup({
    onActiveResponse: () => {
      if (phase === "registration") {
        harness.steering.seal();
      }
      return cleanup;
    },
  });
  harness.steering.handle(created);
  harness.steering.seal();
  expect(cleanup).toHaveBeenCalledOnce();
});
it("omits exactly the accepted copies and preserves every other input in order", () => {
  const toolResult = {
    type: "function_call_output" as const,
    call_id: "call_1",
    output: "result",
  };
  const update = { type: "configuration_update" as const, reasoning: { effort: "high" } };
  const next = [...input, toolResult, ...input, update];
  expect(omitAcceptedSteering(next, input)).toEqual([toolResult, ...input, update]);
  expect(next).toEqual([...input, toolResult, ...input, update]);
  expect(() => omitAcceptedSteering([toolResult], input)).toThrow("accepted user input");
});
