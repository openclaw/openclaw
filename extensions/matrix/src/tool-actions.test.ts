import { describe, expect, it, vi } from "vitest";

// Mock the matrix actions module so we can inspect `sendMatrixMessage` calls
// without requiring a real Matrix client.
vi.mock("./matrix/actions.js", () => ({
  sendMatrixMessage: vi.fn().mockResolvedValue({ messageId: "evt-1", roomId: "!room:test" }),
  editMatrixMessage: vi.fn(),
  deleteMatrixMessage: vi.fn(),
  readMatrixMessages: vi.fn(),
  getMatrixMemberInfo: vi.fn(),
  getMatrixRoomInfo: vi.fn(),
  listMatrixPins: vi.fn(),
  listMatrixReactions: vi.fn(),
  pinMatrixMessage: vi.fn(),
  removeMatrixReactions: vi.fn(),
  unpinMatrixMessage: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  reactMatrixMessage: vi.fn(),
}));

import { sendMatrixMessage } from "./matrix/actions.js";
import { handleMatrixAction } from "./tool-actions.js";
import type { CoreConfig } from "./types.js";

const baseCfg = { channels: { matrix: { actions: {} } } } as unknown as CoreConfig;

describe("handleMatrixAction – sendMessage", () => {
  it("forwards audioAsVoice to sendMatrixMessage", async () => {
    await handleMatrixAction(
      {
        action: "sendMessage",
        to: "!room:example.org",
        content: "",
        mediaUrl: "https://example.com/voice.ogg",
        audioAsVoice: true,
      },
      baseCfg,
    );

    expect(sendMatrixMessage).toHaveBeenCalledTimes(1);
    expect(sendMatrixMessage).toHaveBeenCalledWith(
      "!room:example.org",
      "",
      expect.objectContaining({ audioAsVoice: true }),
    );
  });

  it("defaults audioAsVoice to false when not provided", async () => {
    vi.mocked(sendMatrixMessage).mockClear();

    await handleMatrixAction(
      {
        action: "sendMessage",
        to: "!room:example.org",
        content: "hello",
      },
      baseCfg,
    );

    expect(sendMatrixMessage).toHaveBeenCalledTimes(1);
    expect(sendMatrixMessage).toHaveBeenCalledWith(
      "!room:example.org",
      "hello",
      expect.objectContaining({ audioAsVoice: false }),
    );
  });
});
