import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInboundMediaNoteProjection } from "../../../auto-reply/media-note.js";
import { readRuntimePromptImageFactIndexes } from "../../../media/runtime-prompt-image-provenance.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

async function preparePluginHarnessPromptImages(params: {
  runParams: Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]["attempt"];
  runtime: {
    agentId?: string;
    workspaceDir: string;
    model: Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]["attempt"]["model"];
  };
}) {
  const result = await prepareEmbeddedAttemptPromptExecution({
    attempt: { ...params.runParams, model: params.runtime.model },
    mediaOwnerAgentId: params.runtime.agentId ?? "main",
    effectiveWorkspace: params.runtime.workspaceDir,
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
  it("hydrates an authentic PNG with generic-binary metadata", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-canonical-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const imagePath = path.join(inboundDir, "scan.png");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const media = [{ path: imagePath, contentType: "application/octet-stream" }];
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const result = await preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          media,
          sessionId: "session-canonical-media",
          userTurnTranscriptRecorder: {
            message: { role: "user", content: "inspect", __openclaw: { media } },
            async resolveMessage() {
              return this.message;
            },
          },
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-canonical-media",
          workspaceDir,
        },
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

      expect(result.images ?? []).toHaveLength(1);
      expect(result.images?.[0]?.mimeType).toBe("image/png");
      expect(result.media).toBeUndefined();
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates plugin images and preserves serialized replay order with non-image facts", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-harness-media-"));
    const workspaceDir = path.join(stateDir, "workspace");
    const inboundDir = path.join(stateDir, "media", "inbound");
    const mediaId = "photo.png";
    const imagePath = path.join(inboundDir, mediaId);
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const documentFact = {
      path: path.join(workspaceDir, "misleading.png"),
      contentType: "application/pdf",
      kind: "document" as const,
    };
    const input = {
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        imageOrder: ["offloaded"],
        media: [documentFact, { url: `media://inbound/${mediaId}`, contentType: "image/png" }],
        sessionId: "session-1",
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
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-1",
        workspaceDir,
      },
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0];

    try {
      const result = await preparePluginHarnessPromptImages(input);

      expect(result.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(readRuntimePromptImageFactIndexes(result.images ?? [])).toEqual([0]);
      expect(result.imageOrder).toEqual(["inline"]);
      expect(result.media).toMatchObject([documentFact]);
      expect(JSON.stringify(result)).not.toContain(imagePath);
      expect(structuredClone(result).images).toEqual(result.images);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("hydrates named-agent workspace images on the embedded prompt path", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-embedded-agent-media-"));
    const workspaceDir = path.join(stateDir, "workspace-arthur");
    const siblingWorkspaceDir = path.join(stateDir, "workspace-merlin");
    const imagePath = path.join(workspaceDir, "media", "inbound", "photo.png");
    const siblingImagePath = path.join(siblingWorkspaceDir, "media", "inbound", "photo.png");
    const image = Buffer.from(TINY_PNG_BASE64, "base64");
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.mkdir(path.dirname(siblingImagePath), { recursive: true });
    await fs.writeFile(imagePath, image);
    await fs.writeFile(siblingImagePath, image);
    const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

    try {
      const hydrate = (mediaPath: string, sessionId: string) =>
        prepareEmbeddedAttemptPromptExecution({
          attempt: {
            config: {
              agents: {
                entries: {
                  arthur: { workspace: workspaceDir },
                  merlin: { workspace: siblingWorkspaceDir },
                },
              },
            },
            media: [{ path: mediaPath, contentType: "image/png" }],
            model: { input: ["text", "image"] },
            sessionId,
          },
          mediaOwnerAgentId: "arthur",
          effectiveWorkspace: workspaceDir,
          effectiveFsWorkspaceOnly: false,
          prompt: "",
          skipPromptSubmission: false,
        } as unknown as Parameters<typeof prepareEmbeddedAttemptPromptExecution>[0]);

      const owned = await hydrate(imagePath, "session-embedded-media");

      expect(owned.images).toEqual([
        { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" },
      ]);
      expect(owned.failedMediaCount).toBe(0);

      // The embedded path returns before the plugin-harness throw, so a refused
      // sibling read shows up as a failure count rather than a rejection.
      const sibling = await hydrate(siblingImagePath, "session-embedded-sibling-media");

      expect(sibling.images).toEqual([]);
      expect(sibling.failedMediaCount).toBe(1);
    } finally {
      envSnapshot.restore();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("surfaces an unsuppressed identity-less inline fact with no image block", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          imageOrder: ["inline"],
          media: [{ kind: "image" }],
          sessionId: "session-missing-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-missing-inline",
          workspaceDir: "/tmp",
        },
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("surfaces inline sanitization failure when a preceding plugin image fact is suppressed", async () => {
    await expect(
      preparePluginHarnessPromptImages({
        runParams: {
          agentId: "main",
          config: { agents: { defaults: { sandbox: { mode: "off" } } } },
          images: [{ type: "image", data: "%%%", mimeType: "image/png" }],
          imageOrder: ["inline"],
          media: [
            {
              path: "/tmp/described-missing.png",
              contentType: "image/png",
              hydrationSuppressed: true,
            },
            { path: "/tmp/inline.png", contentType: "image/png" },
          ],
          sessionId: "session-suppressed-before-inline",
        },
        runtime: {
          model: { input: ["text", "image"] },
          sessionId: "session-suppressed-before-inline",
          workspaceDir: "/tmp",
        },
      } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]),
    ).rejects.toThrow("failed to hydrate 1 structured image attachment");
  });

  it("retains an intentionally non-hydrating remote-only image as a type-only fact", async () => {
    const media = buildInboundMediaNoteProjection({
      media: [{ url: "https://example.com/described.png", contentType: "image/png" }],
      MediaUnderstanding: [
        {
          kind: "image.description",
          attachmentIndex: 0,
          text: "already described",
          provider: "test",
        },
      ],
    }).media;
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-described",
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-described",
        workspaceDir: "/tmp",
      },
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media).toBeUndefined();
  });

  it("retains layout-derived suppression after plugin host materialization", async () => {
    const inlineImage = { type: "image" as const, data: TINY_PNG_BASE64, mimeType: "image/png" };
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        images: [inlineImage],
        imageOrder: ["inline"],
        media: [
          { path: "/tmp/described.png", contentType: "image/png" },
          { path: "/tmp/inline.png", contentType: "image/png" },
        ],
        sessionId: "session-layout-suppressed",
        userTurnTranscriptRecorder: {
          async resolveMessage() {
            return this.message;
          },
          message: {
            role: "user",
            content: "compare",
            __openclaw: {
              media: [
                { path: "/tmp/described.png", contentType: "image/png" },
                { path: "/tmp/inline.png", contentType: "image/png" },
              ],
              mediaImageLayout: {
                slots: [{ kind: "inline", factIndex: 1 }],
                suppressedFactIndexes: [0],
              },
            },
          },
        },
      },
      runtime: {
        model: { input: ["text", "image"] },
        sessionId: "session-layout-suppressed",
        workspaceDir: "/tmp",
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
    const result = await preparePluginHarnessPromptImages({
      runParams: {
        agentId: "main",
        config: { agents: { defaults: { sandbox: { mode: "off" } } } },
        media,
        sessionId: "session-text-only",
      },
      runtime: {
        model: { input: ["text"] },
        sessionId: "session-text-only",
        workspaceDir: "/tmp",
      },
    } as unknown as Parameters<typeof preparePluginHarnessPromptImages>[0]);

    expect(result.images).toEqual([]);
    expect(result.media).toBeUndefined();
  });
});
