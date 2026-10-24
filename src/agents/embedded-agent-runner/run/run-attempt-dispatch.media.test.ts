import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { describedImageUnderstanding } from "./image-description.test-support.js";
import { suppressedInlineImageFacts } from "./image-media-facts.test-support.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

type Attempt = Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]["attempt"];
async function preparePluginHarnessPromptImages(
  attempt: Omit<Attempt, "model" | "workspaceDir">,
  workspaceDir = "/tmp",
  input: NonNullable<Attempt["model"]["input"]> = ["text", "image"],
) {
  const result = await prepareEmbeddedAttemptPromptExecution({
    attempt: {
      workspaceDir,
      config: { agents: { defaults: { sandbox: { mode: "off" } } } },
      ...attempt,
      model: { input },
    },
    mediaOwnerAgentId: "main",
    effectiveWorkspace: workspaceDir,
    effectiveFsWorkspaceOnly: false,
    prompt: "",
    skipPromptSubmission: false,
    pluginHarness: true,
  });
  return { images: result.images, imageOrder: result.imageOrder, media: result.media };
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==";
describe("plugin harness prompt media", () => {
  let stateDir: string;
  let workspaceDir: string;
  let imagePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;
  beforeEach(async () => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-media-"));
    workspaceDir = path.join(stateDir, "workspace");
    imagePath = path.join(stateDir, "media", "inbound", "photo.png");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(async () => {
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });
  it("hydrates an authentic PNG with generic-binary metadata", async () => {
    const media = [{ path: imagePath, contentType: "application/octet-stream" }];
    const result = await preparePluginHarnessPromptImages(
      {
        media,
        userTurnTranscriptRecorder: {
          message: { role: "user", content: "inspect", __openclaw: { media } },
          async resolveMessage() {
            return this.message;
          },
        },
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0],
      workspaceDir,
    );

    expect(result.images ?? []).toHaveLength(1);
    expect(result.images?.[0]?.mimeType).toBe("image/png");
    expect(result.media).toBeUndefined();
  });

  it("hydrates plugin images and preserves serialized replay order with non-image facts", async () => {
    const mediaId = "photo.png";
    const documentFact = {
      path: path.join(workspaceDir, "misleading.png"),
      contentType: "application/pdf",
      kind: "document" as const,
    };
    const input = {
      imageOrder: ["offloaded"],
      media: [documentFact, { url: `media://inbound/${mediaId}`, contentType: "image/png" }],
      userTurnTranscriptRecorder: {
        message: {
          role: "user",
          content: "stale initial facts",
          __openclaw: { media: [documentFact] },
        },
        async resolveMessage() {
          return {
            role: "user",
            content: "inspect",
            __openclaw: {
              media: [{ path: imagePath, contentType: "image/png" }, documentFact],
              mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
            },
          };
        },
      },
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0];
    const result = await preparePluginHarnessPromptImages(input, workspaceDir);

    expect(result.images).toEqual([
      { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
    ]);
    expect(readRuntimePromptImageFactIndexes(result.images ?? [])).toEqual([0]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.media).toMatchObject([documentFact]);
    expect(JSON.stringify(result)).not.toContain(imagePath);
    expect(structuredClone(result).images).toEqual(result.images);
  });

  it("hydrates named-agent workspace images on the embedded prompt path", async () => {
    const ownedWorkspace = path.join(stateDir, "workspace-arthur");
    const siblingWorkspaceDir = path.join(stateDir, "workspace-merlin");
    const ownedImage = path.join(ownedWorkspace, "media", "inbound", "photo.png");
    const siblingImagePath = path.join(siblingWorkspaceDir, "media", "inbound", "photo.png");
    const image = Buffer.from(TINY_PNG_BASE64, "base64");
    await fs.mkdir(path.dirname(ownedImage), { recursive: true });
    await fs.mkdir(path.dirname(siblingImagePath), { recursive: true });
    await fs.writeFile(ownedImage, image);
    await fs.writeFile(siblingImagePath, image);
    const hydrate = (mediaPath: string, sessionId: string) =>
      prepareEmbeddedAttemptPromptExecution({
        attempt: {
          config: {
            agents: {
              entries: {
                arthur: { workspace: ownedWorkspace },
                merlin: { workspace: siblingWorkspaceDir },
              },
            },
          },
          media: [{ path: mediaPath, contentType: "image/png" }],
          model: { input: ["text", "image"] },
          sessionId,
        },
        mediaOwnerAgentId: "arthur",
        effectiveWorkspace: ownedWorkspace,
        effectiveFsWorkspaceOnly: false,
        prompt: "",
        skipPromptSubmission: false,
      } as unknown as Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]);

    const owned = await hydrate(ownedImage, "session-embedded-media");

    expect(owned.images).toEqual([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }]);
    expect(owned.failedMediaCount).toBe(0);

    // The embedded path returns before the plugin-harness throw, so a refused
    // sibling read shows up as a failure count rather than a rejection.
    const sibling = await hydrate(siblingImagePath, "session-embedded-sibling-media");

    expect(sibling.images).toEqual([]);
    expect(sibling.failedMediaCount).toBe(1);
  });

  it("surfaces an unsuppressed identity-less inline fact with no image block", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        imageOrder: ["inline"],
        media: [{ kind: "image" }],
      }),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces inline sanitization failure when a preceding plugin image fact is suppressed", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
        imageOrder: ["inline"],
        media: suppressedInlineImageFacts(),
      }),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("retains an intentionally non-hydrating remote-only image as a type-only fact", async () => {
    const media = buildInboundMediaNoteProjection({
      media: [{ url: "https://example.com/described.png", contentType: "image/png" }],
      MediaUnderstanding: describedImageUnderstanding(),
    }).media;
    const result = await preparePluginHarnessPromptImages({ media });

    expect(result.images).toEqual([]);
    expect(result.media).toBeUndefined();
  });

  it("retains layout-derived suppression after plugin host materialization", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const media = [
      { path: "/tmp/described.png", contentType: "image/png" },
      { path: "/tmp/inline.png", contentType: "image/png" },
    ];
    const result = await preparePluginHarnessPromptImages({
      images: [inlineImage],
      imageOrder: ["inline"],
      media,
      userTurnTranscriptRecorder: {
        async resolveMessage() {
          return this.message;
        },
        message: {
          role: "user",
          content: "compare",
          __openclaw: {
            media,
            mediaImageLayout: {
              slots: [{ kind: "inline", factIndex: 1 }],
              suppressedFactIndexes: [0],
            },
          },
        },
      },
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([inlineImage]);
    expect(result.imageOrder).toEqual(["inline"]);
    expect(result.media).toBeUndefined();
  });

  it("keeps unsupported native images as aligned type-only facts", async () => {
    const media = [
      { path: "/tmp/photo.png", contentType: "image/png" },
      { path: "/tmp/inferred.png", kind: "unknown" as const },
    ];
    const result = await preparePluginHarnessPromptImages({ media }, "/tmp", ["text"]);

    expect(result.images).toEqual([]);
    expect(result.media).toBeUndefined();
  });
});
