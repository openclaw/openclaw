// Real CLI loopback and generic plugin-harness effects; no native CLI/model credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { readResolvedSessionEntryInWorker } from "../../config/sessions/session-accessor.entry.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  getActiveMcpLoopbackRuntime,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resolveMcpLoopbackPolicyTools } from "../../gateway/mcp-http.runtime.js";
import { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildCliMcpGrantContext, finalizeCliMcpGrant } from "../cli-runner/mcp-grant-context.js";
import { resolveCliRuntimeToolPolicy } from "../cli-runner/prepare-tool-policy.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "./tool-execution.js";
import { runAgentHarnessToolInvocation } from "./tool-invocation.js";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

const requester = "agent:intake:main";
const denied = ["exec", "write"];
type Route = "cli-loopback" | "plugin-harness";
type Receipt = { isError: boolean; text: string };
let state: OpenClawTestState;
let config: OpenClawConfig;
let sequence = 0;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-mediated-delegation-",
    layout: "state-only",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_EXEC_SHELL_SNAPSHOT: "0" },
  });
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: {
        intake: {
          tools: { deny: denied },
          subagents: { allowAgents: ["coder"] },
        },
        coder: { workspace: state.workspaceDir },
      },
    },
    plugins: { enabled: false },
    tools: {
      allow: ["read", "write", "exec"],
      codeMode: false,
      toolSearch: false,
      exec: { host: "gateway", security: "full", ask: "off", notifyOnExit: false },
    },
  };
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
  await replaceSessionEntry(
    { agentId: "intake", sessionKey: requester },
    { sessionId: "intake", updatedAt: 1 },
  );
  await ensureMcpLoopbackServer(0);
});
beforeEach(() => setRuntimeConfigSnapshot(config));
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
});
afterAll(async () => {
  await closeMcpLoopbackServer();
  clearRuntimeConfigSnapshot();
  await state?.cleanup();
});

async function createCaller(route: Route, existingSessionKey = "", senderRestricted = false) {
  const runId = "mediated-" + ++sequence;
  const sessionKey = existingSessionKey || "agent:coder:dashboard:" + runId;
  const scope = { cfg: config, agentId: "coder", sessionKey };
  let sessionEntry = await readResolvedSessionEntryInWorker(scope);
  if (!sessionEntry) {
    await replaceSessionEntry(scope, {
      sessionId: runId,
      updatedAt: 1,
      spawnedBy: requester,
      spawnDepth: 1,
      inheritedToolPolicyVersion: 1,
      ...(senderRestricted ? { inheritedToolPolicySource: "sender" as const } : {}),
      inheritedToolDeny: denied,
    });
    sessionEntry = await readResolvedSessionEntryInWorker(scope);
  }
  expect(sessionEntry?.inheritedToolDeny).toEqual(denied);
  const admission = prepareSystemAgentRunAdmission(config, runId, "coder", "mediated-effect-test");
  cleanups.push(admission.close);
  const admittedRunContext = await admission.admit(
    route === "cli-loopback" ? "embedded" : "plugin-harness",
  );
  const trace: string[] = [];
  const workspaceDir = state.workspaceDir;
  if (route === "cli-loopback") {
    const run: RunCliAgentParams = {
      config,
      sessionId: sessionEntry!.sessionId,
      sessionKey,
      sessionEntry,
      sessionFile: state.path(runId + ".jsonl"),
      workspaceDir,
      cwd: workspaceDir,
      provider: "fixture-cli",
      model: "fixture",
      prompt: "exercise mediated effects",
      runId,
      timeoutMs: 10_000,
      admittedRunContext,
    };
    const policy = resolveCliRuntimeToolPolicy({
      params: run,
      policySessionKey: sessionKey,
      policyAgentId: "coder",
      backendId: "fixture-cli",
      bundleMcp: true,
      canEnforceExactToolAvailability: true,
      isSideQuestion: false,
      skipsTurnPreparation: false,
    });
    expect(policy.params.cliToolAvailability?.native).toEqual(senderRestricted ? [] : undefined);
    const context = buildCliMcpGrantContext({
      run: policy.params,
      config,
      requireExplicitMessageTarget: false,
      agentId: "coder",
      modelProvider: "fixture",
      modelId: "fixture",
      toolsAllow: policy.runtimeToolsAllowPolicy ?? ["read", "write", "exec"],
    });
    const projected = await resolveMcpLoopbackPolicyTools({
      cfg: config,
      context,
      admittedRunContext,
    });
    const names = projected.tools.map((tool) => tool.name);
    const grantInput = finalizeCliMcpGrant(context, names, false, run)!;
    const runtime = getActiveMcpLoopbackRuntime()!;
    const grant = mintMcpLoopbackClientGrant({
      ...grantInput,
      runtimeOwnerToken: runtime.ownerToken,
    });
    const captureKey = runId + "-capture";
    cleanups.push(() => {
      clearMcpLoopbackToolCallCapture(captureKey);
      revokeMcpLoopbackClientGrant(grant.token);
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey,
      }),
    ).not.toBe(false);
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: (call) => trace.push(call.toolName + ":" + call.outcome),
    });
    const request = async (method: string, params?: object) => {
      const response = await fetch("http://127.0.0.1:" + runtime.port + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer " + grant.token,
          "content-type": "application/json",
          "x-openclaw-cli-capture-key": captureKey,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++sequence,
          method,
          ...(params ? { params } : {}),
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: {
          tools?: Array<{ name: string }>;
          content?: Array<{ text?: string }>;
          isError?: boolean;
        };
      };
    };
    const listed = await request("tools/list");
    expect(listed.result.tools?.map((tool) => tool.name).toSorted()).toEqual(names.toSorted());
    return {
      sessionKey,
      names,
      trace,
      call: async (name: string, args: Record<string, unknown>): Promise<Receipt> => {
        const reply = await request("tools/call", { name, arguments: args });
        trace.push("mcp-client:" + name + ":" + (reply.result.isError ? "error" : "ok"));
        return {
          isError: reply.result.isError === true,
          text: (reply.result.content ?? []).map((block) => block.text ?? "").join("\n"),
        };
      },
    };
  }
  const host = createAgentHarnessHostCapabilities({
    pluginId: "fixture-mediated-harness",
    attempt: {
      config,
      runId,
      agentId: "coder",
      sessionId: sessionEntry!.sessionId,
      sessionKey,
      workspaceDir,
      cwd: workspaceDir,
      admittedRunContext,
    },
  });
  cleanups.push(host.close);
  const tools = await host.capabilities.createToolSurfaceAsync!({
    config,
    agentId: "coder",
    sessionKey,
    workspaceDir,
    runId,
    includeToolSearchControls: false,
  });
  const boundaries = createAgentHarnessToolExecutionBoundaryRegistry();
  const middleware = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);
  return {
    sessionKey,
    names: tools.map((tool) => tool.name),
    trace,
    call: (name: string, args: Record<string, unknown>): Promise<Receipt> =>
      runAgentHarnessToolInvocation({
        tool: tools.find((tool) => tool.name === name),
        runId,
        call: {
          toolCallId: runId + "-" + ++sequence,
          toolName: name,
          arguments: args,
          cwd: workspaceDir,
        },
        signal: new AbortController().signal,
        boundaries,
        assertCurrent: host.capabilities.assertActive,
        applyMiddleware: (event) => middleware.applyToolResultMiddleware(event),
        onResult: (result) => {
          trace.push(name + ":" + (result.isError ? "failed" : "completed"));
          return {
            isError: result.isError,
            text: result.result.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join("\n"),
          };
        },
        onError: ({ error }) => {
          trace.push(name + ":failed");
          return { isError: true, text: String(error) };
        },
      }),
  };
}

function observeLaunches(trace: string[]) {
  const supervisor = getProcessSupervisor();
  const original = supervisor.spawn.bind(supervisor);
  let launches = 0;
  vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
    trace.push("supervisor:spawn-requested");
    const run = await original(input);
    launches += 1;
    trace.push("supervisor:launched");
    return run;
  });
  return () => launches;
}

describe.each(["cli-loopback", "plugin-harness"] as const)(
  "%s cross-agent final effects",
  (route) => {
    it("executes with target policy despite a persisted requester lockdown, including on resume", async () => {
      const caller = await createCaller(route);
      expect(caller.names).toEqual(expect.arrayContaining(denied));
      const launches = observeLaunches(caller.trace);
      const basename = route + "-allowed.txt";
      const target = path.join(state.workspaceDir, basename);
      const exec = await caller.call("exec", {
        command: "printf command-effect > " + basename + "; printf launched",
        yieldMs: 10_000,
      });
      expect(exec.isError, exec.text).toBe(false);
      expect(exec.text).toContain("launched");
      expect(launches()).toBe(1);
      expect(await fs.readFile(target, "utf8")).toBe("command-effect");
      const write = await caller.call("write", { path: target, content: "write-effect" });
      expect(write.isError, write.text).toBe(false);
      expect(await fs.readFile(target, "utf8")).toBe("write-effect");
      const resumed = await createCaller(route, caller.sessionKey);
      expect(resumed.names).toEqual(expect.arrayContaining(denied));
      const resumedWrite = await resumed.call("write", { path: target, content: "resumed-effect" });
      expect(resumedWrite.isError, resumedWrite.text).toBe(false);
      const read = await resumed.call("read", { path: target });
      expect(read.isError, read.text).toBe(false);
      expect(read.text).toContain("resumed-effect");
      expect(await fs.readFile(target, "utf8")).toBe("resumed-effect");
    });

    it("keeps persisted sender restrictions enforced on the target agent", async () => {
      const caller = await createCaller(route, "", true);
      const launches = observeLaunches(caller.trace);
      const basename = route + "-sender-denied.txt";
      const target = path.join(state.workspaceDir, basename);
      await fs.writeFile(target, "original");
      expect(caller.names).not.toContain("exec");
      expect(caller.names).not.toContain("write");
      for (const [name, args] of [
        ["exec", { command: "printf forbidden > " + basename }],
        ["write", { path: target, content: "forbidden" }],
      ] as const) {
        const receipt = await caller.call(name, args);
        expect(receipt.isError, receipt.text).toBe(true);
      }
      expect(launches()).toBe(0);
      expect(await fs.readFile(target, "utf8")).toBe("original");
    });
  },
);
