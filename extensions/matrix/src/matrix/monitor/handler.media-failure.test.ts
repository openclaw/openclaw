import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", () => ({
  downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
}));

function createMediaFailureHarness() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const runtime = {
    error: vi.fn(),
  };
  const harness = createMatrixHandlerTestHarness({
    logger: logger as never,
    runtime: runtime as never,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    resolveAgentRoute: () => ({
      agentId: "main",
      accountId: "ops",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      mainSessionKey: "agent:main:main",
      channel: "matrix",
      matchedBy: "binding.account",
    }),
    resolveStorePath: () => "/tmp/openclaw-test-session.json",
    readSessionUpdatedAt: () => 123,
    getRoomInfo: async () => ({
      name: "Media Room",
      canonicalAlias: "#media:example.org",
      altAliases: [],
    }),
    getMemberDisplayName: async () => "Gum",
    startupMs: Date.now() - 120_000,
    startupGraceMs: 60_000,
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    replyToMode: "first",
  });

  return {
    ...harness,
    logger,
    runtime,
  };
}

function createImageEvent(content: Record<string, unknown>) {
  return createMatrixRoomMessageEvent({
    eventId: "$event1",
    sender: "@gum:matrix.example.org",
    content: {
      ...content,
      "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
    } as never,
  });
}

describe("createMatrixRoomMessageHandler media failures", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("replaces bare image filenames with an unavailable marker when unencrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession, logger, runtime } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "image.png",
        url: "mxc://example/image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          RawBody: "[matrix image attachment unavailable]",
          CommandBody: "[matrix image attachment unavailable]",
          MediaPath: undefined,
        }),
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "matrix media download failed",
      expect.objectContaining({
        eventId: "$event1",
        msgtype: "m.image",
        encrypted: false,
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("replaces bare image filenames with an unavailable marker when encrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("decrypt failed"));
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "photo.jpg",
        file: {
          url: "mxc://example/encrypted",
          key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          RawBody: "[matrix image attachment unavailable]",
          CommandBody: "[matrix image attachment unavailable]",
          MediaPath: undefined,
        }),
      }),
    );
  });

  it("preserves a real caption while marking the attachment unavailable", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "can you see this image?",
        filename: "image.png",
        url: "mxc://example/image",
      }),
    );

    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          RawBody: "can you see this image?\n\n[matrix image attachment unavailable]",
          CommandBody: "can you see this image?\n\n[matrix image attachment unavailable]",
        }),
      }),
    );
  });
});
