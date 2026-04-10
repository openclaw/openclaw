import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSharedCodexAppServerClientForTests } from "./app-server/client.js";
import { handleCodexCommand } from "./commands.js";

let tempDir: string;

function createContext(args: string, sessionFile?: string): PluginCommandContext {
  return {
    channel: "test",
    isAuthorizedSender: true,
    args,
    commandBody: `/codex ${args}`,
    config: {},
    sessionFile,
    requestConversationBinding: async () => ({ status: "error", message: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

describe("codex command", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
  });

  afterEach(async () => {
    resetSharedCodexAppServerClientForTests();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("attaches the current session to an existing Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: unknown }> = [];
    vi.spyOn(
      await import("./app-server/client.js"),
      "requestCodexAppServerJson",
    ).mockImplementation(async ({ method, requestParams }) => {
      requests.push({ method, params: requestParams });
      return {
        thread: { id: "thread-123", cwd: "/repo" },
        model: "gpt-5.4",
        modelProvider: "openai",
      };
    });

    await expect(
      handleCodexCommand(createContext("resume thread-123", sessionFile)),
    ).resolves.toEqual({
      text: "Attached this OpenClaw session to Codex thread thread-123.",
    });

    expect(requests).toEqual([
      {
        method: "thread/resume",
        params: { threadId: "thread-123", persistExtendedHistory: true },
      },
    ]);
    await expect(fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8")).resolves.toContain(
      '"threadId": "thread-123"',
    );
  });

  it("shows model ids from Codex app-server", async () => {
    vi.spyOn(await import("./app-server/client.js"), "listCodexAppServerModels").mockResolvedValue({
      models: [
        {
          id: "gpt-5.4",
          model: "gpt-5.4",
          inputModalities: ["text"],
          supportedReasoningEfforts: ["medium"],
        },
      ],
    });

    await expect(handleCodexCommand(createContext("models"))).resolves.toEqual({
      text: "Codex models:\n- gpt-5.4",
    });
  });
});
