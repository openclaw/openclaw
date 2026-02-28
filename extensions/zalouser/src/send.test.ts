import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendImageZalouser,
  sendLinkZalouser,
  sendMessageZalouser,
  type ZalouserSendResult,
} from "./send.js";
import { runZca } from "./zca.js";

vi.mock("./zca.js", () => ({
  runZca: vi.fn(),
}));

const mockRunZca = vi.mocked(runZca);
const originalZcaProfile = process.env.ZCA_PROFILE;

function okResult(stdout = "message_id: msg-1") {
  return {
    ok: true,
    stdout,
    stderr: "",
    exitCode: 0,
  };
}

function failResult(stderr = "") {
  return {
    ok: false,
    stdout: "",
    stderr,
    exitCode: 1,
  };
}

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockRunZca.mockReset();
    delete process.env.ZCA_PROFILE;
  });

  afterEach(() => {
    if (originalZcaProfile) {
      process.env.ZCA_PROFILE = originalZcaProfile;
      return;
    }
    delete process.env.ZCA_PROFILE;
  });

  it("returns validation error when thread id is missing", async () => {
    const result = await sendMessageZalouser("", "hello");
    expect(result).toEqual({
      ok: false,
      error: "No threadId provided",
    } satisfies ZalouserSendResult);
    expect(mockRunZca).not.toHaveBeenCalled();
  });

  it("builds text send command with truncation and group flag", async () => {
    mockRunZca.mockResolvedValueOnce(okResult("message id: mid-123"));

    const result = await sendMessageZalouser("  thread-1  ", "x".repeat(2200), {
      profile: "profile-a",
      isGroup: true,
    });

    expect(mockRunZca).toHaveBeenCalledWith(["msg", "send", "thread-1", "x".repeat(2000), "-g"], {
      profile: "profile-a",
    });
    expect(result).toEqual({ ok: true, messageId: "mid-123" });
  });

  it("routes media sends from sendMessage and keeps text as caption", async () => {
    mockRunZca.mockResolvedValueOnce(okResult());

    await sendMessageZalouser("thread-2", "media caption", {
      profile: "profile-b",
      mediaUrl: "https://cdn.example.com/video.mp4",
      isGroup: true,
    });

    expect(mockRunZca).toHaveBeenCalledWith(
      [
        "msg",
        "video",
        "thread-2",
        "-u",
        "https://cdn.example.com/video.mp4",
        "-m",
        "media caption",
        "-g",
      ],
      { profile: "profile-b" },
    );
  });

  it("maps audio media to voice command", async () => {
    mockRunZca.mockResolvedValueOnce(okResult());

    await sendMessageZalouser("thread-3", "", {
      profile: "profile-c",
      mediaUrl: "https://cdn.example.com/clip.mp3",
    });

    expect(mockRunZca).toHaveBeenCalledWith(
      ["msg", "voice", "thread-3", "-u", "https://cdn.example.com/clip.mp3"],
      { profile: "profile-c" },
    );
  });

  it("builds image command with caption and returns fallback error", async () => {
    mockRunZca.mockResolvedValueOnce(failResult(""));

    const result = await sendImageZalouser("thread-4", " https://cdn.example.com/img.png ", {
      profile: "profile-d",
      caption: "caption text",
      isGroup: true,
    });

    expect(mockRunZca).toHaveBeenCalledWith(
      [
        "msg",
        "image",
        "thread-4",
        "-u",
        "https://cdn.example.com/img.png",
        "-m",
        "caption text",
        "-g",
      ],
      { profile: "profile-d" },
    );
    expect(result).toEqual({ ok: false, error: "Failed to send image" });
  });

  it("uses env profile fallback and builds link command", async () => {
    process.env.ZCA_PROFILE = "env-profile";
    mockRunZca.mockResolvedValueOnce(okResult("abc123"));

    const result = await sendLinkZalouser("thread-5", " https://openclaw.ai ", { isGroup: true });

    expect(mockRunZca).toHaveBeenCalledWith(
      ["msg", "link", "thread-5", "https://openclaw.ai", "-g"],
      { profile: "env-profile" },
    );
    expect(result).toEqual({ ok: true, messageId: "abc123" });
  });

  it("returns caught command errors", async () => {
    mockRunZca.mockRejectedValueOnce(new Error("zca unavailable"));

    await expect(sendLinkZalouser("thread-6", "https://openclaw.ai")).resolves.toEqual({
      ok: false,
      error: "zca unavailable",
    });
  });
});
