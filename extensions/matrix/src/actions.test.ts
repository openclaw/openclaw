import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  handleMatrixAction: vi.fn(),
  resolveMatrixAccount: vi.fn(),
}));

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: mocks.handleMatrixAction,
}));

vi.mock("./matrix/accounts.js", () => ({
  resolveMatrixAccount: mocks.resolveMatrixAccount,
}));

import { matrixMessageActions } from "./actions.js";

describe("matrix message actions voice flags", () => {
  beforeEach(() => {
    mocks.handleMatrixAction.mockReset();
    mocks.resolveMatrixAccount.mockReset();
    mocks.resolveMatrixAccount.mockReturnValue({ enabled: true, configured: true });
    mocks.handleMatrixAction.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      details: { ok: true },
    });
  });

  it("maps asVoice to audioAsVoice for send action", async () => {
    await matrixMessageActions.handleAction({
      action: "send",
      params: {
        to: "!room:example.org",
        message: "voice",
        media: "https://example.org/voice.ogg",
        asVoice: true,
      },
      cfg: { channels: { matrix: {} } } as CoreConfig,
    } as never);

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        audioAsVoice: true,
      }),
      expect.any(Object),
    );
  });

  it("accepts audioAsVoice alias for send action", async () => {
    await matrixMessageActions.handleAction({
      action: "send",
      params: {
        to: "!room:example.org",
        message: "voice",
        media: "https://example.org/voice.ogg",
        audioAsVoice: true,
      },
      cfg: { channels: { matrix: {} } } as CoreConfig,
    } as never);

    expect(mocks.handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        audioAsVoice: true,
      }),
      expect.any(Object),
    );
  });
});
