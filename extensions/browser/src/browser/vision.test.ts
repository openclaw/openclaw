import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BROWSER_VISION_PROMPT,
  describeBrowserImageWithVision,
  getBrowserVisionConfig,
  isBrowserVisionEnabled,
} from "./vision.js";

type DescribeFn = ReturnType<typeof vi.fn>;

function makeDeps(describe: DescribeFn) {
  return { describeImageFileWithModel: describe as never };
}

describe("isBrowserVisionEnabled", () => {
  it("returns false when cfg is undefined", () => {
    expect(isBrowserVisionEnabled(undefined)).toBe(false);
  });

  it("returns false when browser.models is missing", () => {
    expect(isBrowserVisionEnabled({})).toBe(false);
  });

  it("returns false when browser.models is empty", () => {
    expect(isBrowserVisionEnabled({ browser: { models: [] } })).toBe(false);
  });

  it("returns false when no entry has both provider and model", () => {
    expect(
      isBrowserVisionEnabled({
        browser: { models: [{ provider: "openai" }, { model: "gpt-vision" }] },
      }),
    ).toBe(false);
  });

  it("returns false when visionEnabled is explicitly false even if models exist", () => {
    expect(
      isBrowserVisionEnabled({
        browser: {
          visionEnabled: false,
          models: [{ provider: "openai", model: "gpt-vision" }],
        },
      }),
    ).toBe(false);
  });

  it("returns true when at least one entry has both provider and model", () => {
    expect(
      isBrowserVisionEnabled({
        browser: {
          models: [{ provider: "openai", model: "gpt-vision" }, { provider: "incomplete" }],
        },
      }),
    ).toBe(true);
  });

  it("ignores CLI-style entries", () => {
    expect(
      isBrowserVisionEnabled({
        browser: {
          models: [{ type: "cli", provider: "openai", model: "gpt-vision", command: "cmd" }],
        },
      }),
    ).toBe(false);
  });
});

describe("getBrowserVisionConfig", () => {
  it("returns undefined when cfg is missing", () => {
    expect(getBrowserVisionConfig(undefined)).toBeUndefined();
    expect(getBrowserVisionConfig({})).toBeUndefined();
    expect(getBrowserVisionConfig({ browser: {} })).toBeUndefined();
  });

  it("returns the vision config from browser block when present", () => {
    const cfg = {
      browser: {
        visionPrompt: "describe me",
        models: [{ provider: "openai", model: "gpt-vision" }],
      },
    };
    const visionCfg = getBrowserVisionConfig(cfg);
    expect(visionCfg?.models).toEqual(cfg.browser.models);
    expect(visionCfg?.prompt).toBe("describe me");
  });
});

describe("describeBrowserImageWithVision", () => {
  it("throws when no candidates are configured (caller misuse guard)", async () => {
    await expect(
      describeBrowserImageWithVision(
        { cfg: undefined, filePath: "/tmp/screenshot.png" },
        makeDeps(vi.fn()),
      ),
    ).rejects.toThrow(/not configured/);
  });

  it("uses the first candidate and returns its text", async () => {
    const describe = vi.fn().mockResolvedValue({ text: "A login screen.", model: "gpt-vision" });
    const result = await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            models: [{ provider: "openai", model: "gpt-vision" }],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    expect(result.text).toBe("A login screen.");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-vision");
    expect(result.attempts).toEqual([]);
    expect(describe).toHaveBeenCalledTimes(1);
    const args = describe.mock.calls[0][0] as Record<string, unknown>;
    expect(args.provider).toBe("openai");
    expect(args.model).toBe("gpt-vision");
    expect(args.filePath).toBe("/tmp/screenshot.png");
    expect(args.prompt).toBe(DEFAULT_BROWSER_VISION_PROMPT);
  });

  it("does not forward local file paths as mediaUrl", async () => {
    const describe = vi.fn().mockResolvedValue({ text: "ok", model: "gpt-vision" });
    await describeBrowserImageWithVision(
      {
        cfg: {
          browser: { models: [{ provider: "openai", model: "gpt-vision" }] },
        },
        filePath: "/tmp/screenshot.png",
        mediaUrl: "/Users/someone/.openclaw/media/browser/abc.jpg",
      },
      makeDeps(describe),
    );
    const args = describe.mock.calls[0][0] as Record<string, unknown>;
    expect(args.mediaUrl).toBeUndefined();
    expect(args.filePath).toBe("/tmp/screenshot.png");
  });

  it("forwards HTTP(S) mediaUrl to describeImageFileWithModel", async () => {
    const describe = vi.fn().mockResolvedValue({ text: "ok", model: "gpt-vision" });
    await describeBrowserImageWithVision(
      {
        cfg: {
          browser: { models: [{ provider: "openai", model: "gpt-vision" }] },
        },
        filePath: "/tmp/screenshot.png",
        mediaUrl: "https://cdn.example.com/screenshot.jpg",
      },
      makeDeps(describe),
    );
    const args = describe.mock.calls[0][0] as Record<string, unknown>;
    expect(args.mediaUrl).toBe("https://cdn.example.com/screenshot.jpg");
  });

  it("uses configured prompt and timeoutSeconds (in milliseconds) overrides", async () => {
    const describe = vi.fn().mockResolvedValue({ text: "ok", model: "gpt-vision" });
    await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            visionPrompt: "Read the headlines",
            visionTimeoutSeconds: 45,
            models: [{ provider: "openai", model: "gpt-vision" }],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    const args = describe.mock.calls[0][0] as Record<string, unknown>;
    expect(args.prompt).toBe("Read the headlines");
    expect(args.timeoutMs).toBe(45_000);
  });

  it("prefers per-entry prompt/timeout/maxChars over defaults", async () => {
    const describe = vi.fn().mockResolvedValue({ text: "ok", model: "gpt-vision" });
    await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            visionPrompt: "default prompt",
            visionTimeoutSeconds: 10,
            visionMaxChars: 100,
            models: [
              {
                provider: "openai",
                model: "gpt-vision",
                prompt: "custom prompt",
                timeoutSeconds: 90,
                maxChars: 1000,
              },
            ],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    const args = describe.mock.calls[0][0] as Record<string, unknown>;
    expect(args.prompt).toBe("custom prompt");
    expect(args.timeoutMs).toBe(90_000);
  });

  it("falls through to subsequent candidates when earlier ones fail", async () => {
    const describe = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce({ text: "Second model worked.", model: "fallback-vision" });

    const result = await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            models: [
              { provider: "primary", model: "p" },
              { provider: "secondary", model: "fallback-vision" },
            ],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    expect(describe).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Second model worked.");
    expect(result.provider).toBe("secondary");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toEqual({
      provider: "primary",
      model: "p",
      error: "rate limited",
    });
  });

  it("treats empty model text as a failed candidate and tries the next one", async () => {
    const describe = vi
      .fn()
      .mockResolvedValueOnce({ text: "   \n  ", model: "p" })
      .mockResolvedValueOnce({ text: "Actual text.", model: "fallback-vision" });

    const result = await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            models: [
              { provider: "primary", model: "p" },
              { provider: "secondary", model: "fallback-vision" },
            ],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    expect(describe).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("Actual text.");
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.error).toMatch(/empty/i);
  });

  it("throws an aggregate error when all candidates fail", async () => {
    const describe = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockRejectedValueOnce(new Error("network down"));

    await expect(
      describeBrowserImageWithVision(
        {
          cfg: {
            browser: {
              models: [
                { provider: "primary", model: "p" },
                { provider: "secondary", model: "s" },
              ],
            },
          },
          filePath: "/tmp/screenshot.png",
        },
        makeDeps(describe),
      ),
    ).rejects.toThrow(/primary\/p: rate limited; secondary\/s: network down/);
  });

  it("truncates descriptions that exceed maxChars and appends a truncation marker", async () => {
    const longText = "A".repeat(2_000);
    const describe = vi.fn().mockResolvedValue({ text: longText, model: "gpt-vision" });

    const result = await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            visionMaxChars: 100,
            models: [{ provider: "openai", model: "gpt-vision" }],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text.endsWith("[truncated]")).toBe(true);
  });

  it("skips candidates when file size exceeds maxBytes", async () => {
    // Create a temp file larger than 50 bytes to trigger the maxBytes guard.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-test-"));
    const bigFile = path.join(tmpDir, "big.jpg");
    await fs.writeFile(bigFile, Buffer.alloc(200)); // 200 bytes

    const describe = vi.fn().mockResolvedValue({ text: "ok", model: "gpt-vision" });
    await expect(
      describeBrowserImageWithVision(
        {
          cfg: {
            browser: {
              visionMaxBytes: 50,
              models: [{ provider: "openai", model: "gpt-vision" }],
            },
          },
          filePath: bigFile,
        },
        makeDeps(describe),
      ),
    ).rejects.toThrow(/exceeds maxBytes/);
    expect(describe).not.toHaveBeenCalled();

    await fs.rm(tmpDir, { recursive: true });
  });

  it("forwards profile and preferredProfile to describeImageFileWithModel", async () => {
    const describe = vi.fn().mockResolvedValue({ text: "ok", model: "gpt-vision" });
    await describeBrowserImageWithVision(
      {
        cfg: {
          browser: {
            models: [
              {
                provider: "openai",
                model: "gpt-vision",
                profile: "my-profile",
                preferredProfile: "my-preferred",
              },
            ],
          },
        },
        filePath: "/tmp/screenshot.png",
      },
      makeDeps(describe),
    );
    const args = describe.mock.calls[0][0] as Record<string, unknown>;
    expect(args.profile).toBe("my-profile");
    expect(args.preferredProfile).toBe("my-preferred");
  });
});
