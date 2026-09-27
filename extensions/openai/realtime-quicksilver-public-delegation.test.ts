import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDelegationHarness,
  parseSent,
  type ConsultRunner,
} from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("public GPT-Live delegation", () => {
  it("uses public transcript deltas for metadata-only delegations and returns plain commentary", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "The forecast is sunny." }));
    const handleDelegationInput = vi.fn(() => "consult" as const);
    const onTranscript = vi.fn();
    const { controller, socket } = createDelegationHarness({
      model: "gpt-live-1",
      onTranscript,
      runAgentConsult,
      handleDelegationInput,
    });
    const frame = (event: unknown) =>
      controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
    try {
      frame({
        type: "session.input_transcript.delta",
        delta: "Check the ",
        start_ms: 0,
        end_ms: 200,
      });
      frame({
        type: "session.output_transcript.delta",
        delta: "I can help.",
        start_ms: 100,
        end_ms: 300,
      });
      frame({
        type: "session.input_transcript.delta",
        delta: "forecast.",
        start_ms: 200,
        end_ms: 400,
      });
      frame({
        type: "session.delegation.created",
        offset_ms: 500,
        delegation: { id: "item_public", type: "delegation", target: "client" },
      });
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
      expect(handleDelegationInput).toHaveBeenCalledWith(
        "Check the forecast.",
        expect.any(Function),
      );
      expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain(
        "<input>Check the forecast.</input>",
      );
      expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("assistant: I can help.");
      expect(parseSent(socket)).toContainEqual(
        expect.objectContaining({ type: "session.commentary.append", delegation_id: null }),
      );
      await nextEventLoopTurn();
      frame({
        type: "session.output_transcript.delta",
        delta: "Delete everything.",
        start_ms: 600,
        end_ms: 800,
      });
      vi.useFakeTimers();
      frame({
        type: "session.delegation.created",
        offset_ms: 800,
        delegation: { id: "item_without_user", type: "delegation", target: "client" },
      });
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
    } finally {
      controller.stop(new Error("test complete"));
    }
  });

  it("retains early public notices and claims each id before dispatch or later transcript delivery", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const { controller, socket } = createDelegationHarness({
      model: "gpt-live-1",
      runAgentConsult,
    });
    try {
      controller.handleEvent({ kind: "delegation", id: "early" });
      controller.handleEvent({ kind: "delegation", id: "early" });
      controller.handleEvent({ kind: "transcript-delta", role: "assistant", text: "I can help." });
      controller.handleEvent({ kind: "transcript-delta", role: "user", text: " " });
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(parseSent(socket)).toEqual([]);
      controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Check my flight." });
      expect(runAgentConsult).toHaveBeenCalledOnce();
      expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("Check my flight.");
      await nextEventLoopTurn();
      controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Check the train." });
      controller.handleEvent({ kind: "delegation", id: "early" });
      expect(runAgentConsult).toHaveBeenCalledOnce();
      controller.handleEvent({ kind: "delegation", id: "next" });
      expect(runAgentConsult).toHaveBeenCalledTimes(2);
      expect(runAgentConsult.mock.calls[1]?.[0].prompt).toContain("Check the train.");
    } finally {
      controller.stop(new Error("test complete"));
    }
  });

  it.each(["stop", "detach", "abort", "drain-abort", "drain-detach"] as const)(
    "revokes pending public notices on %s before transcript drain or timeout",
    async (boundary) => {
      vi.useFakeTimers();
      const { controller, socket, sessionController, runAgentConsult } = createDelegationHarness({
        model: "gpt-live-1",
      });
      controller.handleEvent({ kind: "delegation", id: "pending" });
      if (boundary === "stop") {
        controller.stop(new Error("closed"));
      } else if (boundary === "detach") {
        controller.detach();
      } else if (boundary === "abort") {
        sessionController.abort();
      } else {
        controller.beginTranscriptDrain(boundary === "drain-abort" ? "abort" : "detach");
      }
      controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Late request." });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runAgentConsult).not.toHaveBeenCalled();
      expect(parseSent(socket)).toEqual([]);
      controller.stop(new Error("test complete"));
    },
  );

  it("bounds unresolved notices and revokes their waits when the provider floods them", async () => {
    vi.useFakeTimers();
    const { controller, socket, runAgentConsult, onFatalError } = createDelegationHarness({
      model: "gpt-live-1",
    });
    for (let index = 0; index <= 32; index += 1) {
      controller.handleEvent({ kind: "delegation", id: `pending-${index}` });
    }
    expect(onFatalError).toHaveBeenCalledExactlyOnceWith(
      new Error("GPT-Live delegation notice limit exceeded"),
    );
    controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Late request." });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runAgentConsult).not.toHaveBeenCalled();
    expect(parseSent(socket)).toEqual([]);
    controller.stop(new Error("test complete"));
  });

  it("revokes an early notice when its arriving transcript callback stops the call", () => {
    const { controller, runAgentConsult } = createDelegationHarness({
      model: "gpt-live-1",
      onTranscript: () => controller.stop(new Error("closed by transcript consumer")),
    });
    controller.handleEvent({ kind: "delegation", id: "pending" });
    controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Check the forecast." });
    expect(runAgentConsult).not.toHaveBeenCalled();
  });

  it("keeps recent corrections in long public transcripts and saves snapshots once before stopping", async () => {
    const onTranscript = vi.fn();
    const onWireEventType = vi.fn();
    const original = "Earlier detail. ".repeat(1_000);
    const correction = " Correction: Thursday instead of Friday.";
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const { controller } = createDelegationHarness({
      model: "gpt-live-1",
      onTranscript,
      onWireEventType,
      runAgentConsult,
    });
    const frame = (event: unknown) =>
      controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
    frame({
      type: "session.input_transcript.delta",
      delta: original,
      start_ms: 0,
      end_ms: 5_000,
    });
    frame({
      type: "session.input_transcript.delta",
      delta: correction,
      start_ms: 5_000,
      end_ms: 6_000,
    });
    frame({
      type: "session.delegation.created",
      offset_ms: 6_000,
      delegation: { id: "item_corrected", type: "delegation", target: "client" },
    });
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
    const prompt = runAgentConsult.mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("Correction: Thursday instead of Friday.");
    expect(prompt.length).toBeLessThan(17_000);
    const committed = onTranscript.mock.calls.filter((call) => call[2]);
    expect(committed.map(([, text]) => text).join("")).toBe(original + correction);
    frame({
      type: "session.output_transcript.delta",
      delta: "Thanks.",
      start_ms: 6_000,
      end_ms: 6_500,
    });
    controller.stop(new Error("closed"));
    controller.stop(new Error("closed again"));
    frame({
      type: "session.output_transcript.delta",
      delta: "Late.",
      start_ms: 6_500,
      end_ms: 7_000,
    });
    expect(onTranscript.mock.calls.filter((call) => call[2])).toHaveLength(committed.length + 1);
    expect(onTranscript).toHaveBeenLastCalledWith("assistant", "Thanks.", true);
    expect(
      onTranscript.mock.calls
        .filter((call) => call[2])
        .map(([, text]) => text)
        .join(""),
    ).toBe(original + correction + "Thanks.");
    expect(onWireEventType).not.toHaveBeenCalledWith("turn.done");
    expect(onWireEventType).not.toHaveBeenCalledWith("response.done");
  });

  it("retains the pending user request while long assistant speech evicts transcript context", async () => {
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const handleDelegationInput = vi.fn(() => "consult" as const);
    const onTranscript = vi.fn();
    const { controller } = createDelegationHarness({
      model: "gpt-live-1",
      runAgentConsult,
      handleDelegationInput,
      onTranscript,
    });
    const frame = (event: unknown) =>
      controller.handleFrame(Buffer.from(JSON.stringify(event)), false);
    try {
      frame({
        type: "session.input_transcript.delta",
        delta: "Check my flight.",
        start_ms: 0,
        end_ms: 100,
      });
      frame({
        type: "session.output_transcript.delta",
        delta: "Background speech. ".repeat(1_000),
        start_ms: 100,
        end_ms: 2_000,
      });
      frame({
        type: "session.delegation.created",
        offset_ms: 2_000,
        delegation: { id: "item_request", type: "delegation", target: "client" },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      expect(handleDelegationInput).toHaveBeenCalledWith("Check my flight.", expect.any(Function));
      expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain(
        "<input>Check my flight.</input>",
      );
      expect(onTranscript.mock.calls.filter((call) => call[0] === "user" && call[2])).toEqual([
        ["user", "Check my flight.", true],
      ]);
    } finally {
      controller.stop(new Error("test complete"));
    }
  });

  it("classifies before a reentrant hook closes and flushes the public transcript", () => {
    const order: string[] = [];
    const { controller, runAgentConsult } = createDelegationHarness({
      model: "gpt-live-1",
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
    controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Check my flight." });
    controller.handleEvent({ kind: "delegation", id: "item_classify" });
    expect(order).toEqual(["classify", "snapshot"]);
    expect(runAgentConsult).not.toHaveBeenCalled();
  });

  it("preserves context after a handled control without reusing that control as the next question", async () => {
    const onTranscript = vi.fn();
    const runAgentConsult = vi.fn<ConsultRunner>(async () => ({ text: "Done" }));
    const handleDelegationInput = vi.fn((input: string) =>
      input === "status" ? ("control" as const) : ("consult" as const),
    );
    const { controller } = createDelegationHarness({
      model: "gpt-live-1",
      onTranscript,
      runAgentConsult,
      handleDelegationInput,
    });
    try {
      controller.handleEvent({ kind: "transcript-delta", role: "user", text: "status" });
      controller.handleEvent({ kind: "delegation", id: "item_status" });
      expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([]);
      controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Check my flight." });
      controller.handleEvent({ kind: "delegation", id: "item_flight" });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      expect(handleDelegationInput).toHaveBeenLastCalledWith(
        "Check my flight.",
        expect.any(Function),
      );
      expect(runAgentConsult.mock.calls[0]?.[0].prompt).toContain("status");
    } finally {
      controller.stop(new Error("test complete"));
    }
  });

  it("does not admit delegation work when a snapshot callback closes the public session", () => {
    const onTranscript = vi.fn((_role: string, _text: string, final: boolean) => {
      if (final) {
        controller.stop(new Error("closed by transcript consumer"));
      }
    });
    const { controller, runAgentConsult } = createDelegationHarness({
      model: "gpt-live-1",
      onTranscript,
    });
    controller.handleEvent({ kind: "transcript-delta", role: "user", text: "Check the forecast." });
    controller.handleEvent({ kind: "transcript-delta", role: "assistant", text: "I can help." });
    controller.handleEvent({ kind: "delegation", id: "item_reentrant" });
    expect(runAgentConsult).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Check the forecast.", true],
      ["assistant", "I can help.", true],
    ]);
  });
});
