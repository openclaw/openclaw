import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
describe("deliverMattermostReplyPayload", () => {
  it("passes agent-scoped mediaLocalRoots when sending media paths", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mm-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sendMessage = vi.fn(async () => void 0);
      const core = {
        channel: {
          text: {
            convertMarkdownTables: vi.fn((text) => text),
            resolveChunkMode: vi.fn(() => "length"),
            chunkMarkdownTextWithMode: vi.fn((text) => [text])
          }
        }
      };
      const agentId = "agent-1";
      const mediaUrl = `file://${path.join(stateDir, `workspace-${agentId}`, "photo.png")}`;
      const cfg = {};
      await deliverMattermostReplyPayload({
        core,
        cfg,
        payload: { text: "caption", mediaUrl },
        to: "channel:town-square",
        accountId: "default",
        agentId,
        replyToId: "root-post",
        textLimit: 4e3,
        tableMode: "off",
        sendMessage
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        "caption",
        expect.objectContaining({
          accountId: "default",
          mediaUrl,
          replyToId: "root-post",
          mediaLocalRoots: expect.arrayContaining([path.join(stateDir, `workspace-${agentId}`)])
        })
      );
    } finally {
      if (previousStateDir === void 0) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
  it("forwards replyToId for text-only chunked replies", async () => {
    const sendMessage = vi.fn(async () => void 0);
    const core = {
      channel: {
        text: {
          convertMarkdownTables: vi.fn((text) => text),
          resolveChunkMode: vi.fn(() => "length"),
          chunkMarkdownTextWithMode: vi.fn(() => ["hello"])
        }
      }
    };
    await deliverMattermostReplyPayload({
      core,
      cfg: {},
      payload: { text: "hello" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4e3,
      tableMode: "off",
      sendMessage
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("channel:town-square", "hello", {
      accountId: "default",
      replyToId: "root-post"
    });
  });
});
