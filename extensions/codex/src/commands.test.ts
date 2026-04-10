import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { resetSharedCodexAppServerClientForTests } from "./app-server/shared-client.js";
import { handleCodexCommand } from "./commands.js";

const commandRpcMocks = vi.hoisted(() => ({
  codexControlRequest: vi.fn(),
  readCodexStatusProbes: vi.fn(),
  requestOptions: vi.fn((_pluginConfig: unknown, limit: number) => ({ limit })),
  safeCodexControlRequest: vi.fn(),
  safeCodexModelList: vi.fn(),
}));

const modelMocks = vi.hoisted(() => ({
  listCodexAppServerModels: vi.fn(),
}));

vi.mock("./command-rpc.js", () => commandRpcMocks);
vi.mock("./app-server/models.js", () => modelMocks);

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
    commandRpcMocks.codexControlRequest.mockReset();
    commandRpcMocks.readCodexStatusProbes.mockReset();
    commandRpcMocks.requestOptions.mockReset();
    commandRpcMocks.requestOptions.mockImplementation((_pluginConfig: unknown, limit: number) => ({
      limit,
    }));
    commandRpcMocks.safeCodexControlRequest.mockReset();
    commandRpcMocks.safeCodexModelList.mockReset();
    modelMocks.listCodexAppServerModels.mockReset();
  });

  afterEach(async () => {
    resetSharedCodexAppServerClientForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("attaches the current session to an existing Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const requests: Array<{ method: string; params: unknown }> = [];
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (_pluginConfig: unknown, method: string, requestParams: unknown) => {
        requests.push({ method: String(method), params: requestParams });
        return {
          thread: { id: "thread-123", cwd: "/repo" },
          model: "gpt-5.4",
          modelProvider: "openai",
        };
      },
    );

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
    modelMocks.listCodexAppServerModels.mockResolvedValue({
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

  it("reports status unavailable when every Codex probe fails", async () => {
    const offline = { ok: false as const, error: "offline" };
    commandRpcMocks.readCodexStatusProbes.mockResolvedValue({
      models: offline,
      account: offline,
      limits: offline,
      mcps: offline,
      skills: offline,
    });

    await expect(handleCodexCommand(createContext("status"))).resolves.toEqual({
      text: [
        "Codex app-server: unavailable",
        "Models: offline",
        "Account: offline",
        "Rate limits: offline",
        "MCP servers: offline",
        "Skills: offline",
      ].join("\n"),
    });
  });

  it("starts compaction for the attached Codex thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-123", cwd: "/repo" }),
    );
    commandRpcMocks.codexControlRequest.mockResolvedValue({});

    await expect(handleCodexCommand(createContext("compact", sessionFile))).resolves.toEqual({
      text: "Started Codex compaction for thread thread-123.",
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.compact,
      {
        threadId: "thread-123",
      },
    );
  });

  it("explains compaction when no Codex thread is attached", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");

    await expect(handleCodexCommand(createContext("compact", sessionFile))).resolves.toEqual({
      text: "No Codex thread is attached to this OpenClaw session yet.",
    });
  });

  it("passes filters to Codex thread listing", async () => {
    commandRpcMocks.codexControlRequest.mockResolvedValue({
      data: [{ id: "thread-123", title: "Fix the thing", model: "gpt-5.4", cwd: "/repo" }],
    });

    await expect(handleCodexCommand(createContext("threads fix"))).resolves.toEqual({
      text: [
        "Codex threads:",
        "- thread-123 - Fix the thing (gpt-5.4, /repo)",
        "  Resume: /codex resume thread-123",
      ].join("\n"),
    });
    expect(commandRpcMocks.codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.listThreads,
      {
        limit: 10,
        filter: "fix",
      },
    );
  });
});
