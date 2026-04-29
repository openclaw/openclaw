import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./app-server/client.js";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./conversation-binding.js";

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => sharedClientMocks);

let tempDir: string;

describe("codex conversation binding", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clears the Codex app-server sidecar when a pending bind is denied", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sidecar = `${sessionFile}.codex-app-server.json`;
    await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 1, threadId: "thread-1" }));

    await handleCodexConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        data: {
          kind: "codex-app-server-session",
          version: 1,
          sessionFile,
          workspaceDir: tempDir,
        },
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:1",
        },
      },
    });

    await expect(fs.stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("consumes inbound bound messages when command authorization is absent", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile: path.join(tempDir, "session.jsonl"),
            workspaceDir: tempDir,
          },
        },
      },
    );

    expect(result).toEqual({ handled: true });
  });

  it("returns terminal turn/start text for inbound bound messages", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-1",
        cwd: tempDir,
      }),
    );
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") {
        return {
          turn: {
            id: "turn-1",
            status: "completed",
            items: [{ type: "agentMessage", id: "msg-1", text: "already done" }],
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
          },
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    } as unknown as CodexAppServerClient);

    const result = await handleCodexConversationInboundClaim(
      {
        content: "summarize this",
        channel: "discord",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 100 },
    );

    expect(result).toEqual({
      handled: true,
      reply: { text: "already done" },
    });
    expect(request).toHaveBeenCalledWith(
      "turn/start",
      expect.objectContaining({ threadId: "thread-1" }),
      expect.any(Object),
    );
  });
});
