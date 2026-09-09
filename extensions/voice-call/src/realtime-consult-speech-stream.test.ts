import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createRealtimeConsultSpeechStream } from "./realtime-consult-speech-stream.js";

describe("createRealtimeConsultSpeechStream", () => {
  it("deduplicates cumulative snapshots and true deltas before the final result", async () => {
    const deliver = vi.fn(async (_text: string) => {});
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    await stream.push({ runId: "run-1", text: "First segment.", delta: "First segment." });
    await stream.push({ runId: "run-1", text: "First segment." });
    await stream.push({ runId: "run-1", text: " Second segment.", delta: " Second segment." });

    await expect(stream.finish("First segment. Second segment.")).resolves.toEqual({
      suppressResponse: true,
    });
    expect(deliver.mock.calls.map(([text]) => text)).toEqual(["First segment.", "Second segment."]);
  });

  it("waits for each speech delivery before accepting the next partial", async () => {
    const firstDelivery = createDeferred<void>();
    const deliveries: string[] = [];
    const deliver = vi.fn(async (text: string) => {
      deliveries.push(text);
      if (text === "First segment.") {
        await firstDelivery.promise;
      }
    });
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    const firstPush = stream.push({ runId: "run-1", text: "First segment." });
    await vi.waitFor(() => expect(deliveries).toEqual(["First segment."]));
    const secondPush = stream.push({
      runId: "run-1",
      text: "First segment. Second segment.",
    });
    await Promise.resolve();
    expect(deliveries).toEqual(["First segment."]);

    firstDelivery.resolve();
    await Promise.all([firstPush, secondPush]);
    expect(deliveries).toEqual(["First segment.", "Second segment."]);
  });

  it("drops queued and late output immediately after cancellation", async () => {
    const activeDelivery = createDeferred<void>();
    const deliver = vi.fn(async () => await activeDelivery.promise);
    const onCancel = vi.fn(() => activeDelivery.reject(new Error("cancelled")));
    const stream = createRealtimeConsultSpeechStream({ deliver, onCancel });
    stream.start("run-current");

    const active = stream.push({ runId: "run-current", text: "Already active." });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    const queued = stream.push({ runId: "run-current", text: "Already active. Never speak." });
    stream.cancel();

    await expect(active).resolves.toBeUndefined();
    await expect(queued).resolves.toBeUndefined();
    await expect(stream.finish("Late final.")).resolves.toEqual({ suppressResponse: false });
    expect(deliver).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("ignores a retired run after a replacement starts", async () => {
    const deliver = vi.fn(async (_text: string) => {});
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-new");

    await stream.push({ runId: "run-old", text: "Stale output." });
    await stream.push({ runId: "run-new", text: "Current output." });
    await expect(stream.finish("Current output.")).resolves.toEqual({ suppressResponse: true });

    expect(deliver.mock.calls.map(([text]) => text)).toEqual(["Current output."]);
  });

  it("preserves the completed-result path when no partial was spoken", async () => {
    const deliver = vi.fn(async () => {});
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    await stream.push({ runId: "run-1", text: "Still incomplete" });

    await expect(stream.finish("Still incomplete but now final.")).resolves.toEqual({
      suppressResponse: false,
    });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not repeat a streamed sentence when its partial has trailing whitespace", async () => {
    const deliver = vi.fn(async (_text: string) => {});
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    await stream.push({ runId: "run-1", text: "First segment. " });

    await expect(stream.finish("First segment.")).resolves.toEqual({ suppressResponse: true });
    expect(deliver.mock.calls.map(([text]) => text)).toEqual(["First segment."]);
  });

  it("advances across paragraph boundaries while preserving delivery order", async () => {
    const deliver = vi.fn(async (_text: string) => {});
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    const text = "First paragraph\n\nSecond paragraph.";
    await stream.push({ runId: "run-1", text });

    await expect(stream.finish(text)).resolves.toEqual({ suppressResponse: true });
    expect(deliver.mock.calls.map(([spoken]) => spoken)).toEqual([
      "First paragraph",
      "Second paragraph.",
    ]);
  });

  it("does not repeat a streamed paragraph when the final trims its delimiter", async () => {
    const deliver = vi.fn(async (_text: string) => {});
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    await stream.push({ runId: "run-1", text: "First paragraph\n\n" });

    await expect(stream.finish("First paragraph\n\n")).resolves.toEqual({
      suppressResponse: true,
    });
    expect(deliver.mock.calls.map(([spoken]) => spoken)).toEqual(["First paragraph"]);
  });

  it("falls back to the completed result when streaming delivery fails", async () => {
    const onCancel = vi.fn();
    const stream = createRealtimeConsultSpeechStream({
      deliver: async () => {
        throw new Error("provider disconnected");
      },
      onCancel,
    });
    stream.start("run-1");

    await expect(stream.push({ runId: "run-1", text: "Partial result." })).rejects.toThrow(
      "provider disconnected",
    );
    await expect(stream.finish("Partial result. Final detail.")).resolves.toEqual({
      suppressResponse: false,
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("falls back to only the unspoken suffix after a later delivery fails", async () => {
    const deliver = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("provider disconnected"));
    const stream = createRealtimeConsultSpeechStream({ deliver });
    stream.start("run-1");

    await stream.push({ runId: "run-1", text: "First segment." });
    await expect(
      stream.push({ runId: "run-1", text: "First segment. Second segment." }),
    ).rejects.toThrow("provider disconnected");

    await expect(stream.finish("First segment. Second segment.")).resolves.toEqual({
      suppressResponse: false,
      fallbackText: "Second segment.",
    });
  });
});
