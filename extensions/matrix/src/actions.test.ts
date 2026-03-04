import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixMessageActions } from "./actions.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleMatrixAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: mocks.handleMatrixAction,
}));

function createSendCtx(params: Record<string, unknown>) {
  return {
    channel: "matrix",
    action: "send",
    params,
    cfg: {} as CoreConfig,
  };
}

describe("matrixMessageActions send voice flag forwarding", () => {
  beforeEach(() => {
    mocks.handleMatrixAction.mockClear();
  });

  it("forwards asVoice to sendMessage audioAsVoice", async () => {
    await matrixMessageActions.handleAction?.(
      createSendCtx({
        to: "room:!room:example.org",
        message: "voice caption",
        media: "file:///tmp/voice.ogg",
        asVoice: true,
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        audioAsVoice: true,
      }),
      expect.any(Object),
    );
  });

  it("forwards audioAsVoice to sendMessage", async () => {
    await matrixMessageActions.handleAction?.(
      createSendCtx({
        to: "room:!room:example.org",
        message: "voice caption",
        media: "file:///tmp/voice.ogg",
        audioAsVoice: true,
      }),
    );

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        audioAsVoice: true,
      }),
      expect.any(Object),
    );
  });
});
