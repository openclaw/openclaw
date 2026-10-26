import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoisyPngBuffer } from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import * as mediaLocalRoots from "../../../media/local-roots.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../../media/media-facts.js";
import {
  buildPersistedUserTurnMessage,
  mergePreparedUserTurnMessageForRuntime,
} from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createUnsafeMountedSandbox } from "../../test-helpers/unsafe-mounted-sandbox.js";
import { log } from "../logger.js";
import { describedImageUnderstanding } from "./image-description.test-support.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  hydratePromptMediaMessages,
} from "./images.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let envSnapshot: ReturnType<typeof captureEnv>;
beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
});
afterEach(() => {
  envSnapshot.restore();
  vi.restoreAllMocks();
});
const TINY_GIF_BUFFER = Buffer.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

function pngImage() {
  return { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
}
function gifImage() {
  return {
    type: "image" as const,
    data: TINY_GIF_BUFFER.toString("base64"),
    mimeType: "image/gif",
  };
}
type ImageOptions = Parameters<typeof detectAndLoadPromptImages>[0];
function loadImages(options: Omit<ImageOptions, "model"> & Partial<Pick<ImageOptions, "model">>) {
  return detectAndLoadPromptImages({ model: { input: ["text", "image"] }, ...options });
}

describe("prompt image preparation", () => {
  it.each([false, true])("skips filesystem roots for inline=%s input", async (inline) => {
    const roots = vi.spyOn(mediaLocalRoots, "getAgentScopedMediaLocalRoots");
    const images = inline ? [pngImage()] : [];
    const result = await prepareEmbeddedAttemptPromptExecution({
      attempt: { workspaceDir: "/workspace", model: { input: ["text", "image"] }, images },
      mediaOwnerAgentId: "main",
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/workspace",
      prompt: "Describe this turn",
      skipPromptSubmission: false,
    });
    expect(result.images).toEqual(images);
    expect(roots).not.toHaveBeenCalled();
  });

  it("resolves roots once for several files and still rejects a file outside them", async () => {
    const workspaceDir = tempDirs.make("openclaw-prompt-images-");
    const deniedDir = tempDirs.make("openclaw-prompt-denied-");
    const paths = [
      path.join(workspaceDir, "one.png"),
      path.join(workspaceDir, "two.png"),
      path.join(deniedDir, "denied.png"),
    ];
    await Promise.all(paths.map((file) => writePng(file)));
    const roots = vi.spyOn(mediaLocalRoots, "getAgentScopedMediaLocalRoots");
    const result = await prepareEmbeddedAttemptPromptExecution({
      attempt: {
        workspaceDir,
        model: { input: ["text", "image"] },
        config: { agents: { entries: { main: { workspace: workspaceDir } } } },
      },
      mediaOwnerAgentId: "main",
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: workspaceDir,
      prompt: paths.join(" "),
      skipPromptSubmission: false,
    });
    expect(result.loadedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.images).toHaveLength(2);
    expect(roots).toHaveBeenCalledOnce();
  });
});

async function imageWorkspace(files: Record<string, Uint8Array | undefined>) {
  const dir = tempDirs.make("openclaw-images-");
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data ?? Buffer.from(TINY_PNG_BASE64, "base64"));
  }
  return dir;
}

async function pngFile(name = "photo.png") {
  const workspaceDir = await imageWorkspace({ [name]: undefined });
  return { workspaceDir, imagePath: path.join(workspaceDir, name) };
}

function hydrate(messages: AgentMessage[], workspaceDir: string) {
  return hydratePromptMediaMessages(messages, {
    workspaceDir,
    model: { input: ["text", "image"] },
    workspaceOnly: true,
  });
}
function persistedMedia(text: string, paths: string[]) {
  return buildPersistedUserTurnMessage({
    text,
    media: paths.map((file, index) => ({
      path: file,
      contentType: index === 0 || paths[0] === file ? "image/png" : "image/gif",
    })),
    mediaImageLayout: {
      slots: [
        { kind: "offloaded", factIndex: 0 },
        { kind: "inline", factIndex: 1 },
      ],
    },
  });
}
function restoredMedia(
  runtimeMessage: AgentMessage,
  preparedMessage: ReturnType<typeof persistedMedia>,
) {
  const serialized = JSON.stringify(
    mergePreparedUserTurnMessageForRuntime({ runtimeMessage, preparedMessage }),
  );
  return JSON.parse(serialized) as AgentMessage;
}

function writePng(file: string) {
  return fs.writeFile(file, Buffer.from(TINY_PNG_BASE64, "base64"));
}

function pathRef(raw: string, resolved = raw) {
  return { raw, type: "path", resolved };
}

describe("detectImageReferences", () => {
  const stale = path.join(resolvePreferredOpenClawTmpDir(), "openclaw-cli-images", "stale.jpg");
  it.each([
    [
      "~/Pictures/vacation.png",
      path.join(process.env.HOME ?? os.homedir(), "Pictures/vacation.png"),
      false,
    ],
    ["/workspace/openclaw-cli-images/current.png", undefined, false],
    ["/path/image.png", undefined, true],
    [String.raw`C:\Users\Ada\Pictures\screenshot.png`, undefined, false],
  ] as const)("parses local reference %s", (raw, resolved, duplicate) => {
    expect(
      detectImageReferences(`See ${raw}${duplicate ? ` and ${raw} again` : ""}`),
    ).toStrictEqual([pathRef(raw, resolved ?? raw)]);
  });
  it.each([
    [
      "transcript cache paths",
      [
        '<system-reminder>Called the Read tool with {"file_path":"/Users/ada/.openclaw/workspace/.openclaw-cli-images/stale.png"}</system-reminder>\nCompare it with /Users/ada/Pictures/current.png',
      ],
      [pathRef("/Users/ada/Pictures/current.png")],
    ],
    [
      "temporary cache paths",
      [
        `Prior turn wrote ${stale}`,
        `[media attached: ${stale} (image/jpeg)]`,
        `Prior turn wrote ${path.join(os.tmpdir(), "openclaw", "openclaw-cli-images", "stale.jpg")}`,
        `Prior turn wrote ${path.join(os.tmpdir(), "openclaw-501", "openclaw-cli-images", "stale.jpg")}`,
      ],
      [],
    ],
    [
      "cache file URLs",
      [
        `Prior turn wrote ${pathToFileURL(path.join(os.tmpdir(), "openclaw", "openclaw-cli-images", "stale.png")).href}`,
      ],
      [],
    ],
    [
      "remote URLs",
      [
        "To send an image: MEDIA:https://example.com/image.jpg\nHere is my actual image: /path/to/real.png\nAlso https://cdn.mysite.com/img.jpg",
      ],
      [pathRef("/path/to/real.png")],
    ],
    ["remote-host file URLs", ["See file://attacker/share/evil.png"], []],
  ] satisfies Array<[string, string[], ReturnType<typeof pathRef>[]]>)(
    "filters %s",
    (_name, prompts, expected) => {
      for (const prompt of prompts) {
        expect(detectImageReferences(prompt)).toStrictEqual(expected);
      }
    },
  );

  it("does not leak parser state between calls", () => {
    expect(detectImageReferences("See /tmp/first.png")).toStrictEqual([pathRef("/tmp/first.png")]);
    expect(detectImageReferences("See /tmp/second.jpg")).toStrictEqual([
      pathRef("/tmp/second.jpg"),
    ]);
    const thirdPath = path.join(os.tmpdir(), "third.webp");
    const thirdUrl = pathToFileURL(thirdPath).href;
    expect(detectImageReferences(`See ${thirdUrl}`)).toStrictEqual([pathRef(thirdUrl, thirdPath)]);
    expect(detectImageReferences("See ./fourth.jpeg")).toStrictEqual([pathRef("./fourth.jpeg")]);
  });

  it("dedupe casing follows host filesystem conventions", () => {
    const prompt = "Look at /tmp/Image.png and /tmp/image.png";
    if (process.platform === "win32") {
      expect(detectImageReferences(prompt)).toStrictEqual([pathRef("/tmp/Image.png")]);
      return;
    }
    expect(detectImageReferences(prompt)).toStrictEqual([
      pathRef("/tmp/Image.png"),
      pathRef("/tmp/image.png"),
    ]);
  });
});

describe("detectAndLoadPromptImages", () => {
  it.each([
    ["non-vision input", ["text"], "abc"],
    ["invalid inline image", ["text", "image"], "not-valid-base64"],
  ] satisfies Array<[string, string[], string]>)("rejects %s", async (_name, input, data) => {
    const result = await loadImages({
      prompt: "describe the attached image",
      workspaceDir: "/tmp",
      model: { input },
      existingImages: [{ type: "image", data, mimeType: "image/png" }],
    });
    expect(result).toMatchObject({ detectedRefs: [], images: [] });
  });

  it("skips generated media-note refs already supplied inline", async () => {
    const { workspaceDir: stateDir, imagePath } = await pngFile();

    const result = await loadImages({
      prompt: "[media attached: ./photo.png (image/png)]\ndescribe it",
      media: [{ path: imagePath, contentType: "image/png" }],
      workspaceDir: stateDir,
      existingImages: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }],
      imageOrder: ["inline"],
      workspaceOnly: true,
    });

    expect(result.detectedRefs).toEqual([pathRef(imagePath)]);
    expect(result.loadedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.images).toEqual([
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
    ]);
  });

  it("uses a described fact identity to suppress its generated media-note path", async () => {
    const { workspaceDir, imagePath } = await pngFile();

    const result = await loadImages({
      prompt: `[media attached: ${imagePath} (image/png)]`,
      media: buildInboundMediaNoteProjection({
        media: [{ path: imagePath, contentType: "image/png" }],
        MediaUnderstanding: describedImageUnderstanding(),
      }).media,
      workspaceDir,
    });

    expect(result.detectedRefs).toEqual([pathRef(imagePath)]);
    expect(result.loadedCount).toBe(0);
    expect(result.images).toEqual([]);
  });

  it("dedupes a relative fact projection against the fact workspace", async () => {
    const rootDir = await imageWorkspace({
      "staged/photo.png": undefined,
      "current/photo.png": TINY_GIF_BUFFER,
    });
    const stagedDir = path.join(rootDir, "staged");
    const currentDir = path.join(rootDir, "current");

    const result = await loadImages({
      prompt: "[media attached: ./photo.png (image/png)]",
      media: [{ path: "./photo.png", contentType: "image/png", workspaceDir: stagedDir }],
      workspaceDir: currentDir,
      localRoots: [stagedDir, currentDir],
    });

    expect(result.loadedCount).toBe(1);
    expect(result.images).toEqual([pngImage()]);
  });

  it("keeps inline fact indexes aligned when an earlier attachment is suppressed", async () => {
    const kept = gifImage();
    const result = await loadImages({
      prompt: "describe the remaining image",
      workspaceDir: "/tmp",
      existingImages: [pngImage(), kept],
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
    const stateDir = await imageWorkspace({
      "media/inbound/att-b.gif": TINY_GIF_BUFFER,
      "media/inbound/prompt-ref.png": undefined,
      "prompt-b.png": undefined,
    });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const prompt =
      "compare [media attached: media://inbound/prompt-ref.png] and ./prompt-b.png\n[media attached: media://inbound/att-b.gif]";

    const result = await loadImages({
      prompt,
      media: [{ url: "media://inbound/att-b.gif", contentType: "image/gif" }],
      workspaceDir: stateDir,
      existingImages: [pngImage()],
      imageOrder: ["offloaded", "inline"],
      workspaceOnly: true,
    });

    expect(result.detectedRefs).toEqual([
      {
        raw: "media://inbound/att-b.gif",
        type: "media-uri",
        resolved: "media://inbound/att-b.gif",
      },
      pathRef("./prompt-b.png"),
    ]);
    expect(result.loadedCount).toBe(2);
    expect(result.images).toEqual([gifImage(), pngImage(), pngImage()]);
  });

  it("preserves an empty described-image slot in mixed attachment order", async () => {
    const mediaId = "remaining.gif";
    const stateDir = await imageWorkspace({
      [`media/inbound/${mediaId}`]: TINY_GIF_BUFFER,
    });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const inlineImage = pngImage();

    const result = await loadImages({
      prompt: "compare",
      media: [
        { kind: "image" },
        { kind: "image" },
        { url: `media://inbound/${mediaId}`, contentType: "image/gif" },
      ],
      workspaceDir: stateDir,
      existingImages: [inlineImage],
      imageOrder: ["offloaded", "inline", "offloaded"],
    });

    expect(result.images).toEqual([inlineImage, gifImage()]);
  });

  it("does not load an explicit prompt ref twice when the same fact owns it", async () => {
    const { workspaceDir } = await pngFile("same.png");

    const result = await loadImages({
      prompt: "Compare ./same.png",
      media: [{ path: "./same.png", contentType: "image/png", workspaceDir }],
      workspaceDir,
      workspaceOnly: true,
    });

    expect(result.detectedRefs).toEqual([pathRef("./same.png")]);
    expect(result.loadedCount).toBe(1);
    expect(result.images).toHaveLength(1);
  });

  it("blocks prompt image refs outside workspace when sandbox workspaceOnly is enabled", async () => {
    const stateDir = tempDirs.make("openclaw-native-image-sandbox-");
    const sandboxRoot = path.join(stateDir, "sandbox");
    const agentRoot = path.join(stateDir, "agent");
    await fs.mkdir(sandboxRoot, { recursive: true });
    await fs.mkdir(agentRoot, { recursive: true });
    const imageRef = "/agent/synthetic-private-image.png";
    await fs.writeFile(
      path.join(agentRoot, "synthetic-private-image.png"),
      Buffer.from(TINY_PNG_BASE64, "base64"),
    );
    const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot });
    const bridge = sandbox.fsBridge;
    if (!bridge) {
      throw new Error("sandbox fs bridge missing");
    }

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const result = await loadImages({
      prompt: `Inspect ${imageRef}`,
      workspaceDir: sandboxRoot,
      workspaceOnly: true,
      sandbox: { root: sandbox.workspaceDir, bridge },
    });

    expect(result.detectedRefs).toHaveLength(1);
    expect(result).toMatchObject({ loadedCount: 0, skippedCount: 1, images: [] });
    expect(warn.mock.calls).toEqual([["Native image: sandbox validation failed"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-image");
  });

  it("loads managed inbound absolute paths when workspaceOnly is enabled", async () => {
    const stateDir = tempDirs.make("openclaw-native-image-managed-");
    const workspaceDir = path.join(stateDir, "workspace-agent");
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    const imagePath = path.join(inboundDir, "signal-replay.png");
    await writePng(imagePath);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    const result = await loadImages({
      prompt: `Inspect ${imagePath}`,
      workspaceDir,
      workspaceOnly: true,
    });

    expect(result.detectedRefs).toHaveLength(1);
    expect(result.loadedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.images).toHaveLength(1);
  });

  it("keeps the fact hydration size limit", async () => {
    const { workspaceDir, imagePath } = await pngFile("synthetic-private-attachment.png");

    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const result = await loadImages({
      prompt: "describe it",
      media: [{ path: imagePath, contentType: "image/png" }],
      workspaceDir,
      maxBytes: 1,
    });

    expect(result).toMatchObject({
      loadedCount: 0,
      failedMediaCount: 1,
      skippedCount: 1,
      images: [],
    });
    expect(warn.mock.calls).toEqual([["Native image: failed to load"]]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-attachment");
  });

  it("drops a header-valid truncated image and keeps a complete one", async () => {
    const workspaceDir = tempDirs.make("openclaw-truncated-image-");
    const png = createNoisyPngBuffer(64, 64);
    const truncatedPath = path.join(workspaceDir, "truncated.png");
    const validPath = path.join(workspaceDir, "valid.png");
    await fs.writeFile(truncatedPath, png.subarray(0, Math.floor(png.length / 2)));
    await fs.writeFile(validPath, png);

    const result = await loadImages({
      prompt: `Inspect ${truncatedPath} and ${validPath}`,
      workspaceDir,
      workspaceOnly: true,
    });

    expect(result.images.map((image) => image.data)).toEqual([png.toString("base64")]);
  });
});

describe("hydratePromptMediaMessages", () => {
  it("hydrates queued facts in attachment order without mutating cache-stable input", async () => {
    const mediaId = "queued.gif";
    const stateDir = await imageWorkspace({
      [`media/inbound/${mediaId}`]: TINY_GIF_BUFFER,
    });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const inlineImage = pngImage();
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

    const runtimeMessage = message as unknown as AgentMessage;
    const first = await hydratePromptMediaMessages([runtimeMessage], options);
    const second = await hydratePromptMediaMessages([runtimeMessage], options);
    const firstContent = (first?.[0] as unknown as { content?: unknown })?.content;
    const secondContent = (second?.[0] as unknown as { content?: unknown })?.content;

    expect(firstContent).toEqual([{ type: "text", text: "compare" }, gifImage(), inlineImage]);
    expect(secondContent).toEqual(firstContent);
    expect(message.content).toEqual([{ type: "text", text: "compare" }, inlineImage]);
  });

  it("hydrates a fact-owned user message whose content is a string", async () => {
    const { workspaceDir, imagePath } = await pngFile("photo.png");
    const message = attachRuntimePromptMediaFacts(
      { role: "user" as const, content: "describe it" },
      [{ path: imagePath, contentType: "image/png" }],
    ) as unknown as AgentMessage;

    const result = await hydrate([message], workspaceDir);
    expect((result[0] as unknown as { content?: unknown }).content).toEqual([
      { type: "text", text: "describe it" },
      pngImage(),
    ]);
  });

  it.each(["runtime", "recorder"] as const)(
    "preserves offloaded-before-inline order across %s serialize and restore",
    async (owner) => {
      const workspaceDir = tempDirs.make("openclaw-replay-order-");
      const offloadedPath = path.join(workspaceDir, "offloaded.png");
      const inlinePath = path.join(workspaceDir, "inline.gif");
      await writePng(offloadedPath);
      await fs.writeFile(inlinePath, TINY_GIF_BUFFER);
      const inlineImage = gifImage();
      const runtime = attachRuntimePromptMediaFacts(
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "compare" }, inlineImage],
        },
        [{ path: offloadedPath, contentType: "image/png" }],
        ["offloaded", "inline"],
      ) as unknown as AgentMessage;
      const persisted = persistedMedia("compare", [offloadedPath, inlinePath]);
      const serialized = JSON.stringify(persisted);
      const restored =
        owner === "recorder"
          ? (JSON.parse(serialized) as AgentMessage)
          : restoredMedia(runtime, persisted);

      expect(readRuntimePromptMediaFacts(restored)).toBeUndefined();
      const result = await hydrate([restored], workspaceDir);
      expect((result[0] as unknown as { content?: unknown }).content).toEqual([
        { type: "text", text: "compare" },
        pngImage(),
        inlineImage,
      ]);
    },
  );

  it("keeps duplicate fact slots across serialize and restore", async () => {
    const { workspaceDir, imagePath } = await pngFile("same.png");
    const inlineImage = pngImage();
    const persisted = persistedMedia("compare duplicates", [imagePath, imagePath]);
    const restored = restoredMedia(
      {
        role: "user",
        content: [{ type: "text", text: "compare duplicates" }, inlineImage],
      } as AgentMessage,
      persisted,
    );

    const result = await hydrate([restored], workspaceDir);
    const content = (result[0] as unknown as { content?: unknown[] }).content ?? [];
    expect(content.filter((block) => (block as { type?: unknown }).type === "image")).toEqual([
      inlineImage,
      inlineImage,
    ]);
  });
});
