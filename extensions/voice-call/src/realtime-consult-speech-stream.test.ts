import { describe, expect, it, vi } from "vitest";
import { createRealtimeConsultSpeechStream } from "./realtime-consult-speech-stream.js";

describe("createRealtimeConsultSpeechStream", () => {
  it("delivers stable sentences in order and omits them from final speech", () => {
    const deliver = vi.fn();
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    stream.push({ runId: "run-1", text: "First unstable" });
    stream.push({ runId: "run-1", text: "First stable. Second unstable" });
    stream.push({ runId: "run-1", text: "First stable. Second stable! Tail" });

    expect(deliver.mock.calls.map(([text]) => text)).toEqual(["First stable.", "Second stable!"]);
    expect(stream.finish("First stable. Second stable! Tail complete.")).toBe(true);
    expect(deliver.mock.calls.map(([text]) => text)).toEqual([
      "First stable.",
      "Second stable!",
      "Tail complete.",
    ]);
  });

  it("ignores other runs and late output after cancellation", () => {
    const deliver = vi.fn();
    const onCancel = vi.fn();
    const stream = createRealtimeConsultSpeechStream({ deliver, onCancel });
    stream.start("run-current");
    stream.push({ runId: "run-retired", text: "Never speak this." });
    stream.cancel();
    stream.push({ runId: "run-current", text: "Also stale." });

    expect(stream.finish("Late final.")).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("speaks only the corrective suffix when the final answer revises spoken text", () => {
    const deliver = vi.fn();
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");
    stream.push({ runId: "run-1", text: "The task is active." });
    stream.finish("The task is complete.");

    expect(deliver.mock.calls.map(([text]) => text)).toEqual([
      "The task is active.",
      "Correction: complete.",
    ]);
  });

  it("explicitly retracts a spoken suffix removed from the final answer", () => {
    const deliver = vi.fn();
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");
    stream.push({
      runId: "run-1",
      text: "The deployment succeeded. No action is required.",
    });
    stream.finish("The deployment succeeded.");

    expect(deliver.mock.calls.map(([text]) => text)).toEqual([
      "The deployment succeeded.",
      "No action is required.",
      'Correction: disregard the previous ending after "The deployment succeeded.".',
    ]);
  });

  it("retires incremental delivery so the caller can use completed-result fallback", () => {
    const onCancel = vi.fn();
    const stream = createRealtimeConsultSpeechStream({
      deliver: () => {
        throw new Error("provider rejected side-channel speech");
      },
      onCancel,
    });
    stream.start("run-1");

    expect(() => stream.push({ runId: "run-1", text: "A complete sentence." })).toThrow(
      "provider rejected side-channel speech",
    );
    expect(stream.finish("A complete sentence. Final detail.")).toBe(false);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
