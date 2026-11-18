import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { onAgentEventForRun } from "../../infra/agent-events.js";
import { readMemoryArtifactProvenance } from "../../memory/memory-artifact-provenance.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import type {
  CliBackendExecuteContext,
  CliBackendPlugin,
} from "../../plugins/cli-backend.types.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
  type MemoryPluginRuntime,
} from "../../plugins/memory-state.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { createCliDispatchTranscriptRecorder } from "../embedded-agent-runner/cli-backend-dispatch-transcript.js";
import {
  createMemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "../memory-write-provenance.js";
import { createCliEventHandlers } from "./execute-events.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import { closePluginTestAdmissions, createExecution } from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

// Inspect the real recorder's output without persisting a synthetic conversation.
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  appendTranscriptMessage: vi.fn(async () => ({ appended: true })),
}));
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.js";

// Public plugin API: production Claude transport, with only its native executable replaced.
const { buildAnthropicCliBackend } = await vi.importActual<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>("../../../extensions/anthropic/api.js");

const FILES = ["MEMORY.md", "USER.md", "memory/nested/note.md"];
const { createMemoryRuntime } = await vi.importActual<{
  createMemoryRuntime: (host: {
    runInBackgroundContext: <T>(run: () => T) => T;
  }) => MemoryPluginRuntime;
}>("../../../extensions/memory-core/runtime-api.js");
const NATIVE_FIXTURE = String.raw`
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
const calls = JSON.parse(process.env.MUTATIONS);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let hooks;
let index = 0;
const hook = (name) => send({ type: "control_request", request_id: name + index, request: {
  subtype: "hook_callback", callback_id: hooks[name][0].hookCallbackIds[0],
  tool_use_id: "mutation-" + index,
  input: { hook_event_name: name, tool_name: calls[index].name, tool_input: calls[index].input, cwd: process.cwd() },
} });
const next = () => {
  if (index < calls.length) hook("PreToolUse");
  else send({ type: "result", subtype: "success", is_error: false, result: "completed", session_id: "fixture-session" });
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    hooks = message.request.hooks;
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { commands: [], models: [] } } });
  } else if (message.type === "user") next();
  else if (message.type === "control_response") {
    const response = message.response;
    if (response.request_id.startsWith("PreToolUse")) {
      const decision = response.response?.hookSpecificOutput;
      const call = calls[index];
      if (decision?.permissionDecision === "allow" && !call.fail) {
        const input = decision.updatedInput;
        const content = call.name === "Write" ? input.content : readFileSync(input.file_path, "utf8").replace(input.old_string, input.new_string);
        writeFileSync(input.file_path, content);
        if (hooks.PostToolUse) { hook("PostToolUse"); continue; }
      }
    }
    index++;
    next();
  }
}
`;

afterEach(() => {
  closePluginTestAdmissions();
  clearMemoryPluginState();
  resetPluginStateStoreForTests();
  vi.clearAllMocks();
});

it.each(["clean", "network", "non-owner", "delegation-only"])(
  "observes native pre/post writes for %s without widening authority",
  async (mode) => {
    const tainted = mode === "network";
    const untrusted = tainted || mode === "non-owner";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspaceDir = state.workspaceDir;
      registerMemoryCapability("memory-core", {
        runtime: createMemoryRuntime({ runInBackgroundContext: (run) => run() }),
      });
      await fs.mkdir(path.join(workspaceDir, "memory/nested"), { recursive: true });
      const operations = withMemoryWriteProvenance(
        {
          readFile: (file: string) => fs.readFile(file),
          writeFile: async (file: string, content: string) => fs.writeFile(file, content),
        },
        createMemoryWriteProvenanceObserver({
          mutationRoot: workspaceDir,
          workspaceDir,
          resolveOriginClass: () => "agent",
        }),
      );
      for (const file of [...FILES, "memory/drift.md", "memory/failed.md"]) {
        await operations.writeFile(path.join(workspaceDir, file), "seed");
      }
      await fs.writeFile(path.join(workspaceDir, "memory/drift.md"), "external seed");
      const config = {
        agents: { defaults: { workspace: workspaceDir } },
        plugins: { enabled: false },
        tools: { exec: { security: "full" as const, ask: "off" as const } },
      };
      const { context } = await createExecution({
        config,
        nativeTools: mode === "delegation-only" ? ["Agent", "Workflow"] : ["Edit", "Write"],
        timeoutMs: 20_000,
      });
      context.workspaceDir = workspaceDir;
      context.cwd = workspaceDir;
      context.params.senderIsOwner = mode !== "non-owner";
      context.resultContentSourceByToolName = new Map([["web_fetch", "network"]]);
      const recorder = createCliDispatchTranscriptRecorder({
        admittedRunContext: context.params.admittedRunContext,
        sessionId: "native-proof",
        runId: context.params.runId,
        provider: "claude-cli",
        prompt: "Synthetic memory proof",
      });
      const unsubscribe = onAgentEventForRun(context.params.runId, (event) => {
        if (event.stream !== "tool") {
          return;
        }
        const data = event.data;
        if (data.phase !== "start" && data.phase !== "result") {
          return;
        }
        recorder.noteToolEvent({
          phase: data.phase,
          toolName: String(data.name),
          result: data.result,
          ...(data.resultContentSource === "network" ? { resultContentSource: "network" } : {}),
        });
      });
      const tracking = createCliToolTracking(context);
      const events = createCliEventHandlers({
        context,
        toolTracking: tracking,
        getRunState: () => ({ failed: false, error: undefined }),
      });
      if (tainted) {
        events.emitParsedToolUseStart({
          name: "mcp__openclaw__web_fetch",
          toolCallId: "network",
          kind: "mcp_tool_use",
          args: { url: "https://example.com/proof" },
        });
        events.emitParsedToolResult({
          name: "mcp__openclaw__web_fetch",
          toolCallId: "network",
          isError: false,
          result: [{ type: "text", text: "Synthetic network note" }],
        });
      }
      const backend = buildAnthropicCliBackend();
      const prepared = await backend.prepareExecution?.({
        workspaceDir,
        provider: "claude-cli",
        modelId: "claude-sonnet-4-6",
        executionMode: "agent",
      });
      if (!prepared?.execute) {
        throw new Error("Claude transport unavailable");
      }
      const fixture = path.join(workspaceDir, "native-fixture.mjs");
      await fs.writeFile(fixture, NATIVE_FIXTURE);
      const calls = [...FILES, "memory/drift.md", "memory/failed.md"].map((file, index) => ({
        name: index === 0 ? "Write" : "Edit",
        input:
          index === 0
            ? { file_path: file, content: "native" }
            : { file_path: file, old_string: "seed", new_string: "native" },
        fail: file === "memory/failed.md",
      }));
      let retainedObserver: CliBackendExecuteContext["observeToolMutation"];
      const execute = prepared.execute;
      try {
        await executePluginOwnedProcess({
          context,
          execute: (execution) => {
            retainedObserver = execution.observeToolMutation;
            return execute(execution);
          },
          executionCommand: process.execPath,
          executionArgs: [fixture],
          env: {
            PATH: process.env.PATH ?? "",
            HOME: workspaceDir,
            OPENCLAW_STATE_DIR: state.stateDir,
            MUTATIONS: JSON.stringify(calls),
          },
          prompt: "Synthetic proof",
          useResume: false,
          noOutputTimeoutMs: 10_000,
          consumeStdout: () => {},
        });
      } finally {
        unsubscribe();
        tracking.finalizeCapture(events.finalizeParsedTools);
        await recorder.finalize("completed");
        await prepared.cleanup?.();
      }
      if (tainted) {
        expect(vi.mocked(appendTranscriptMessage).mock.calls.at(-1)?.[1].message).toMatchObject({
          __openclaw: { turnTainted: true },
        });
      }
      await expect(
        retainedObserver?.({
          phase: "after",
          toolName: "Write",
          toolCallId: "mutation-0",
          toolInput: { file_path: "MEMORY.md" },
        }),
      ).rejects.toThrow();
      if (mode === "delegation-only") {
        for (const relativePath of FILES) {
          expect(await fs.readFile(path.join(workspaceDir, relativePath), "utf8")).toBe("seed");
          expect(await readMemoryArtifactProvenance({ workspaceDir, relativePath })).toMatchObject({
            originClass: "agent",
          });
        }
        return;
      }
      for (const relativePath of FILES) {
        expect(await fs.readFile(path.join(workspaceDir, relativePath), "utf8")).toBe("native");
        expect(await readMemoryArtifactProvenance({ workspaceDir, relativePath })).toMatchObject({
          originClass: untrusted ? "untrusted" : "agent",
          sessionId: context.params.sessionId,
        });
        await operations.writeFile(path.join(workspaceDir, relativePath), "later clean edit");
        expect(await readMemoryArtifactProvenance({ workspaceDir, relativePath })).toMatchObject({
          originClass: untrusted ? "untrusted" : "agent",
        });
      }
      expect(
        await readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/drift.md" }),
      ).toMatchObject({ originClass: "untrusted" });
      expect(await fs.readFile(path.join(workspaceDir, "memory/failed.md"), "utf8")).toBe("seed");
      expect(
        await readMemoryArtifactProvenance({ workspaceDir, relativePath: "memory/failed.md" }),
      ).toMatchObject({ originClass: "agent" });
      const { contextFiles } = await resolveBootstrapContextForRun({
        workspaceDir,
        config,
        agentId: "main",
        sessionKey: "agent:main:main",
      });
      expect(contextFiles.some((file) => file.content.includes("later clean edit"))).toBe(
        !untrusted,
      );
    });
  },
);
