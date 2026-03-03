import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixMessageActions } from "./actions.js";
import { handleMatrixAction } from "./tool-actions.js";

vi.mock("./tool-actions.js", () => ({
  handleMatrixAction: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: '{"ok":true}' }],
  }),
}));

describe("matrixMessageActions send voice flags", () => {
  const handleAction = matrixMessageActions.handleAction!;

  const cfg = (): OpenClawConfig =>
    ({
      channels: {
        matrix: {
          enabled: true,
        },
      },
    }) as OpenClawConfig;

  const callSend = async (params: Record<string, unknown>) =>
    await handleAction({
      channel: "matrix",
      action: "send",
      cfg: cfg(),
      params,
      accountId: null,
    });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps asVoice to audioAsVoice when forwarding sendMessage action", async () => {
    await callSend({
      to: "room:!abc:example.org",
      message: "",
      media: "https://example.org/voice.ogg",
      asVoice: true,
    });

    expect(handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        audioAsVoice: true,
      }),
      expect.any(Object),
    );
  });

  it("prefers explicit audioAsVoice over asVoice alias", async () => {
    await callSend({
      to: "room:!abc:example.org",
      message: "",
      media: "https://example.org/voice.ogg",
      asVoice: false,
      audioAsVoice: true,
    });

    expect(handleMatrixAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        audioAsVoice: true,
      }),
      expect.any(Object),
    );
  });
});
