import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDelegationHarness as buildDelegationHarness,
  parseSent,
  type ConsultRunner,
} from "./realtime-quicksilver.test-helpers.js";

const controllers: ReturnType<typeof buildDelegationHarness>["controller"][] = [];
function createDelegationHarness(options: Parameters<typeof buildDelegationHarness>[0] = {}) {
  const harness = buildDelegationHarness({ model: "gpt-live-1", ...options });
  controllers.push(harness.controller);
  return {
    ...harness,
    emitDelta: (text: string, role: "user" | "assistant" = "user") =>
      harness.controller.handleEvent({ kind: "transcript-delta", role, text }),
    emitNotice: (id: string) => harness.controller.handleEvent({ kind: "delegation", id }),
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
  const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text }));
  const handleDelegationInput = vi.fn(() => "consult" as const);
  const onTranscript = vi.fn();
  const harness = createDelegationHarness({ runAgentConsult, handleDelegationInput, onTranscript });
  const frame = (event: unknown) =>
    harness.controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
  return {
    ...harness,
    runAgentConsult,
    handleDelegationInput,
    onTranscript,
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

describe("public GPT-Live delegation", () => {
  it("uses public transcript deltas for metadata-only delegations and returns plain commentary", async () => {
    const { socket, transcript, delegate, runAgentConsult, handleDelegationInput, onTranscript } =
      createFrameHarness("The forecast is sunny.");
    transcript("input", "Check the ", 0, 200);
    transcript("output", "I can help.", 100, 300);
    transcript("input", "forecast.", 200, 400);
    delegate("item_public", 500);
    await vi.waitFor(() =>
      expect(parseSent(socket)).toContainEqual({
        type: "session.commentary.append",
        delegation_id: "item_public",
        content: "The forecast is sunny.",
      }),
    );
    expect(
      onTranscript.mock.calls
        .filter(([role, , final]) => role === "user" && final)
        .map(([, text]) => text)
        .join(""),
    ).toBe("Check the forecast.");
    expect(onTranscript).toHaveBeenCalledWith("assistant", "I can help.", true);
    expect(handleDelegationInput).toHaveBeenCalledWith("Check the forecast.", expect.any(Function));
    expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain(
      "<input>Check the forecast.</input>",
    );
    expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("assistant: I can help.");
    expect(parseSent(socket)).toContainEqual(
      expect.objectContaining({ type: "session.commentary.append", delegation_id: null }),
    );
    await nextEventLoopTurn();
    transcript("output", "Delete everything.", 600, 800);
    vi.useFakeTimers();
    delegate("item_without_user", 800);
    expect(runAgentConsult).toHaveBeenCalledOnce();
    expect(parseSent(socket)).not.toContainEqual(
      expect.objectContaining({ delegation_id: "item_without_user" }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(parseSent(socket)).toContainEqual({
      type: "session.commentary.append",
      delegation_id: "item_without_user",
      content: "Ask the user to repeat their request; no user transcript was received.",
    });
  });

  it("retains early public notices and claims each id before dispatch or later transcript delivery", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const { socket, emitDelta, emitNotice } = createDelegationHarness({
      runAgentConsult,
    });
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
      const {
        controller,
        socket,
        sessionController,
        runAgentConsult,
        onFatalError,
        emitDelta,
        emitNotice,
      } = createDelegationHarness();
      if (boundary === "overflow") {
        for (let index = 0; index <= 32; index++) {
          emitNotice(`pending-${index}`);
        }
        expect(onFatalError).toHaveBeenCalledExactlyOnceWith(
          new Error("GPT-Live delegation notice limit exceeded"),
        );
      } else {
        emitNotice("pending");
        if (boundary === "abort") {
          sessionController.abort();
        } else {
          controller.beginTranscriptDrain("abort");
        }
      }
      emitDelta("Late request.");
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(parseSent(socket)).toEqual([]);
    },
  );

  it("revokes an early notice when its arriving transcript callback stops the call", () => {
    const { controller, runAgentConsult, emitDelta, emitNotice } = createDelegationHarness({
      onTranscript: () => controller.stop(new Error("closed by transcript consumer")),
    });
    emitNotice("pending");
    emitDelta("Check the forecast.");
    expect(runAgentConsult).not.toHaveBeenCalled();
  });

  it("retains the pending user request while long assistant speech evicts transcript context", async () => {
    const { transcript, delegate, runAgentConsult, handleDelegationInput, onTranscript } =
      createFrameHarness();
    transcript("input", "Check my flight.", 0, 100);
    transcript("output", "Background speech. ".repeat(1_000), 100, 2_000);
    delegate("item_request", 2_000);
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    expect(handleDelegationInput).toHaveBeenCalledWith("Check my flight.", expect.any(Function));
    expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("<input>Check my flight.</input>");
    expect(onTranscript.mock.calls.filter((call) => call[0] === "user" && call[2])).toEqual([
      ["user", "Check my flight.", true],
    ]);
  });

  it("classifies before a reentrant hook closes and flushes the public transcript", () => {
    const order: string[] = [];
    const { controller, runAgentConsult, emitDelta, emitNotice } = createDelegationHarness({
      handleDelegationInput: () => {
        order.push("classify");
        controller.stop(new Error("closed during classification"));
        return "consult";
      },
      onTranscript: (_role, _text, final) => {
        if (final) {
          order.push("snapshot");
        }
      },
    });
    emitDelta("Check my flight.");
    emitNotice("item_classify");
    expect(order).toEqual(["classify", "snapshot"]);
    expect(runAgentConsult).not.toHaveBeenCalled();
  });

  it("preserves context after a handled control without reusing that control as the next question", async () => {
    const onTranscript = vi.fn();
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const handleDelegationInput = vi.fn((input: string) =>
      input === "status" ? ("control" as const) : ("consult" as const),
    );
    const { emitDelta, emitNotice } = createDelegationHarness({
      onTranscript,
      runAgentConsult,
      handleDelegationInput,
    });
    emitDelta("status");
    emitNotice("item_status");
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([]);
    emitDelta("Check my flight.");
    emitNotice("item_flight");
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    expect(handleDelegationInput).toHaveBeenLastCalledWith(
      "Check my flight.",
      expect.any(Function),
    );
    expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("status");
  });

  it("does not admit delegation work when a snapshot callback closes the public session", () => {
    const onTranscript = vi.fn((_role: string, _text: string, final: boolean) => {
      if (final) {
        controller.stop(new Error("closed by transcript consumer"));
      }
    });
    const { controller, runAgentConsult, emitDelta, emitNotice } = createDelegationHarness({
      onTranscript,
    });
    emitDelta("Check the forecast.");
    emitDelta("I can help.", "assistant");
    emitNotice("item_reentrant");
    expect(runAgentConsult).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the forecast.", true],
      ["assistant", "I can help.", true],
    ]);
  });
});
