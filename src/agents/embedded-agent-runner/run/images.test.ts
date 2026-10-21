import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
} from "../../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import type { UserMessage } from "../../../llm/types.js";
import * as mediaLocalRoots from "../../../media/local-roots.js";
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
  normalizeMediaFacts,
  resolveMediaFacts,
  type MediaFact,
} from "../../../media/media-facts.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import {
  buildPersistedUserTurnMessage,
  mergePreparedUserTurnMessageForRuntime,
} from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import * as utils from "../../../utils.js";
import type { AgentMessage } from "../../runtime/index.js";
import { createHostSandboxFsBridge } from "../../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../../test-helpers/unsafe-mounted-sandbox.js";
import { log } from "../logger.js";
import {
  detectAndLoadPromptImages,
  detectImageReferences,
  hydratePromptMediaMessages,
  hasHydratableMediaImages,
  materializeProviderContext,
} from "./images.js";
import type { MediaImageLayout } from "./prompt-image-metadata.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let envSnapshot: ReturnType<typeof captureEnv>;
beforeEach(() => {
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "HOME"]);
});
afterEach(() => {
  envSnapshot.restore();
  vi.restoreAllMocks();
});
const TINY_GIF_BUFFER = Buffer.from([
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59,
]);

const pngImage = (data = TINY_PNG_BASE64) => ({
  type: "image" as const,
  data,
  mimeType: "image/png",
});
const gifImage = () => ({ ...pngImage(TINY_GIF_BUFFER.toString("base64")), mimeType: "image/gif" });
type ImageOptions = Parameters<typeof detectAndLoadPromptImages>[0];
function loadImages(
  options: Omit<ImageOptions, "model" | "prompt" | "workspaceDir"> &
    Partial<Pick<ImageOptions, "model" | "prompt" | "workspaceDir">>,
) {
  return detectAndLoadPromptImages({
    prompt: "",
    workspaceDir: "/tmp",
    model: { input: ["text", "image"] },
    ...options,
  });
}

const sandboxAt = (root: string) => ({ root, bridge: createHostSandboxFsBridge(root) });
const mediaAt = (...paths: string[]) =>
  paths.map((file) => ({ path: file, contentType: "image/png" }));
const png = (r = 0, g = 0, b = 0) => createSolidPngBuffer(1, 1, { r, g, b });
async function writeImage(
  dir: string,
  name = "photo.png",
  data: Uint8Array = Buffer.from(TINY_PNG_BASE64, "base64"),
) {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return target;
}
const persistedMessage = (content: UserMessage["content"], media: MediaFact[]) =>
  ({ role: "user", content, __openclaw: { media } }) as unknown as AgentMessage;
const layout = (slots: MediaImageLayout["slots"], suppressedFactIndexes: number[] = []) => ({
  slots,
  suppressedFactIndexes,
});
const hydrateWithOptions = (
  messages: Parameters<typeof hydratePromptMediaMessages>[0],
  options: Omit<Parameters<typeof hydratePromptMediaMessages>[1], "model">,
) => hydratePromptMediaMessages(messages, { ...options, model: { input: ["text", "image"] } });

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
    expect(result).toMatchObject({ loadedCount: 2, skippedCount: 1 });
    expect(result.images).toHaveLength(2);
    expect(roots).toHaveBeenCalledOnce();
  });
});

async function imageWorkspace(files: Record<string, Uint8Array | undefined>) {
  const dir = tempDirs.make("openclaw-images-");
  for (const [name, data] of Object.entries(files)) {
    await writeImage(dir, name, data);
  }
  return dir;
}

async function pngFile(name = "photo.png") {
  const workspaceDir = await imageWorkspace({ [name]: undefined });
  return { workspaceDir, imagePath: path.join(workspaceDir, name) };
}

function hydrate(messages: AgentMessage[], workspaceDir: string) {
  return hydrateWithOptions(messages, { workspaceDir, workspaceOnly: true });
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

const writePng = (file: string) => writeImage(path.dirname(file), path.basename(file));

const pathRef = (raw: string, resolved = raw) => ({ raw, type: "path", resolved });

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
      model: { input },
      existingImages: [{ type: "image", data, mimeType: "image/png" }],
    });
    expect(result).toMatchObject({ detectedRefs: [], images: [] });
  });

  it("skips generated media-note refs already supplied inline", async () => {
    const { workspaceDir: stateDir, imagePath } = await pngFile();
    const result = await loadImages({
      prompt: "[media attached: ./photo.png (image/png)]\ndescribe it",
      media: mediaAt(imagePath),
      workspaceDir: stateDir,
      existingImages: [pngImage()],
      imageOrder: ["inline"],
      workspaceOnly: true,
    });
    expect(result.detectedRefs).toEqual([pathRef(imagePath)]);
    expect(result.loadedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.images).toEqual([pngImage()]);
  });

  it("uses a described fact identity to suppress its generated media-note path", async () => {
    const { workspaceDir, imagePath } = await pngFile();
    const result = await loadImages({
      prompt: `[media attached: ${imagePath} (image/png)]`,
      media: buildInboundMediaNoteProjection({
        media: mediaAt(imagePath),
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
      media: mediaAt(imagePath),
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
    const bytes = createNoisyPngBuffer(64, 64);
    const truncatedPath = path.join(workspaceDir, "truncated.png");
    const validPath = path.join(workspaceDir, "valid.png");
    await fs.writeFile(truncatedPath, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await fs.writeFile(validPath, bytes);
    const result = await loadImages({
      prompt: `Inspect ${truncatedPath} and ${validPath}`,
      workspaceDir,
      workspaceOnly: true,
    });
    expect(result.images.map((image) => image.data)).toEqual([bytes.toString("base64")]);
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

describe("fact-carried image references", () => {
  it("preserves later conversion errors after finding a hydratable image", () => {
    const events: string[] = [];
    const failure = new Error("later path conversion failed");
    vi.spyOn(utils, "resolveUserPath").mockImplementation((value) => {
      events.push(`convert:${value}`);
      throw failure;
    });
    const media = ["/tmp/first.png", "~/later.png"].map((value) => ({
      get path() {
        events.push(`normalize:${value}`);
        return value;
      },
      contentType: "image/png",
    }));
    expect(() => hasHydratableMediaImages(media)).toThrow(failure);
    expect(events).toEqual([
      "normalize:/tmp/first.png",
      "normalize:~/later.png",
      "convert:~/later.png",
    ]);
  });

  it("counts only facts that will hydrate an image attachment", () => {
    for (const [media, expected] of [
      [[{ path: "/tmp/photo.png", kind: "image" }], true],
      [[{ path: "/tmp/photo.png", contentType: "image" }], true],
      [[{ path: "/tmp/anim.webp", contentType: "sticker" }], true],
      [[{ kind: "image" }], false],
      [[{ url: "https://example.test/remote.png", kind: "image" }], false],
      [[{ path: "https://example.test/remote.png", kind: "image" }], false],
      [[], false],
      [undefined, false],
      ...["audio", "video", "document"].map(
        (contentType) => [[{ path: "/tmp/photo.png", contentType }], false] as const,
      ),
    ] as const) {
      expect(hasHydratableMediaImages(media)).toBe(expected);
    }
  });

  it("applies canonical filename-only PNG rules to actual persisted embedded replay", async () => {
    const { workspaceDir, imagePath } = await pngFile("scan.png");
    const media = [{ path: imagePath }];
    const loaded = await loadImages({ prompt: "", media, workspaceDir, workspaceOnly: true });
    expect(loaded).toMatchObject({ failedMediaCount: 0, images: [{ mimeType: "image/png" }] });
    const replayed = await hydrate([persistedMessage("inspect", media)], workspaceDir);
    expect(replayed[0]?.role).toBe("user");
    const content = replayed[0]?.content;
    const images = Array.isArray(content) ? content.filter((item) => item.type === "image") : [];
    expect(images).toMatchObject([{ mimeType: "image/png" }]);
  });

  it("retains described-image suppression across fact copy boundaries", async () => {
    const normalized = normalizeMediaFacts([
      {
        path: "/tmp/described.png",
        contentType: "image/png",
        hydrationSuppressed: true,
      },
    ]);
    const reprojected = resolveMediaFacts({
      media: normalized,
      MediaPaths: ["/tmp/stale.png"],
      MediaTypes: ["application/octet-stream"],
    });
    expect(reprojected).toEqual([
      expect.objectContaining({
        path: "/tmp/described.png",
        contentType: "image/png",
        kind: "image",
        hydrationSuppressed: true,
      }),
    ]);
    const result = await loadImages({
      media: reprojected,
    });
    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([]);
  });

  it("loads an explicit ref matching a fact sliced into an inline slot", async () => {
    const { workspaceDir, imagePath } = await pngFile();
    const inlineImage = pngImage();
    const result = await loadImages({
      prompt: `compare ${imagePath}`,
      media: mediaAt(imagePath),
      workspaceDir,
      existingImages: [inlineImage],
      imageOrder: ["inline"],
      workspaceOnly: true,
    });
    expect(result).toMatchObject({ loadedCount: 1, failedMediaCount: 0 });
    expect(result.images).toEqual([inlineImage, pngImage()]);
  });

  it("keeps identity-bearing refs when image order metadata has more inline slots", async () => {
    const { workspaceDir, imagePath } = await pngFile("offloaded.png");
    const firstInline = pngImage();
    const secondInline = { ...firstInline };
    const result = await loadImages({
      media: mediaAt(imagePath),
      workspaceDir,
      existingImages: [firstInline, secondInline],
      imageOrder: ["inline", "inline"],
      workspaceOnly: true,
    });
    expect(result).toMatchObject({ loadedCount: 1, failedMediaCount: 0 });
    expect(result.images).toEqual([firstInline, secondInline, pngImage()]);
    expect(result.imageFactIndexes).toEqual([null, null, 0]);
  });

  it("hydrates a missing inline block from its exact source", async () => {
    const { workspaceDir, imagePath } = await pngFile();
    const result = await loadImages({
      media: mediaAt(imagePath),
      workspaceDir,
      imageOrder: ["inline"],
      workspaceOnly: true,
    });
    expect(result).toMatchObject({ loadedCount: 1, skippedCount: 0, failedMediaCount: 0 });
    expect(result.images).toEqual([pngImage()]);
    expect(result.imageFactIndexes).toEqual([0]);
  });

  it("hydrates a fact whose only local identity is a file URL", async () => {
    const { workspaceDir, imagePath } = await pngFile();
    const result = await loadImages({
      prompt: "",
      media: [{ path: pathToFileURL(imagePath).href, contentType: "image/png" }],
      workspaceDir,
      workspaceOnly: true,
    });
    expect(result.images).toEqual([pngImage()]);
  });

  it("hydrates sandbox-staged inbound media URIs", async () => {
    const sandboxRoot = tempDirs.make("openclaw-native-image-sbx-uri-");
    const mediaId = "telegram-photo.png";
    await writeImage(sandboxRoot, `media/inbound/${mediaId}`);
    const result = await loadImages({
      prompt: "",
      media: [{ url: `media://inbound/${mediaId}`, contentType: "image/png" }],
      workspaceDir: sandboxRoot,
      workspaceOnly: true,
      sandbox: sandboxAt(sandboxRoot),
    });
    expect(result.images[0]).toMatchObject(pngImage());
  });

  it("rejects encoded traversal claim-check facts", async () => {
    const result = await loadImages({
      media: [{ url: "media://inbound/%2e%2e%2fsecret.png", contentType: "image/png" }],
    });
    expect(result).toMatchObject({ loadedCount: 0, skippedCount: 1, images: [] });
  });

  it("allows sandbox-validated host paths outside default media roots", async () => {
    const homeDir = os.homedir();
    const sandboxParent = tempDirs.make("openclaw-sandbox-image-", homeDir);
    const sandboxRoot = path.join(sandboxParent, "sandbox");
    await writeImage(sandboxRoot);
    const result = await loadImages({
      prompt: "",
      media: [{ path: "./photo.png", contentType: "image/png" }],
      workspaceDir: sandboxRoot,
      sandbox: sandboxAt(sandboxRoot),
    });
    expect(result.images[0]).toMatchObject(pngImage());
  });

  it("hydrates a path-less transcript image from the staged sandbox twin", async () => {
    const sandboxRoot = tempDirs.make("openclaw-staged-transcript-");
    const stagedPath =
      "media/inbound/openclaw-staged-abc/input-photo---11111111-1111-1111-1111-111111111111.png";
    const mediaUri = "media://inbound/photo---11111111-1111-1111-1111-111111111111.png";
    const hostPath = path.join(sandboxRoot, "outside-store", "photo.png");
    await writeImage(sandboxRoot, stagedPath);
    const result = await loadImages({
      prompt: `inspect\n[media attached: ${mediaUri}]`,
      media: [
        {
          path: stagedPath,
          url: mediaUri,
          contentType: "image/png",
          staged: true,
          hydrationSuppressed: true,
        },
        { path: hostPath, url: mediaUri, contentType: "image/png" },
      ],
      userTurnTranscriptRecorder: {
        resolveMessage: async () =>
          ({
            role: "user",
            content: "inspect",
            __openclaw: {
              media: [{ url: mediaUri, contentType: "image/png", kind: "image" }],
            },
          }) as never,
      },
      imageOrder: ["offloaded"],
      workspaceDir: sandboxRoot,
      workspaceOnly: true,
      sandbox: sandboxAt(sandboxRoot),
    });
    expect(result).toMatchObject({ failedMediaCount: 0, images: [{ data: TINY_PNG_BASE64 }] });
  });
});

describe("structured prompt media replay", () => {
  it("attributes a suppressed-plus-inline sanitization failure to the inline fact", async () => {
    const result = await loadImages({
      media: [
        {
          path: "/tmp/described-missing.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
        { path: "/tmp/inline.png", contentType: "image/png" },
      ],
      existingImages: [pngImage("%%%")],
      imageOrder: ["inline"],
    });
    expect(result).toMatchObject({ loadedCount: 0, failedMediaCount: 1 });
    expect(result.images).toEqual([]);
    expect(result.imageFactIndexes).toEqual([]);
  });
  it("preserves shipped carrier metadata through provider media materialization", async () => {
    const workspaceDir = tempDirs.make("openclaw-legacy-carrier-");
    const imagePath = await writeImage(workspaceDir, "attachment.png", png(0, 0, 255));
    const message: UserMessage = attachRuntimePromptMediaFacts(
      {
        role: "user" as const,
        content: "legacy runtime context",
        timestamp: 1,
        runtimeContextCarrier: true,
        runtimeContextCarrierRetained: false,
      },
      mediaAt(imagePath),
      ["offloaded"],
    );
    const result = await materializeProviderContext({
      context: { messages: [message] },
      workspaceDir,
    });
    expect(result.messages[0]).toMatchObject({
      role: "user",
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: false,
      content: expect.arrayContaining([{ type: "text", text: "legacy runtime context" }]),
    });
  });

  it("preserves persisted facts when replay hydration fails", async () => {
    const workspaceDir = tempDirs.make("openclaw-replay-failure-");
    const missingPath = path.join(workspaceDir, "missing.png");
    const text = "missing attachment";
    const message = persistedMessage(text, mediaAt(missingPath));
    const result = await hydrate([message], workspaceDir);
    expect(result[0]).toMatchObject({
      __openclaw: { media: [expect.objectContaining({ path: missingPath })] },
    });
    expect(result[0]).toHaveProperty("content", [{ type: "text", text }]);
  });

  it("dedupes the rendered alias of a private macOS path", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const result = await loadImages({
      prompt: "[media attached: /var/tmp/aliased.png (image/png)]",
      media: [{ path: "/private/var/tmp/aliased.png", contentType: "image/png" }],
    });
    expect(result.detectedRefs).toEqual([
      {
        raw: "/private/var/tmp/aliased.png",
        resolved: "/private/var/tmp/aliased.png",
        type: "path",
      },
    ]);
    expect(result.skippedCount).toBe(1);
  });

  it("keeps private-var and var paths distinct away from Darwin", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(detectImageReferences("compare /private/var/tmp/a.png and /var/tmp/a.png")).toHaveLength(
      2,
    );
  });

  it("expands a home-relative path carried by a media fact", async () => {
    const homeDir = tempDirs.make("openclaw-fact-home-");
    await writeImage(homeDir, "Pictures/photo.png");
    setTestEnvValue("HOME", homeDir);
    const result = await loadImages({
      media: [{ path: "~/Pictures/photo.png", contentType: "image/png" }],
      localRoots: [homeDir],
    });
    expect(result.images).toHaveLength(1);
  });

  it("keeps same-spelled relative refs from different workspaces distinct", async () => {
    const rootDir = tempDirs.make("openclaw-relative-roots-");
    const stagedDir = path.join(rootDir, "staged");
    const currentDir = path.join(rootDir, "current");
    await writeImage(stagedDir, "photo.png");
    await writeImage(currentDir, "photo.png", png(0, 0, 255));
    const result = await loadImages({
      prompt: "compare ./photo.png",
      media: [{ path: "./photo.png", contentType: "image/png", workspaceDir: stagedDir }],
      workspaceDir: currentDir,
      localRoots: [stagedDir, currentDir],
    });
    expect(result.loadedCount).toBe(2);
    expect(result.images).toHaveLength(2);
  });

  it("prefers persisted fact-index layout when runtime order is also present", async () => {
    const workspaceDir = tempDirs.make("openclaw-layout-authority-");
    const describedPath = await writeImage(workspaceDir, "described.png", png(255));
    const inlinePath = await writeImage(workspaceDir, "inline.png");
    const offloadedBuffer = png(0, 0, 255);
    const offloadedPath = await writeImage(workspaceDir, "offloaded.png", offloadedBuffer);
    const inlineImage = pngImage();
    const media = mediaAt(describedPath, inlinePath, offloadedPath);
    const persisted = buildPersistedUserTurnMessage({
      text: "compare",
      media,
      mediaImageLayout: layout(
        [
          { kind: "inline", factIndex: 1 },
          { kind: "offloaded", factIndex: 2 },
        ],
        [0],
      ),
    });
    const message = attachRuntimePromptMediaFacts(
      {
        ...persisted,
        content: [{ type: "text" as const, text: "compare" }, inlineImage],
      } as AgentMessage,
      media,
      ["inline", "offloaded"],
    );

    const first = await hydrate([message], workspaceDir);
    const firstContent = (first[0] as unknown as { content?: unknown[] }).content;
    expect(firstContent).toEqual([
      { type: "text", text: "compare" },
      inlineImage,
      pngImage(offloadedBuffer.toString("base64")),
    ]);

    const serialized = JSON.stringify(first[0]);
    for (const { path: file } of media) {
      await fs.rm(file);
    }
    const replay = await hydrate([JSON.parse(serialized) as AgentMessage], workspaceDir);
    expect((replay[0] as unknown as { content?: unknown[] }).content).toEqual(firstContent);
  });

  it("retries an offloaded fact even when an unrelated explicit image exists", async () => {
    const workspaceDir = tempDirs.make("openclaw-offload-retry-");
    const explicitImage = pngImage();
    const result = await loadImages({
      media: [{ path: path.join(workspaceDir, "missing.png"), contentType: "image/png" }],
      mediaImageLayout: layout([{ kind: "offloaded", factIndex: 0 }]),
      workspaceDir,
      existingImages: [explicitImage],
      existingImageFactIndexes: [null],
      workspaceOnly: true,
    });
    expect(result.failedMediaCount).toBe(1);
    expect(result.images).toEqual([explicitImage]);
    expect(result.imageFactIndexes).toEqual([null]);
  });

  it("preserves fact order for partial hydration without persisted layout", async () => {
    const workspaceDir = tempDirs.make("openclaw-partial-order-");
    const firstPath = path.join(workspaceDir, "first.png");
    const secondPath = path.join(workspaceDir, "second.png");
    const secondBuffer = png(0, 255);
    const thirdBuffer = png(0, 0, 255);
    const thirdPath = await writeImage(workspaceDir, "third.png", thirdBuffer);
    const firstImage = pngImage();
    const secondImage = pngImage(secondBuffer.toString("base64"));
    const result = await loadImages({
      media: mediaAt(firstPath, secondPath, thirdPath),
      workspaceDir,
      existingImages: [firstImage, secondImage],
      existingImageFactIndexes: [0, 1],
      imageOrder: ["offloaded", "inline", "offloaded"],
      workspaceOnly: true,
    });
    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([
      firstImage,
      secondImage,
      pngImage(thirdBuffer.toString("base64")),
    ]);
    expect(result.imageFactIndexes).toEqual([0, 1, 2]);
    expect(readRuntimePromptImageFactIndexes(result.images)).toEqual([0, 1, 2]);
  });

  it("uses an unowned block for an inline slot when exact provenance is unavailable", async () => {
    const inlineImage = pngImage();
    const offloadedImage = pngImage(png(0, 255).toString("base64"));
    const result = await loadImages({
      media: [{ kind: "document" }, { kind: "image" }, { kind: "image" }],
      mediaImageLayout: layout([
        { kind: "inline", factIndex: 1 },
        { kind: "offloaded", factIndex: 2 },
      ]),
      existingImages: [inlineImage, offloadedImage],
      existingImageFactIndexes: [null, 2],
    });
    expect(result.failedMediaCount).toBe(0);
    expect(result.images).toEqual([inlineImage, offloadedImage]);
    expect(result.imageFactIndexes).toEqual([null, 2]);
  });

  it("reports a missing unsuppressed inline layout slot", async () => {
    const result = await loadImages({
      media: [{ kind: "image" }],
      mediaImageLayout: layout([{ kind: "inline", factIndex: 0 }]),
    });
    expect(result).toMatchObject({ failedMediaCount: 1, images: [] });
  });

  it("does not pair an unresolved remote persisted fact with an existing inline block", async () => {
    const inlineImage = pngImage();
    const text = "remote identity";
    const message = persistedMessage(
      [{ type: "text", text }, inlineImage],
      [{ kind: "image", url: "https://example.test/remote.png" }],
    );
    const result = await hydrateWithOptions([message], { workspaceDir: "/tmp" });
    expect(result[0]).toMatchObject({
      __openclaw: { mediaImageBlockFactIndexes: [null] },
    });
    expect(result[0]).toHaveProperty("content", [{ type: "text", text }, inlineImage]);
  });

  it("keeps identity-bearing persisted facts ahead of an unowned inline block", async () => {
    const workspaceDir = tempDirs.make("openclaw-legacy-order-");
    const existingPath = await writeImage(workspaceDir, "existing.png");
    const hydratedBuffer = png(0, 255);
    const hydratedPath = await writeImage(workspaceDir, "hydrated.png", hydratedBuffer);
    const existingImage = pngImage();
    const message = persistedMessage(
      [{ type: "text", text: "legacy order" }, existingImage],
      mediaAt(existingPath, hydratedPath),
    );
    const result = await hydrate([message], workspaceDir);
    expect((result[0] as unknown as { content?: unknown[] }).content).toEqual([
      { type: "text", text: "legacy order" },
      pngImage(),
      pngImage(hydratedBuffer.toString("base64")),
      existingImage,
    ]);
  });
});
