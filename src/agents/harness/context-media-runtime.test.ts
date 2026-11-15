import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
} from "../../gateway/managed-image-attachments.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { prepareHarnessContextMedia } from "./context-media-runtime.js";
import { bindHarnessMedia } from "./host-media.js";

const extractionSignals = vi.hoisted(() => [] as Array<AbortSignal | undefined>);
// mock-isolation: Records the cancellation handed to the real document extractor.
vi.mock("../../media/input-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../media/input-files.js")>();
  return {
    ...actual,
    extractFileContentFromBuffer: (
      params: Parameters<typeof actual.extractFileContentFromBuffer>[0],
    ) => {
      extractionSignals.push(params.signal);
      return actual.extractFileContentFromBuffer(params);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("prepareHarnessContextMedia", () => {
  it("restores a cold assistant image only for its owning source and image-capable host", () =>
    withOpenClawTestState({ label: "assistant-context-media" }, async (state) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:images",
        sessionId: "saved-image-session",
        storePath: state.statePath("sessions.sqlite"),
      };
      const config = { session: { store: target.storePath } };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const png = createSolidPngBuffer(2, 2, { r: 34, g: 51, b: 68 });
      const blocks = await createManagedOutgoingMediaBlocks({
        ...target,
        items: [{ url: `data:image/png;base64,${png.toString("base64")}`, trustedLocal: false }],
      });
      expect(blocks).toHaveLength(1);
      const message = {
        ...makeAssistantMessageFixture({
          content: [{ type: "text", text: "Your saved badge." }],
          stopReason: "stop",
          errorMessage: undefined,
        }),
        idempotencyKey: "saved-badge-answer",
        openclawDisplayContent: blocks,
      };
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const messageId = await manager.appendMessageAsync(message);
      expect(messageId).toBeTruthy();
      expect(await attachManagedOutgoingMediaToMessage({ messageId: messageId!, blocks })).toBe(
        true,
      );
      const [saved] = await SessionManager.readSessionContextAsync(target, (items) => [...items]);
      expect(saved?.role).toBe("assistant");
      if (!saved) {
        throw new Error("Saved assistant answer was not reloaded");
      }
      const source = JSON.stringify(saved);
      let active = true;
      const bind = (
        overrides: { agentId?: string; sessionKey?: string; sessionId?: string } = {},
        image = true,
      ) =>
        bindHarnessMedia({
          attempt: {
            ...target,
            ...overrides,
            workspaceDir: state.workspaceDir,
            model: makeProviderModelFixture({
              id: "context-model",
              provider: "fixture",
              api: "openai-responses",
              baseUrl: "https://model.example/v1",
              input: image ? ["text", "image"] : ["text"],
            }),
          },
          config,
          signal: new AbortController().signal,
          assertActive: () => {
            if (!active) {
              throw new Error("host closed");
            }
          },
        }).capabilities.prepareContextMedia!;
      const request = { message: saved, maxChars: 10_000 };
      const prepare = bind();
      const restored = await prepare(request);
      expect(restored.images).toEqual([
        { type: "image", mimeType: "image/png", data: png.toString("base64") },
      ]);
      for (const overrides of [
        { sessionId: "different-physical-session" },
        { sessionKey: "agent:main:other" },
        { agentId: "other" },
      ]) {
        expect((await bind(overrides)(request)).images).toEqual([]);
      }
      const anotherSource = { ...message, idempotencyKey: "another-answer" };
      expect((await prepare({ ...request, message: anotherSource })).images).toEqual([]);
      const { idempotencyKey: _, ...unkeyed } = message;
      for (const unavailable of [
        unkeyed,
        { ...message, provider: "openclaw", model: "delivery-mirror" },
        {
          ...message,
          openclawDisplayContent: [{ type: "image", url: "https://image.example/foreign.png" }],
        },
      ]) {
        expect((await prepare({ ...request, message: unavailable })).images).toEqual([]);
      }
      expect(await bind({}, false)(request)).toMatchObject({
        images: [],
        text: "[Attachment images omitted: this model does not support image input]",
      });
      expect(JSON.stringify(saved)).toBe(source);
      active = false;
      await expect(prepare(request)).rejects.toThrow("host closed");
    }));

  it("hands the run's cancellation to retained document extraction", async () => {
    const workspaceDir = tempDirs.make("openclaw-context-document-");
    const notePath = path.join(workspaceDir, "notes.txt");
    await fs.writeFile(notePath, "retained document body");
    const run = new AbortController();
    const prepare = bindHarnessMedia({
      attempt: {
        workspaceDir,
        abortSignal: run.signal,
        model: makeProviderModelFixture({
          id: "context-model",
          provider: "fixture",
          api: "openai-responses",
          baseUrl: "https://model.example/v1",
          input: ["text"],
        }),
      },
      signal: new AbortController().signal,
      assertActive: () => {},
    }).capabilities.prepareContextMedia!;
    extractionSignals.length = 0;

    const result = await prepare({
      message: {
        role: "user",
        content: "summarize",
        timestamp: 1,
        __openclaw: { media: [{ path: notePath, contentType: "text/plain" }] },
      } as never,
      maxChars: 10_000,
    });

    expect(result.text).toContain("retained document body");
    expect(extractionSignals).toEqual([run.signal]);
  });

  it("marks an unrestorable historical image neutrally instead of asking for a resend", async () => {
    const workspaceDir = tempDirs.make("openclaw-context-media-");
    const message = {
      role: "user" as const,
      content: "what is this?",
      timestamp: 1,
      __openclaw: {
        media: [{ path: path.join(workspaceDir, "gone.png"), contentType: "image/png" }],
      },
    };

    const result = await prepareHarnessContextMedia({
      message,
      maxChars: 10_000,
      workspaceDir,
      modelInput: ["text", "image"],
      assertCurrent: () => {},
    });

    expect(result.images).toEqual([]);
    expect(result.text?.split("\n\n").at(-1)).toBe(
      "[1 referenced image not included in this context]",
    );
  });
});
