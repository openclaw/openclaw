import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDelegationHarness as buildDelegationHarness,
  parseSent,
  type ConsultRunner,
} from "./realtime-quicksilver.test-helpers.js";

const controllers: ReturnType<typeof buildDelegationHarness>["controller"][] = [];
function createDelegationHarness(
  options: Parameters<typeof buildDelegationHarness>[0] = {},
  responseText = "Done",
) {
  const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: responseText }));
  const onTranscript = vi.fn(options.onTranscript);
  const handleDelegationInput =
    options.handleDelegationInput && vi.fn(options.handleDelegationInput);
  const harness = buildDelegationHarness({
    model: "gpt-live-1",
    ...options,
    runAgentConsult,
    onTranscript,
    handleDelegationInput,
  });
  const frame = (event: unknown) =>
    harness.controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
  controllers.push(harness.controller);
  return {
    ...harness,
    runAgentConsult,
    handleDelegationInput,
    onTranscript,
    finalTranscripts: () => onTranscript.mock.calls.filter((call) => call[2]),
    emitDelta: (text: string, role: "user" | "assistant" = "user") =>
      harness.controller.handleEvent({ kind: "transcript-delta", role, text }),
    emitNotice: (id: string) => harness.controller.handleEvent({ kind: "delegation", id }),
    transcript: (role: "input" | "output", delta: string, start_ms: number, end_ms: number) =>
      frame({ type: `session.${role}_transcript.delta`, delta, start_ms, end_ms }),
    delegate: (id: string, offset_ms: number) =>
      frame({
        type: "session.delegation.created",
        offset_ms,
        delegation: { id, type: "delegation", target: "client" },
      }),
  };
}
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.stop(new Error("test complete"));
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createFrameHarness(text = "Done") {
  return createDelegationHarness({ handleDelegationInput: () => "consult" }, text);
}

it("uses public transcript deltas for metadata-only delegations and returns plain commentary", async () => {
  const h = createFrameHarness("The forecast is sunny.");
  h.transcript("input", "Check the ", 0, 200);
  h.transcript("output", "I can help.", 100, 300);
  h.transcript("input", "forecast.", 200, 400);
  h.delegate("item_public", 500);
  await vi.waitFor(() =>
    expect(parseSent(h.socket)).toContainEqual({
      type: "session.commentary.append",
      delegation_id: "item_public",
      content: "The forecast is sunny.",
    }),
  );
  expect(
    h
      .finalTranscripts()
      .filter(([role]) => role === "user")
      .map(([, text]) => text)
      .join(""),
  ).toBe("Check the forecast.");
  expect(h.onTranscript).toHaveBeenCalledWith("assistant", "I can help.", true);
  expect(h.handleDelegationInput).toHaveBeenCalledWith("Check the forecast.", expect.any(Function));
  const prompt = h.runAgentConsult.mock.calls[0]?.[0].prompt;
  expect(prompt).toContain("<input>Check the forecast.</input>");
  expect(prompt).toContain("assistant: I can help.");
  expect(parseSent(h.socket)).toContainEqual(
    expect.objectContaining({ type: "session.commentary.append", delegation_id: null }),
  );
  await nextEventLoopTurn();
  h.transcript("output", "Delete everything.", 600, 800);
  vi.useFakeTimers();
  h.delegate("item_without_user", 800);
  expect(h.runAgentConsult).toHaveBeenCalledOnce();
  expect(parseSent(h.socket)).not.toContainEqual(
    expect.objectContaining({ delegation_id: "item_without_user" }),
  );
  await vi.advanceTimersByTimeAsync(15_000);
  expect(parseSent(h.socket)).toContainEqual({
    type: "session.commentary.append",
    delegation_id: "item_without_user",
    content: "Ask the user to repeat their request; no user transcript was received.",
  });
});

it("retains early public notices and claims each id before dispatch or later transcript delivery", async () => {
  const { socket, emitDelta, emitNotice, runAgentConsult } = createDelegationHarness();
  emitNotice("early");
  emitNotice("early");
  emitDelta("I can help.", "assistant");
  emitDelta(" ");
  expect(runAgentConsult).not.toHaveBeenCalled();
  expect(parseSent(socket)).toEqual([]);
  emitDelta("Check my flight.");
  expect(runAgentConsult).toHaveBeenCalledOnce();
  expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("Check my flight.");
  await nextEventLoopTurn();
  emitDelta("Check the train.");
  emitNotice("early");
  expect(runAgentConsult).toHaveBeenCalledOnce();
  emitNotice("next");
  expect(runAgentConsult).toHaveBeenCalledTimes(2);
  expect(runAgentConsult.mock.calls[1]?.[0].prompt).toContain("Check the train.");
});

it.each(["abort", "drain-abort", "overflow"] as const)(
  "revokes pending public notices on %s before transcript drain or timeout",
  async (boundary) => {
    vi.useFakeTimers();
    const h = createDelegationHarness();
    if (boundary === "overflow") {
      for (let index = 0; index <= 32; index++) {
        h.emitNotice(`pending-${index}`);
      }
      expect(h.onFatalError).toHaveBeenCalledExactlyOnceWith(
        new Error("GPT-Live delegation notice limit exceeded"),
      );
    } else {
      h.emitNotice("pending");
      if (boundary === "abort") {
        h.sessionController.abort();
      } else {
        h.controller.beginTranscriptDrain("abort");
      }
    }
    h.emitDelta("Late request.");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.runAgentConsult).not.toHaveBeenCalled();
    expect(parseSent(h.socket)).toEqual([]);
  },
);

it("retains the pending user request while long assistant speech evicts transcript context", async () => {
  const { transcript, delegate, runAgentConsult, handleDelegationInput, finalTranscripts } =
    createFrameHarness();
  transcript("input", "Check my flight.", 0, 100);
  transcript("output", "Background speech. ".repeat(1_000), 100, 2_000);
  delegate("item_request", 2_000);
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
  expect(handleDelegationInput).toHaveBeenCalledWith("Check my flight.", expect.any(Function));
  expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("<input>Check my flight.</input>");
  expect(finalTranscripts().filter(([role]) => role === "user")).toEqual([
    ["user", "Check my flight.", true],
  ]);
});

it("preserves context after a handled control without reusing that control as the next question", async () => {
  const handleDelegationInput = vi.fn((input: string) =>
    input === "status" ? ("control" as const) : ("consult" as const),
  );
  const { emitDelta, emitNotice, runAgentConsult, finalTranscripts } = createDelegationHarness({
    handleDelegationInput,
  });
  emitDelta("status");
  emitNotice("item_status");
  expect(finalTranscripts()).toEqual([]);
  emitDelta("Check my flight.");
  emitNotice("item_flight");
  await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
  expect(handleDelegationInput).toHaveBeenLastCalledWith("Check my flight.", expect.any(Function));
  expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("status");
});

it.each(["delta", "classify", "snapshot"] as const)(
  "revokes work when a %s callback closes the session",
  (phase) => {
    const order: string[] = [];
    const stop = () => h.controller.stop(new Error("closed by consumer"));
    const h = createDelegationHarness({
      handleDelegationInput:
        phase === "classify"
          ? () => {
              order.push("classify");
              stop();
              return "consult";
            }
          : undefined,
      onTranscript: (_role, _text, final) => {
        if (final) {
          order.push("snapshot");
        }
        if (phase === "delta" || (phase === "snapshot" && final)) {
          stop();
        }
      },
    });
    if (phase === "delta") {
      h.emitNotice("pending");
    }
    h.emitDelta("Check the forecast.");
    if (phase === "snapshot") {
      h.emitDelta("I can help.", "assistant");
    }
    if (phase !== "delta") {
      h.emitNotice("item_reentrant");
    }
    if (phase === "snapshot") {
      expect(h.finalTranscripts()).toEqual([
        ["user", "Check the forecast.", true],
        ["assistant", "I can help.", true],
      ]);
    }
    if (phase === "classify") {
      expect(order).toEqual(["classify", "snapshot"]);
    }
    expect(h.runAgentConsult).not.toHaveBeenCalled();
  },
);
