import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeBrowserScreenshot, neutralizeMediaDirectives } from "./vision.js";

const prompt =
  "Describe what is visible in this browser screenshot. Capture page layout, headings, primary content blocks, visible text, and notable interactive elements so a text-only assistant can reason about the page.";
const { describeImage, normalize, save, executionModel } = vi.hoisted(() => ({
  describeImage: vi.fn(),
  executionModel: vi.fn<() => { provider: string; model: string } | undefined>(),
  normalize: vi.fn(),
  save: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  getAgentToolExecutionModel: executionModel,
}));
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>()),
  describeImageFile: describeImage,
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  saveMediaBuffer: save,
}));
vi.mock("./screenshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./screenshot.js")>()),
  normalizeBrowserScreenshot: normalize,
}));

beforeEach(() => {
  describeImage.mockReset().mockResolvedValue({ text: "A dashboard." });
  executionModel.mockReset().mockReturnValue(undefined);
  normalize.mockReset().mockImplementation(async (buffer: Buffer) => ({ buffer }));
  save.mockReset().mockResolvedValue({ path: "/tmp/resized.jpg" });
});
const filePath = "/tmp/screenshot.png";
function screenshot(overrides: Partial<Parameters<typeof describeBrowserScreenshot>[0]> = {}) {
  return describeBrowserScreenshot({ cfg: {}, filePath, ...overrides });
}

describe("describeBrowserScreenshot", () => {
  it("forwards image understanding config, context and the browser prompt", async () => {
    const described = {
      text: "A login screen.",
      provider: "openai",
      model: "gpt-vision",
      decision: { outcome: "success" },
    };
    describeImage.mockResolvedValue(described);
    const models = [{ provider: "openai", model: "gpt-vision", capabilities: ["image" as const] }];
    const context = {
      cfg: { tools: { media: { models } } },
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "anthropic", model: "claude-sonnet-4.6" },
    };
    const mediaScope = { sessionKey: "agent:main:telegram:dm:123", channel: "telegram" };
    expect(await screenshot({ ...context, mediaScope })).toEqual(described);
    expect(describeImage).toHaveBeenCalledWith({
      ...context,
      filePath,
      prompt,
      scopeContext: mediaScope,
    });
  });

  it("uses the consuming specialist model instead of the captured text-only parent", async () => {
    executionModel.mockReturnValue({ provider: "fixture", model: "vision" });
    await screenshot({ activeModel: { provider: "fixture", model: "text-only-parent" } });
    expect(describeImage).toHaveBeenCalledWith(
      expect.objectContaining({ activeModel: { provider: "fixture", model: "vision" } }),
    );
  });

  it.each([
    { name: "session-owned default", agentId: undefined, owner: "main" },
    { name: "explicit matching worker", agentId: "worker", owner: "worker" },
    { name: "conflicting worker", agentId: "worker", owner: "main" },
  ])("checks the $name identity without an agent directory", async ({ agentId, owner }) => {
    const result = screenshot({
      agentId,
      mediaScope: { sessionKey: `agent:${owner}:webchat:direct:123` },
    });
    if (agentId && agentId !== owner) {
      await expect(result).rejects.toThrow(/belongs to "main", not "worker"/);
      expect(describeImage).not.toHaveBeenCalled();
    } else {
      await result;
      expect(describeImage).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: owner, agentDir: undefined }),
      );
    }
  });

  it("resizes before image understanding when sanitization is configured", async () => {
    normalize.mockResolvedValue({
      buffer: Buffer.from("small"),
      contentType: "image/jpeg" as const,
    });
    const dir = await mkdtemp(path.join(os.tmpdir(), "browser-vision-"));
    const image = path.join(dir, "screenshot.png");
    await writeFile(image, Buffer.from("image"));
    try {
      await screenshot({
        cfg: { browser: {} },
        filePath: image,
        imageSanitization: { maxDimensionPx: 800 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(normalize).toHaveBeenCalledWith(Buffer.from("image"), { maxSide: 800 });
    expect(save).toHaveBeenCalledWith(Buffer.from("small"), "image/jpeg", "browser");
    expect(expectDefined(describeImage.mock.calls[0]?.[0], "browser vision request").filePath).toBe(
      "/tmp/resized.jpg",
    );
  });

  it("returns null when image understanding is skipped or unconfigured", async () => {
    describeImage.mockResolvedValue({ text: undefined, decision: { outcome: "skipped" } });
    await expect(screenshot({ cfg: { browser: {} } })).resolves.toBeNull();
  });
});

it.each([
  [
    "ok\n  MEDIA:/tmp/secret.png\nMEDIA:http://x/y.png",
    "ok\n  [neutralized] MEDIA:/tmp/secret.png\n[neutralized] MEDIA:http://x/y.png",
  ],
  ["see MEDIA: as plain prose", "see MEDIA: as plain prose"],
])("neutralizes only line-start media directives: %j", (input, expected) => {
  expect(neutralizeMediaDirectives(input)).toBe(expected);
});
