import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";

describe("deliverMattermostReplyPayload", () => {
  it("passes agent-scoped mediaLocalRoots when sending media paths", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const sendMessage = vi.fn(async () => undefined);
      const core = {
        channel: {
          text: {
            convertMarkdownTables: vi.fn((text: string) => text),
            resolveChunkMode: vi.fn(() => "length"),
            chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
          },
        },
      } as any;

      const agentId = "agent-1";
      const mediaUrl = `file://${path.join(stateDir, `workspace-${agentId}`, "photo.png")}`;
      const cfg = {} satisfies OpenClawConfig;

      await deliverMattermostReplyPayload({
        core,
        cfg,
        payload: { text: "caption", mediaUrl },
        to: "channel:town-square",
        accountId: "default",
        agentId,
        replyToId: "root-post",
        textLimit: 4000,
        tableMode: "off",
        sendMessage,
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        "caption",
        expect.objectContaining({
          cfg,
          accountId: "default",
          mediaUrl,
          replyToId: "root-post",
          mediaLocalRoots: expect.arrayContaining([path.join(stateDir, `workspace-${agentId}`)]),
        }),
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("forwards replyToId for text-only chunked replies", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const cfg = {} satisfies OpenClawConfig;
    const core = {
      channel: {
        text: {
          convertMarkdownTables: vi.fn((text: string) => text),
          resolveChunkMode: vi.fn(() => "length"),
          chunkMarkdownTextWithMode: vi.fn(() => ["hello"]),
        },
      },
    } as any;

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "hello" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "hello",
      expect.objectContaining({
        cfg,
        accountId: "default",
        replyToId: "root-post",
      }),
    );
  });
});
