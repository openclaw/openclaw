import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const draftStream = vi.hoisted(() => ({
  update: vi.fn<(text: string) => void>(),
  flush: vi.fn(async () => {}),
  stop: vi.fn(async () => undefined),
  discardPending: vi.fn(async () => {}),
  seal: vi.fn(async () => {}),
  clear: vi.fn(async () => {}),
  cleanupPending: vi.fn(async () => {}),
  deleteCurrentMessage: vi.fn(async () => {}),
  finalizeLive: vi.fn(async () => true),
  reset: vi.fn(),
  eventId: vi.fn<() => string | undefined>(() => undefined),
  content: vi.fn(() => undefined),
  matchesPreparedText: vi.fn(() => false),
  mustDeliverFinalNormally: vi.fn(() => false),
}));

vi.mock("./handler-runtime.js", () => ({
  loadMatrixDraftStream: async () => ({
    createMatrixDraftStream: () => draftStream,
  }),
}));

import { createMatrixDraftController } from "./handler-draft-controller.js";

describe("Matrix progress visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(draftStream)) {
      mock.mockClear();
    }
    draftStream.eventId.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the headline until the next preamble completes", async () => {
    const controller = await createMatrixDraftController({
      streaming: "progress",
      previewToolProgressEnabled: true,
      replyToMode: "off",
      messageId: "$inbound",
      cfg: {},
      accountConfig: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, label: false, maxLines: 1 },
        },
      },
      accountId: "default",
      roomId: "!room:example.org",
      client: {} as never,
      logVerboseMessage: vi.fn(),
    });
    const options = controller.buildPreviewToolProgressReplyOptions();
    draftStream.eventId.mockReturnValue("$draft");
    try {
      // Normal activity opens the gate; a headline alone must not.
      await options.onItemEvent?.({ itemId: "work", progressText: "Inspecting files" });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(draftStream.update).toHaveBeenCalledOnce();
      draftStream.update.mockClear();

      for (const [index, text] of ["Checking the source.", "Preparing the fix."].entries()) {
        const preamble = { kind: "preamble", itemId: `preamble-${index}`, progressText: text };
        await options.onItemEvent?.({ ...preamble, phase: "update" });
        expect(draftStream.update).toHaveBeenCalledTimes(index);

        expect(await options.onItemEvent?.({ ...preamble, phase: "end" })).toBe(true);
        expect(draftStream.update).toHaveBeenCalledTimes(index + 1);
        const rendered = draftStream.update.mock.lastCall?.[0];
        expect(rendered?.startsWith(`\`${text}\``)).toBe(true);
        expect(rendered?.split(text)).toHaveLength(2);
        if (index === 1) {
          expect(rendered).not.toContain("Checking the source.");
        }
      }
    } finally {
      controller.cancelProgressDraft();
    }
  });

  it("retries identical progress until Matrix acknowledges a draft event", async () => {
    const controller = await createMatrixDraftController({
      streaming: "progress",
      previewToolProgressEnabled: true,
      replyToMode: "off",
      messageId: "$inbound",
      cfg: {},
      accountId: "default",
      roomId: "!room:example.org",
      client: {} as never,
      logVerboseMessage: vi.fn(),
    });
    const options = controller.buildPreviewToolProgressReplyOptions();
    expect(options.progressPreambleEnabled).toBe(true);
    const progress = { itemId: "item-1", progressText: "still working" };

    expect(await options.onItemEvent?.(progress)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(draftStream.update).toHaveBeenCalledTimes(1);

    expect(await options.onItemEvent?.(progress)).toBe(false);
    expect(draftStream.update).toHaveBeenCalledTimes(2);

    draftStream.eventId.mockReturnValue("$draft");
    expect(await options.onItemEvent?.(progress)).toBe(true);
    expect(draftStream.update).toHaveBeenCalledTimes(3);
    controller.cancelProgressDraft();
  });
});
