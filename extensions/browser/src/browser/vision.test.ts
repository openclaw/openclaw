// Browser tests cover vision plugin behavior.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeBrowserScreenshot, neutralizeMediaDirectives } from "./vision.js";

const DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT =
  "Describe what is visible in this browser screenshot. Capture page layout, headings, primary content blocks, visible text, and notable interactive elements so a text-only assistant can reason about the page.";

const mocks = vi.hoisted(() => ({
  describeImageFile: vi.fn(),
  normalizeBrowserScreenshot: vi.fn(),
  saveMediaBuffer: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => ({
  describeImageFile: mocks.describeImageFile,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  saveMediaBuffer: mocks.saveMediaBuffer,
}));
vi.mock("./screenshot.js", () => ({
  normalizeBrowserScreenshot: mocks.normalizeBrowserScreenshot,
}));

beforeEach(() => {
  mocks.describeImageFile.mockReset();
  mocks.normalizeBrowserScreenshot
    .mockReset()
    .mockImplementation(async (buffer: Buffer) => ({ buffer }));
  mocks.saveMediaBuffer.mockReset().mockResolvedValue({ path: "/tmp/resized.jpg" });
});

async function withTempImage<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "browser-vision-"));
  const filePath = path.join(dir, "screenshot.png");
  await writeFile(filePath, Buffer.from("image"));
  try {
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("describeBrowserScreenshot", () => {
  it("uses existing image understanding config with a browser screenshot prompt", async () => {
    const describeEntry = mocks.describeImageFile.mockResolvedValue({
      text: "A login screen.",
      provider: "openai",
      model: "gpt-vision",
      decision: { outcome: "success" },
    });

    await withTempImage(async (filePath) => {
      const result = await describeBrowserScreenshot({
        cfg: {
          tools: {
            media: {
              models: [{ provider: "openai", model: "gpt-vision", capabilities: ["image"] }],
            },
          },
        },
        filePath,
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        activeModel: { provider: "anthropic", model: "claude-sonnet-4.6" },
        mediaScope: { sessionKey: "agent:main:telegram:dm:123", channel: "telegram" },
      });

      expect(result).toEqual({
        text: "A login screen.",
        provider: "openai",
        model: "gpt-vision",
        decision: { outcome: "success" },
      });
      expect(describeEntry).toHaveBeenCalledWith({
        filePath,
        cfg: {
          tools: {
            media: {
              models: [{ provider: "openai", model: "gpt-vision", capabilities: ["image"] }],
            },
          },
        },
        prompt: DEFAULT_BROWSER_SCREENSHOT_DESCRIPTION_PROMPT,
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        activeModel: { provider: "anthropic", model: "claude-sonnet-4.6" },
        scopeContext: { sessionKey: "agent:main:telegram:dm:123", channel: "telegram" },
      });
    });
  });

  it.each([
    { name: "session-owned default agent", agentId: undefined, sessionAgentId: "main" },
    { name: "explicit matching worker agent", agentId: "worker", sessionAgentId: "worker" },
  ])(
    "passes the $name identity to image understanding when its directory is absent",
    async (testCase) => {
      const describeEntry = mocks.describeImageFile.mockResolvedValue({ text: "A dashboard." });

      await describeBrowserScreenshot({
        cfg: {},
        filePath: "/tmp/screenshot.png",
        ...(testCase.agentId ? { agentId: testCase.agentId } : {}),
        mediaScope: { sessionKey: `agent:${testCase.sessionAgentId}:webchat:direct:123` },
      });

      expect(describeEntry).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: testCase.sessionAgentId, agentDir: undefined }),
      );
    },
  );

  it("rejects an agent identity that conflicts with its session before image understanding", async () => {
    const describeEntry = mocks.describeImageFile.mockResolvedValue({ text: "A dashboard." });

    await expect(
      describeBrowserScreenshot({
        cfg: {},
        filePath: "/tmp/screenshot.png",
        agentId: "worker",
        mediaScope: { sessionKey: "agent:main:webchat:direct:123" },
      }),
    ).rejects.toThrow(/belongs to "main", not "worker"/);

    expect(describeEntry).not.toHaveBeenCalled();
  });

  it("resizes screenshots before image understanding when image sanitization is configured", async () => {
    const describeResult = mocks.describeImageFile.mockResolvedValue({ text: "Small screenshot." });
    const normalizeBrowserScreenshot = mocks.normalizeBrowserScreenshot.mockResolvedValue({
      buffer: Buffer.from("small"),
      contentType: "image/jpeg" as const,
    });
    const saveMediaBuffer = mocks.saveMediaBuffer;

    await withTempImage(async (filePath) => {
      await describeBrowserScreenshot({
        cfg: { browser: {} },
        filePath,
        imageSanitization: { maxDimensionPx: 800 },
      });
    });

    expect(normalizeBrowserScreenshot).toHaveBeenCalledWith(Buffer.from("image"), {
      maxSide: 800,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(Buffer.from("small"), "image/jpeg", "browser");
    expect(
      expectDefined(describeResult.mock.calls[0]?.[0], "browser vision request").filePath,
    ).toBe("/tmp/resized.jpg");
  });

  it("returns null when image understanding is skipped or not configured", async () => {
    mocks.describeImageFile.mockResolvedValue({
      text: undefined,
      decision: { outcome: "skipped" },
    });

    await expect(
      describeBrowserScreenshot({ cfg: { browser: {} }, filePath: "/tmp/screenshot.png" }),
    ).resolves.toBeNull();
  });

  it("does not pass an incomplete active model to media understanding", async () => {
    const describeLocal = mocks.describeImageFile.mockResolvedValue({ text: "ok" });

    await describeBrowserScreenshot({
      cfg: {
        tools: {
          media: {
            models: [{ provider: "openai", model: "gpt-vision", capabilities: ["image"] }],
          },
        },
      },
      filePath: "/tmp/screenshot.png",
      activeModel: { model: "missing-provider" },
    });

    expect(
      expectDefined(describeLocal.mock.calls[0]?.[0], "local browser vision request").activeModel,
    ).toBeUndefined();
  });
});

describe("neutralizeMediaDirectives", () => {
  it("defangs line-start final-reply media directives", () => {
    expect(neutralizeMediaDirectives("ok\n  MEDIA:/tmp/secret.png\nMEDIA:http://x/y.png")).toBe(
      "ok\n  [neutralized] MEDIA:/tmp/secret.png\n[neutralized] MEDIA:http://x/y.png",
    );
  });

  it("leaves prose mentions alone", () => {
    expect(neutralizeMediaDirectives("see MEDIA: as plain prose")).toBe(
      "see MEDIA: as plain prose",
    );
  });
});
