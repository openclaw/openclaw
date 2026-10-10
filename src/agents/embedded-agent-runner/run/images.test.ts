// Prompt image tests cover local reference parsing, sandbox-aware loading, and
// attachment ordering for embedded runs that send images to vision models.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNoisyPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptImageOrder,
} from "../../../media/media-facts.js";
import {
  buildPersistedUserTurnMessage,
  mergePreparedUserTurnMessageForRuntime,
} from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createUnsafeMountedSandbox } from "../../test-helpers/unsafe-mounted-sandbox.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  hydratePromptMediaMessages,
} from "./images.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const TINY_GIF_BUFFER = Buffer.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

function expectNoPromptImages(result: { detectedRefs: unknown[]; images: unknown[] }) {
  expect(result.detectedRefs).toHaveLength(0);
  expect(result.images).toHaveLength(0);
}

function expectNoImageReferences(prompt: string) {
  const refs = detectImageReferences(prompt);
  expect(refs).toHaveLength(0);
}

function expectImageReferenceCount(prompt: string, count: number) {
  const refs = detectImageReferences(prompt);
  expect(refs).toHaveLength(count);
  return refs;
}

function expectSingleImageReference(prompt: string) {
  // Most parser cases should find exactly one local image ref; this helper
  // keeps failures about over-detection obvious.
  const refs = expectImageReferenceCount(prompt, 1);
  return refs[0];
}

describe("detectImageReferences", () => {
  it("detects home directory paths starting with ~/", () => {
    const ref = expectSingleImageReference("My photo is at ~/Pictures/vacation.png");

    expect(ref).toStrictEqual({
      raw: "~/Pictures/vacation.png",
      type: "path",
      resolved: path.join(process.env.HOME ?? os.homedir(), "Pictures/vacation.png"),
    });
  });

  it("ignores OpenClaw CLI image cache paths from prior prompt transcripts", () => {
    // Cache paths from generated tool reminders are replay artifacts, not new
    // user attachments to hydrate again.
    const refs = detectImageReferences(
      [
        '<system-reminder>Called the Read tool with {"file_path":"/Users/ada/.openclaw/workspace/.openclaw-cli-images/stale.png"}</system-reminder>',
        "Compare it with /Users/ada/Pictures/current.png",
      ].join("\n"),
    );

    expect(refs).toStrictEqual([
      {
        raw: "/Users/ada/Pictures/current.png",
        type: "path",
        resolved: "/Users/ada/Pictures/current.png",
      },
    ]);
  });

  it("ignores temporary OpenClaw CLI image cache paths", () => {
    expectNoImageReferences(
      `Prior turn wrote ${path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", "stale.jpg")}`,
    );
    expectNoImageReferences(
      `[media attached: ${path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", "stale.jpg")} (image/jpeg)]`,
    );
    expectNoImageReferences(
      `Prior turn wrote ${path.join(os.tmpdir(), "openclaw", "openclaw-cli-images", "stale.jpg")}`,
    );
    expectNoImageReferences(
      `Prior turn wrote ${path.join(os.tmpdir(), "openclaw-501", "openclaw-cli-images", "stale.jpg")}`,
    );
  });

  it("ignores file URLs into the OpenClaw CLI image cache", () => {
    const stalePath = path.join(os.tmpdir(), "openclaw", "openclaw-cli-images", "stale.png");

    expectNoImageReferences(`Prior turn wrote ${pathToFileURL(stalePath).href}`);
  });

  it("detects normal user image paths in similarly named directories", () => {
    expect(detectImageReferences("/workspace/openclaw-cli-images/current.png")).toStrictEqual([
      {
        raw: "/workspace/openclaw-cli-images/current.png",
        type: "path",
        resolved: "/workspace/openclaw-cli-images/current.png",
      },
    ]);
  });

  it("does not leak parser state between calls", () => {
    expect(detectImageReferences("See /tmp/first.png")).toStrictEqual([
      { raw: "/tmp/first.png", type: "path", resolved: "/tmp/first.png" },
    ]);
    expect(detectImageReferences("See /tmp/second.jpg")).toStrictEqual([
      { raw: "/tmp/second.jpg", type: "path", resolved: "/tmp/second.jpg" },
    ]);
    const thirdPath = path.join(os.tmpdir(), "third.webp");
    const thirdUrl = pathToFileURL(thirdPath).href;
    expect(detectImageReferences(`See ${thirdUrl}`)).toStrictEqual([
      { raw: thirdUrl, type: "path", resolved: thirdPath },
    ]);
    expect(detectImageReferences("See ./fourth.jpeg")).toStrictEqual([
      { raw: "./fourth.jpeg", type: "path", resolved: "./fourth.jpeg" },
    ]);
  });

  it("deduplicates repeated image references", () => {
    expect(
      detectImageReferences("Look at /path/image.png and also /path/image.png again"),
    ).toStrictEqual([
      {
        raw: "/path/image.png",
        type: "path",
        resolved: "/path/image.png",
      },
    ]);
  });

  it("dedupe casing follows host filesystem conventions", () => {
    // Windows resolves these as the same path, while POSIX hosts preserve both
    // candidates because case can identify different files.
    const prompt = "Look at /tmp/Image.png and /tmp/image.png";
    if (process.platform === "win32") {
      expect(detectImageReferences(prompt)).toStrictEqual([
        {
          raw: "/tmp/Image.png",
          type: "path",
          resolved: "/tmp/Image.png",
        },
      ]);
      return;
    }
    expect(detectImageReferences(prompt)).toStrictEqual([
      {
        raw: "/tmp/Image.png",
        type: "path",
        resolved: "/tmp/Image.png",
      },
      {
        raw: "/tmp/image.png",
        type: "path",
        resolved: "/tmp/image.png",
      },
    ]);
  });

  it("detects Windows drive image paths in plain prompts", () => {
    const ref = expectSingleImageReference(
      String.raw`Look at C:\Users\Ada\Pictures\screenshot.png`,
    );

    expect(ref).toStrictEqual({
      raw: String.raw`C:\Users\Ada\Pictures\screenshot.png`,
      type: "path",
      resolved: String.raw`C:\Users\Ada\Pictures\screenshot.png`,
    });
  });

  it("ignores remote URLs entirely (local-only)", () => {
    const refs = expectImageReferenceCount(
      `To send an image: MEDIA:https://example.com/image.jpg
Here is my actual image: /path/to/real.png
Also https://cdn.mysite.com/img.jpg`,
      1,
    );

    expect(refs).toStrictEqual([
      {
        raw: "/path/to/real.png",
        type: "path",
        resolved: "/path/to/real.png",
      },
    ]);
  });

  it("ignores remote-host file URLs", () => {
    expectNoImageReferences("See file://attacker/share/evil.png");
  });
});

describe("detectAndLoadPromptImages", () => {
  it("returns no images for non-vision models even when existing images are provided", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "ignore",
      workspaceDir: "/tmp",
      model: { input: ["text"] },
      existingImages: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });

    expectNoPromptImages(result);
  });

  it("sanitizes existing images even when prompt has no image references", async () => {
    const result = await detectAndLoadPromptImages({
      prompt: "describe the attached image",
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [{ type: "image", data: "not-valid-base64", mimeType: "image/png" }],
    });

    expect(result.images).toHaveLength(0);
    expect(result.detectedRefs).toHaveLength(0);
  });

  it("skips generated media-note refs already supplied inline", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-dedupe-"));
    const imagePath = path.join(stateDir, "photo.png");
    const pngB64 = TINY_PNG_BASE64;
    await fs.writeFile(imagePath, Buffer.from(pngB64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "[media attached: ./photo.png (image/png)]\ndescribe it",
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir: stateDir,
        model: { input: ["text", "image"] },
        existingImages: [{ type: "image", data: pngB64, mimeType: "image/png" }],
        imageOrder: ["inline"],
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toEqual([{ raw: imagePath, type: "path", resolved: imagePath }]);
      expect(result.loadedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.images).toEqual([{ type: "image", data: pngB64, mimeType: "image/png" }]);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses a described fact identity to suppress its generated media-note path", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-described-dedupe-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: `[media attached: ${imagePath} (image/png)]`,
        media: buildInboundMediaNoteProjection({
          media: [{ path: imagePath, contentType: "image/png" }],
          MediaUnderstanding: [
            {
              kind: "image.description",
              attachmentIndex: 0,
              text: "already described",
              provider: "test",
            },
          ],
        }).media,
        workspaceDir,
        model: { input: ["text", "image"] },
      });

      expect(result.detectedRefs).toEqual([{ raw: imagePath, type: "path", resolved: imagePath }]);
      expect(result.loadedCount).toBe(0);
      expect(result.images).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("dedupes a relative fact projection against the fact workspace", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fact-workspace-dedupe-"));
    const stagedDir = path.join(rootDir, "staged");
    const currentDir = path.join(rootDir, "current");
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(path.join(stagedDir, "photo.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(path.join(currentDir, "photo.png"), TINY_GIF_BUFFER);

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "[media attached: ./photo.png (image/png)]",
        media: [{ path: "./photo.png", contentType: "image/png", workspaceDir: stagedDir }],
        workspaceDir: currentDir,
        model: { input: ["text", "image"] },
        localRoots: [stagedDir, currentDir],
      });

      expect(result.loadedCount).toBe(1);
      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps inline fact indexes aligned when an earlier attachment is suppressed", async () => {
    const kept = {
      type: "image" as const,
      data: TINY_GIF_BUFFER.toString("base64"),
      mimeType: "image/gif",
    };
    const result = await detectAndLoadPromptImages({
      prompt: "describe the remaining image",
      workspaceDir: "/tmp",
      model: { input: ["text", "image"] },
      existingImages: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }, kept],
      media: [{ contentType: "image/png" }, { contentType: "image/gif" }],
      mediaImageLayout: {
        slots: [
          { kind: "inline", factIndex: 0 },
          { kind: "inline", factIndex: 1 },
        ],
        suppressedFactIndexes: [0],
      },
    });
    expect(result.images).toEqual([kept]);
    expect(result.imageFactIndexes).toEqual([1]);
  });

  it("classifies prompt and attachment refs while preserving mixed attachment order", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-order-"));
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, "att-b.gif"), TINY_GIF_BUFFER);
    await fs.writeFile(
      path.join(inboundDir, "prompt-ref.png"),
      Buffer.from(TINY_PNG_BASE64, "base64"),
    );
    await fs.writeFile(path.join(stateDir, "prompt-b.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const prompt =
      "compare [media attached: media://inbound/prompt-ref.png] and ./prompt-b.png\n[media attached: media://inbound/att-b.gif]";

    try {
      const result = await detectAndLoadPromptImages({
        prompt,
        media: [{ url: "media://inbound/att-b.gif", contentType: "image/gif" }],
        workspaceDir: stateDir,
        model: { input: ["text", "image"] },
        existingImages: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
        imageOrder: ["offloaded", "inline"],
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toEqual([
        {
          raw: "media://inbound/att-b.gif",
          type: "media-uri",
          resolved: "media://inbound/att-b.gif",
        },
        { raw: "./prompt-b.png", type: "path", resolved: "./prompt-b.png" },
      ]);
      expect(result.loadedCount).toBe(2);
      expect(result.images).toEqual([
        { type: "image", data: TINY_GIF_BUFFER.toString("base64"), mimeType: "image/gif" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves an empty described-image slot in mixed attachment order", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-described-image-order-"));
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "remaining.gif";
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), TINY_GIF_BUFFER);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "compare",
        media: [
          { kind: "image" },
          { kind: "image" },
          { url: `media://inbound/${mediaId}`, contentType: "image/gif" },
        ],
        workspaceDir: stateDir,
        model: { input: ["text", "image"] },
        existingImages: [inlineImage],
        imageOrder: ["offloaded", "inline", "offloaded"],
      });

      expect(result.images).toEqual([
        inlineImage,
        { type: "image", data: TINY_GIF_BUFFER.toString("base64"), mimeType: "image/gif" },
      ]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not load an explicit prompt ref twice when the same fact owns it", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-fact-"));
    await fs.writeFile(path.join(workspaceDir, "same.png"), Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "Compare ./same.png",
        media: [{ path: "./same.png", contentType: "image/png", workspaceDir }],
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toEqual([
        { raw: "./same.png", type: "path", resolved: "./same.png" },
      ]);
      expect(result.loadedCount).toBe(1);
      expect(result.images).toHaveLength(1);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("blocks prompt image refs outside workspace when sandbox workspaceOnly is enabled", async () => {
    // Sandbox workspaceOnly uses the bridge to validate mounted paths; ordinary
    // prompt refs outside the workspace are detected but intentionally skipped.
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-sandbox-"));
    const sandboxRoot = path.join(stateDir, "sandbox");
    const agentRoot = path.join(stateDir, "agent");
    await fs.mkdir(sandboxRoot, { recursive: true });
    await fs.mkdir(agentRoot, { recursive: true });
    const pngB64 = TINY_PNG_BASE64;
    await fs.writeFile(path.join(agentRoot, "secret.png"), Buffer.from(pngB64, "base64"));
    const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot });
    const bridge = sandbox.fsBridge;
    if (!bridge) {
      throw new Error("sandbox fs bridge missing");
    }

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "Inspect /agent/secret.png",
        workspaceDir: sandboxRoot,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
        sandbox: { root: sandbox.workspaceDir, bridge },
      });

      expect(result.detectedRefs).toHaveLength(1);
      expect(result.loadedCount).toBe(0);
      expect(result.skippedCount).toBe(1);
      expect(result.images).toHaveLength(0);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("loads managed inbound absolute paths when workspaceOnly is enabled", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-managed-"));
    const workspaceDir = path.join(stateDir, "workspace-agent");
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    const imagePath = path.join(inboundDir, "signal-replay.png");
    const pngB64 = TINY_PNG_BASE64;
    await fs.writeFile(imagePath, Buffer.from(pngB64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await detectAndLoadPromptImages({
        prompt: `Inspect ${imagePath}`,
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });

      expect(result.detectedRefs).toHaveLength(1);
      expect(result.loadedCount).toBe(1);
      expect(result.skippedCount).toBe(0);
      expect(result.images).toHaveLength(1);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps the fact hydration size limit", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-image-size-"));
    const imagePath = path.join(workspaceDir, "too-large.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      const result = await detectAndLoadPromptImages({
        prompt: "describe it",
        media: [{ path: imagePath, contentType: "image/png" }],
        workspaceDir,
        model: { input: ["text", "image"] },
        maxBytes: 1,
      });

      expect(result.loadedCount).toBe(0);
      expect(result.failedMediaCount).toBe(1);
      expect(result.skippedCount).toBe(1);
      expect(result.images).toHaveLength(0);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("drops a header-valid truncated image and keeps a complete one", async () => {
    const workspaceDir = tempDirs.make("openclaw-truncated-image-");
    const png = createNoisyPngBuffer(64, 64);
    const truncatedPath = path.join(workspaceDir, "truncated.png");
    const validPath = path.join(workspaceDir, "valid.png");
    await fs.writeFile(truncatedPath, png.subarray(0, Math.floor(png.length / 2)));
    await fs.writeFile(validPath, png);

    const result = await detectAndLoadPromptImages({
      prompt: `Inspect ${truncatedPath} and ${validPath}`,
      workspaceDir,
      model: { input: ["text", "image"] },
      workspaceOnly: true,
    });

    expect(result.images.map((image) => image.data)).toEqual([png.toString("base64")]);
  });
});

describe("hydratePromptMediaMessages", () => {
  it("hydrates queued facts in attachment order without mutating cache-stable input", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-queued-image-facts-"));
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "queued.gif";
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, mediaId), TINY_GIF_BUFFER);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const message = attachRuntimePromptMediaFacts(
      { role: "user" as const, content: [{ type: "text" as const, text: "compare" }, inlineImage] },
      [{ url: `media://inbound/${mediaId}`, contentType: "image/gif" }],
      ["offloaded", "inline"],
    );
    const options = {
      workspaceDir: stateDir,
      model: { input: ["text", "image"] },
      workspaceOnly: true,
    };

    try {
      const runtimeMessage = message as unknown as AgentMessage;
      const first = await hydratePromptMediaMessages([runtimeMessage], options);
      const second = await hydratePromptMediaMessages([runtimeMessage], options);
      const firstContent = (first?.[0] as unknown as { content?: unknown })?.content;
      const secondContent = (second?.[0] as unknown as { content?: unknown })?.content;

      expect(firstContent).toEqual([
        { type: "text", text: "compare" },
        { type: "image", data: TINY_GIF_BUFFER.toString("base64"), mimeType: "image/gif" },
        inlineImage,
      ]);
      expect(secondContent).toEqual(firstContent);
      expect(message.content).toEqual([{ type: "text", text: "compare" }, inlineImage]);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates a fact-owned user message whose content is a string", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-string-image-facts-"));
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const message = attachRuntimePromptMediaFacts(
      { role: "user" as const, content: "describe it" },
      [{ path: imagePath, contentType: "image/png" }],
    ) as unknown as AgentMessage;

    try {
      const result = await hydratePromptMediaMessages([message], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect((result[0] as unknown as { content?: unknown }).content).toEqual([
        { type: "text", text: "describe it" },
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.each(["runtime", "recorder"] as const)(
    "preserves offloaded-before-inline order across %s serialize and restore",
    async (owner) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-order-"));
      const offloadedPath = path.join(workspaceDir, "offloaded.png");
      const inlinePath = path.join(workspaceDir, "inline.gif");
      await fs.writeFile(offloadedPath, Buffer.from(TINY_PNG_BASE64, "base64"));
      await fs.writeFile(inlinePath, TINY_GIF_BUFFER);
      const inlineImage = {
        type: "image" as const,
        data: TINY_GIF_BUFFER.toString("base64"),
        mimeType: "image/gif",
      };
      const runtime = attachRuntimePromptMediaFacts(
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "compare" }, inlineImage],
        },
        [{ path: offloadedPath, contentType: "image/png" }],
        ["offloaded", "inline"],
      ) as unknown as AgentMessage;
      const persisted = buildPersistedUserTurnMessage({
        text: "compare",
        media: [
          { path: offloadedPath, contentType: "image/png" },
          { path: inlinePath, contentType: "image/gif" },
        ],
        mediaImageLayout: {
          slots: [
            { kind: "offloaded", factIndex: 0 },
            { kind: "inline", factIndex: 1 },
          ],
        },
      });
      const serialized = JSON.stringify(
        owner === "recorder"
          ? persisted
          : mergePreparedUserTurnMessageForRuntime({
              runtimeMessage: runtime,
              preparedMessage: persisted,
            }),
      );
      const restored = JSON.parse(serialized) as AgentMessage;

      try {
        expect(readRuntimePromptImageOrder(restored)).toBeUndefined();
        const result = await hydratePromptMediaMessages([restored], {
          workspaceDir,
          model: { input: ["text", "image"] },
          workspaceOnly: true,
        });
        expect((result[0] as unknown as { content?: unknown }).content).toEqual([
          { type: "text", text: "compare" },
          { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
          inlineImage,
        ]);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps duplicate fact slots across serialize and restore", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-replay-duplicates-"));
    const imagePath = path.join(workspaceDir, "same.png");
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const persisted = buildPersistedUserTurnMessage({
      text: "compare duplicates",
      media: [
        { path: imagePath, contentType: "image/png" },
        { path: imagePath, contentType: "image/png" },
      ],
      mediaImageLayout: {
        slots: [
          { kind: "offloaded", factIndex: 0 },
          { kind: "inline", factIndex: 1 },
        ],
      },
    });
    const serialized = JSON.stringify(
      mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: {
          role: "user",
          content: [{ type: "text", text: "compare duplicates" }, inlineImage],
        } as AgentMessage,
        preparedMessage: persisted,
      }),
    );
    const restored = JSON.parse(serialized) as AgentMessage;

    try {
      const result = await hydratePromptMediaMessages([restored], {
        workspaceDir,
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      const content = (result[0] as unknown as { content?: unknown[] }).content ?? [];
      expect(content.filter((block) => (block as { type?: unknown }).type === "image")).toEqual([
        inlineImage,
        inlineImage,
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
