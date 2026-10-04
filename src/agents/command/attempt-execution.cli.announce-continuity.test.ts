// Drives the real attempt, CLI preparation, loopback MCP grant, child process, and binding
// settlement across requester turns around an isolated completion turn. The fixture CLI
// writes Claude-shaped native transcripts and probes the MCP surface it was handed.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { closeMcpLoopbackServer } from "../../gateway/mcp-http.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  type InputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../sessions/input-provenance.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../cli-runner/prepare.test-support.js";
import { getCliSessionBinding } from "../cli-session.js";
import { makeRunAgentAttemptParams } from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "./attempt-execution.js";
import { resolveClaudeCliProjectDirForWorkspace } from "./claude-cli-project-dir.js";
import type { AgentCommandOpts } from "./types.js";

const REQUESTER_KEY = "agent:main:direct:announce-continuity";
const REQUESTER_SESSION_ID = "announce-continuity-requester";
const CHILD_KEY = "agent:main:subagent:announce-continuity-child";
const CHILD_SESSION_ID = "announce-continuity-child";
const CHILD_RESULT = "CHILD_RESULT_7f3a9c";
const ANNOUNCE_REPLY = `ANNOUNCE_REPLY_${CHILD_RESULT}`;

// Claude-shaped fixture: honors --session-id/--resume, appends each turn to the native
// transcript Claude would resume, and records what the turn could reach. A completion
// turn also calls a forbidden tool directly, ignoring advisory CLI tool arguments.
const FIXTURE_CLAUDE = String.raw`
import fs from "node:fs";
import path from "node:path";
const [logPath, ...argv] = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.lastIndexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const resumed = valueOf("--resume");
const sessionId = resumed ?? valueOf("--session-id");
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const mcpConfigPath = valueOf("--mcp-config");
const mcpServers = mcpConfigPath ? JSON.parse(fs.readFileSync(mcpConfigPath, "utf8")).mcpServers ?? {} : {};
const callOpenClaw = async (method, params) => {
  const server = mcpServers.openclaw;
  const response = await fetch(server.url, {
    method: "POST",
    headers: { ...server.headers, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()).result;
};
const loopbackTools = mcpServers.openclaw
  ? (await callOpenClaw("tools/list", {})).tools.map((tool) => tool.name).toSorted()
  : [];
// Only the turn's own leading envelope marks a completion; carried context may quote one.
const completion = /^\[Inter-session message\][^\n]*sourceTool=subagent_announce/.test(prompt);
const forbiddenCall = completion
  ? (await callOpenClaw("tools/call", { name: "exec", arguments: { command: "true" } })).content
      .map((block) => block.text)
      .join("\n")
  : null;
const projectDir = path.join(
  process.env.HOME,
  ".claude",
  "projects",
  fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"),
);
fs.mkdirSync(projectDir, { recursive: true });
const transcript = path.join(projectDir, sessionId + ".jsonl");
const turns = fs.existsSync(transcript)
  ? fs.readFileSync(transcript, "utf8").split("\n").filter(Boolean).length / 2
  : 0;
const marker = /CHILD_RESULT_[0-9a-f]+/.exec(prompt)?.[0];
const reply = completion && marker ? "ANNOUNCE_REPLY_" + marker : "REPLY_" + turns;
fs.appendFileSync(
  transcript,
  JSON.stringify({ type: "user", sessionId, message: { role: "user", content: prompt } }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      sessionId,
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
    }) +
    "\n",
);
fs.appendFileSync(
  logPath,
  JSON.stringify({
    sessionId,
    resumed: Boolean(resumed),
    mcpServers: Object.keys(mcpServers).toSorted(),
    nativeTools: valueOf("--tools") ?? null,
    loopbackTools,
    forbiddenCall,
    prompt,
    reply,
  }) + "\n",
);
const emit = (record) => process.stdout.write(JSON.stringify(record) + "\n");
emit({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
emit({
  type: "assistant",
  session_id: sessionId,
  message: { id: "msg_" + turns, role: "assistant", content: [{ type: "text", text: reply }] },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: reply,
  session_id: sessionId,
  usage: { input_tokens: 1, output_tokens: 1 },
});
`;

// Minimal external stdio MCP server: requester turns serve it, restricted turns must not.
const USER_MCP_SERVER = String.raw`
import readline from "node:readline";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "user-docs", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [{ name: "search_docs", description: "search", inputSchema: { type: "object" } }] });
}
`;

type FixtureTurn = {
  sessionId: string;
  resumed: boolean;
  mcpServers: string[];
  nativeTools: string | null;
  loopbackTools: string[];
  forbiddenCall: string | null;
  prompt: string;
  reply: string;
};

function fixtureBackend(script: string, logPath: string): CliBackendPlugin {
  const baseArgs = [script, logPath, "-p", "--output-format", "stream-json"];
  return {
    id: "claude-cli",
    modelProvider: "anthropic",
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "execution-args",
    resolveExecutionArgs: ({ baseArgs: args, toolAvailability }) =>
      toolAvailability ? [...args, "--tools", toolAvailability.native.join(",")] : [...args],
    config: {
      command: process.execPath,
      args: baseArgs,
      resumeArgs: [...baseArgs, "--resume", "{sessionId}"],
      sessionArgs: ["--session-id", "{sessionId}"],
      sessionMode: "always",
      output: "jsonl",
      jsonlDialect: "claude-stream-json",
      input: "stdin",
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptMode: "append",
      systemPromptWhen: "always",
    },
  };
}

const completionOpts: Partial<AgentCommandOpts> = {
  trustedInternalHandoff: {
    kind: "subagent-completion",
    sourceSessionKey: CHILD_KEY,
    sourceSessionId: CHILD_SESSION_ID,
    targetSessionKey: REQUESTER_KEY,
    targetSessionId: REQUESTER_SESSION_ID,
    provider: "claude-cli",
    model: "opus",
  },
  inputProvenance: {
    kind: "inter_session",
    sourceSessionKey: CHILD_KEY,
    sourceChannel: "internal",
    sourceTool: "subagent_announce",
  },
  internalEvents: [
    {
      type: "task_completion",
      source: "subagent",
      childSessionKey: CHILD_KEY,
      childSessionId: CHILD_SESSION_ID,
      announceType: "subagent task",
      taskLabel: "docs review",
      status: "ok",
      statusLabel: "completed",
      result: CHILD_RESULT,
      replyInstruction: "Relay this completion.",
    },
  ],
};

describe("Claude CLI completion announce continuity", () => {
  let state: OpenClawTestState;
  let logPath: string;
  let storePath: string;
  let config: OpenClawConfig;

  beforeEach(async () => {
    await bindSessionMcpRuntimeTestScheduler();
    state = await createOpenClawTestState({ label: "cli-announce-continuity" });
    logPath = state.path("fixture-claude.jsonl");
    storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const script = await state.writeText("fixture-claude.mjs", FIXTURE_CLAUDE);
    const userServer = await state.writeText("user-docs-mcp.mjs", USER_MCP_SERVER);
    const backend = fixtureBackend(script, logPath);
    const registry = createEmptyPluginRegistry();
    registry.cliBackends.push({ pluginId: "anthropic", source: "test", backend });
    setActivePluginRegistry(registry);
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [{ ...backend, pluginId: "anthropic" }],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      makeBootstrapWarn: () => () => undefined,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      getCliLiveSessionGeneration: () => undefined,
      loadManifestModelCatalog: () => [],
    });
    config = {
      session: { store: storePath },
      agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } },
      mcp: { servers: { userDocs: { command: process.execPath, args: [userServer] } } },
    } as OpenClawConfig;
    await state.writeConfig(config);
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await replaceSessionEntry(
      { sessionKey: REQUESTER_KEY, storePath },
      { sessionId: REQUESTER_SESSION_ID, updatedAt: 1 },
    );
    // The completion turn's cap is the requester policy captured on the child at spawn.
    await replaceSessionEntry(
      { sessionKey: CHILD_KEY, storePath },
      {
        sessionId: CHILD_SESSION_ID,
        updatedAt: 1,
        spawnedBy: REQUESTER_KEY,
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
        inheritedToolPolicyVersion: 1,
        inheritedToolDeny: ["exec"],
      },
    );
  });

  afterEach(async () => {
    await closeMcpLoopbackServer();
    await disposeAllSessionMcpRuntimes();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    await state.cleanup();
  });

  function requesterEntry(): SessionEntry {
    const entry = loadSessionEntry({ sessionKey: REQUESTER_KEY, storePath });
    if (!entry) {
      throw new Error("requester session entry is missing");
    }
    return entry;
  }

  async function readFixtureTurns(): Promise<FixtureTurn[]> {
    const raw = await fs.readFile(logPath, "utf8").catch(() => "");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FixtureTurn);
  }

  async function runTurn(params: {
    runId: string;
    body: string;
    opts?: Partial<AgentCommandOpts>;
  }): Promise<FixtureTurn> {
    const sessionEntry = requesterEntry();
    const before = await readFixtureTurns();
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      config,
      params.runId,
      "main",
      "announce-continuity-fixture",
    );
    try {
      await runAgentAttempt(
        makeRunAgentAttemptParams({
          preparedRunAdmission,
          providerOverride: "claude-cli",
          modelOverride: "opus",
          cfg: config,
          sessionEntry,
          sessionKey: REQUESTER_KEY,
          storePath,
          sessionStore: { [REQUESTER_KEY]: sessionEntry },
          workspaceDir: state.workspaceDir,
          agentDir: state.agentDir(),
          skillsSnapshot: { prompt: "", skills: [] },
          timeoutMs: 30_000,
          body: params.body,
          runId: params.runId,
          // Mirrors the Gateway preflight: completion handoffs keep user-facing state.
          preserveCliSessionBinding: shouldPreserveUserFacingSessionStateForInputProvenance(
            params.opts?.inputProvenance as InputProvenance | undefined,
          ),
          opts: params.opts,
          messageChannel: "webchat",
        }),
      );
    } finally {
      preparedRunAdmission.close();
    }
    const after = await readFixtureTurns();
    expect(after).toHaveLength(before.length + 1);
    return after.at(-1) as FixtureTurn;
  }

  async function readNativeTranscript(sessionId: string): Promise<string> {
    const projectDir = resolveClaudeCliProjectDirForWorkspace({
      workspaceDir: state.workspaceDir,
    });
    return await fs.readFile(path.join(projectDir, `${sessionId}.jsonl`), "utf8");
  }

  it("keeps the completion turn restricted and carries its exchange into the next resume once", async () => {
    const first = await runTurn({ runId: "run-requester-1", body: "Spawn the docs review." });
    const boundSessionId = getCliSessionBinding(requesterEntry(), "claude-cli")?.sessionId;
    expect(first).toMatchObject({ resumed: false, sessionId: boundSessionId });
    expect(first.mcpServers).toEqual(["openclaw", "userDocs"]);
    expect(first.nativeTools).toBeNull();

    const completion = await runTurn({
      runId: "run-completion-1",
      body: `A background task finished. Child result: ${CHILD_RESULT}. Process the completion update now.`,
      opts: completionOpts,
    });
    // Denial: the completion turn keeps its own isolated, restricted surface.
    expect(completion.sessionId).not.toBe(boundSessionId);
    expect(completion.mcpServers).toEqual(["openclaw"]);
    expect(completion.nativeTools).toBe("");
    expect(completion.loopbackTools).toContain("read");
    expect(completion.loopbackTools).not.toContain("exec");
    expect(completion.forbiddenCall).toBe("Tool not available: exec");
    expect(completion.reply).toBe(ANNOUNCE_REPLY);
    expect(getCliSessionBinding(requesterEntry(), "claude-cli")?.sessionId).toBe(boundSessionId);

    // Continuity: the next requester turn resumes the bound session with that exchange.
    const next = await runTurn({ runId: "run-requester-2", body: "What did the review find?" });
    expect(next).toMatchObject({ resumed: true, sessionId: boundSessionId });
    expect(next.mcpServers).toEqual(["openclaw", "userDocs"]);
    const resumedContext = await readNativeTranscript(next.sessionId);
    expect(resumedContext).toContain(CHILD_RESULT);
    expect(resumedContext).toContain(ANNOUNCE_REPLY);
    expect(getCliSessionBinding(requesterEntry(), "claude-cli")?.unseenTurns).toBeUndefined();

    // The carried exchange enters the native session once.
    const later = await runTurn({ runId: "run-requester-3", body: "Thanks." });
    expect(later).toMatchObject({ resumed: true, sessionId: boundSessionId });
    expect(later.prompt).not.toContain(ANNOUNCE_REPLY);
  });
});
