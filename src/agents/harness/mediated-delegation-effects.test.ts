// Real CLI loopback and generic plugin-harness effects; no native CLI/model credentials.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { readResolvedSessionEntryInWorker } from "../../config/sessions/session-accessor.entry.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { revokeMcpLoopbackClientGrant } from "../../gateway/mcp-grant-store.js";
import {
  captureGrant,
  request as requestMcp,
} from "../../gateway/mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../../gateway/mcp-http.js";
import {
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
import * as shellSnapshot from "../shell-snapshot.js";
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
          subagents: { allowAgents: ["coder"], delegateToolsTo: ["coder"] },
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
  await ensureMcpLoopbackServer();
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

function revoke() {
  const next = structuredClone(config);
  next.agents!.entries!.intake!.subagents!.delegateToolsTo = [];
  setRuntimeConfigSnapshot(next);
  return next;
}

async function createCaller(
  route: Route,
  currentConfig = config,
  existingSessionKey = "",
  senderRestricted = false,
) {
  const runId = "mediated-" + ++sequence;
  const sessionKey = existingSessionKey || "agent:coder:dashboard:" + runId;
  const scope = { cfg: currentConfig, agentId: "coder", sessionKey };
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
      delegatedToolPolicy: {
        requesterSessionKey: requester,
        targetAgentId: "coder",
        deny: [],
        requesterDeny: denied,
      },
    });
    sessionEntry = await readResolvedSessionEntryInWorker(scope);
  }
  const admission = prepareSystemAgentRunAdmission(
    currentConfig,
    runId,
    "coder",
    "mediated-effect-test",
  );
  cleanups.push(admission.close);
  const admittedRunContext = await admission.admit(
    route === "cli-loopback" ? "embedded" : "plugin-harness",
  );
  const workspaceDir = state.workspaceDir;
  const attempt = {
    config: currentConfig,
    runId,
    agentId: "coder",
    sessionId: sessionEntry!.sessionId,
    sessionKey,
    workspaceDir,
    cwd: workspaceDir,
    admittedRunContext,
  };
  if (route === "cli-loopback") {
    const run: RunCliAgentParams = {
      ...attempt,
      sessionEntry,
      sessionFile: state.path(runId + ".jsonl"),
      provider: "fixture-cli",
      model: "fixture",
      prompt: "exercise mediated effects",
      timeoutMs: 10_000,
    };
    const policy = await resolveCliRuntimeToolPolicy({
      params: run,
      policySessionKey: sessionKey,
      policyAgentId: "coder",
      backendId: "fixture-cli",
      bundleMcp: true,
      canEnforceExactToolAvailability: true,
      isSideQuestion: false,
      skipsTurnPreparation: false,
    });
    const context = buildCliMcpGrantContext({
      run: policy.params,
      config: currentConfig,
      requireExplicitMessageTarget: false,
      agentId: "coder",
      modelProvider: "fixture",
      modelId: "fixture",
    });
    context.toolsAllow = policy.runtimeToolsAllowPolicy ?? ["read", "write", "exec"];
    const projected = await resolveMcpLoopbackPolicyTools({
      cfg: currentConfig,
      context,
      admittedRunContext,
    });
    const names = projected.tools.map((tool) => tool.name);
    const grantInput = finalizeCliMcpGrant(context, names, false, run)!;
    const runtime = getActiveMcpLoopbackRuntime()!;
    const captureKey = runId + "-capture";
    const grant = captureGrant(
      { ...grantInput, runtimeOwnerToken: runtime.ownerToken },
      captureKey,
      (token) =>
        cleanups.push(() => {
          clearMcpLoopbackToolCallCapture(captureKey);
          revokeMcpLoopbackClientGrant(token);
        }),
    );
    const request = async (method: string, params?: object) => {
      const response = await requestMcp(
        runtime,
        {
          jsonrpc: "2.0",
          id: ++sequence,
          method,
          ...(params ? { params } : {}),
        },
        grant,
      );
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
      call: async (name: string, args: Record<string, unknown>): Promise<Receipt> => {
        const reply = await request("tools/call", { name, arguments: args });
        return {
          isError: reply.result.isError === true,
          text: (reply.result.content ?? []).map((block) => block.text ?? "").join("\n"),
        };
      },
    };
  }
  const host = createAgentHarnessHostCapabilities({
    pluginId: "fixture-mediated-harness",
    attempt,
  });
  cleanups.push(host.close);
  const tools = await host.capabilities.createToolSurfaceAsync!({
    ...attempt,
    includeToolSearchControls: false,
  });
  const boundaries = createAgentHarnessToolExecutionBoundaryRegistry();
  const middleware = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, []);
  return {
    sessionKey,
    names: tools.map((tool) => tool.name),
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
        onResult: (result) => ({
          isError: result.isError,
          text: result.result.content
            .map((block) => (block.type === "text" ? block.text : ""))
            .join("\n"),
        }),
        onError: ({ error }) => ({ isError: true, text: String(error) }),
      }),
  };
}

function observeLaunches() {
  const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
  return () => spawn.mock.calls.length;
}

async function prepareEffect(route: Route, suffix: string, senderRestricted = false) {
  const caller = await createCaller(route, config, "", senderRestricted);
  const basename = route + suffix;
  const target = path.join(state.workspaceDir, basename);
  await fs.writeFile(target, "original");
  return { caller, basename, target };
}
async function expectRejected(receipt: Receipt, target: string) {
  expect(receipt.isError, receipt.text).toBe(true);
  expect(receipt.text).toMatch(/authorization changed|authority is no longer active/);
  expect(await fs.readFile(target, "utf8")).toBe("original");
}
async function revokeAtGate(
  entered: Promise<void>,
  running: Promise<Receipt>,
  signal: AbortSignal,
  message: string,
  release: () => void,
) {
  try {
    await withinTest(awaitGateBeforeSettlement(entered, running, message), signal);
    revoke();
  } finally {
    release();
  }
}

// Promise gates delay real preparation/I/O only. All authority, tool construction,
// approval policy, command launch, mutation, and caller receipts remain production-owned.
describe.each(["cli-loopback", "plugin-harness"] as const)(
  "%s delegated final effects",
  (route) => {
    it("executes the persisted exception, then restores the deny fallback on resume", async () => {
      const caller = await createCaller(route);
      expect(caller.names).toEqual(expect.arrayContaining(denied));
      const launches = observeLaunches();
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
      const resumed = await createCaller(route, revoke(), caller.sessionKey);
      expect(resumed.names).not.toContain("exec");
      expect(resumed.names).not.toContain("write");
      const refused = await resumed.call("write", { path: target, content: "must-not-write" });
      expect(refused.isError).toBe(true);
      const read = await resumed.call("read", { path: target });
      expect(read.isError, read.text).toBe(false);
      expect(read.text).toContain("write-effect");
      expect(await fs.readFile(target, "utf8")).toBe("write-effect");
    });

    it("does not waive sender restrictions even with a persisted delegation exception", async () => {
      const { caller, basename, target } = await prepareEffect(route, "-sender-denied.txt", true);
      const launches = observeLaunches();
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

    it.for(["exec", "write"] as const)(
      "rejects revocation at the final %s boundary",
      async (tool, { signal }) => {
        const { caller, basename, target } = await prepareEffect(route, `-revoked-${tool}.txt`);
        const launches = tool === "exec" ? observeLaunches() : undefined;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const pause = async () => {
          entered.resolve();
          await release.promise;
        };
        if (tool === "exec") {
          const original = shellSnapshot.maybeWrapCommandWithShellSnapshot;
          vi.spyOn(shellSnapshot, "maybeWrapCommandWithShellSnapshot").mockImplementation(
            async (...args) => {
              await pause();
              return original(...args);
            },
          );
        } else {
          const originalOpen = fs.open;
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (args[0] === target && args[1] === "r+") {
              await pause();
            }
            return handle;
          });
        }
        const args =
          tool === "exec"
            ? { command: "printf forbidden > " + basename, yieldMs: 10_000 }
            : { path: target, content: "forbidden" };
        const running = caller.call(tool, args);
        await revokeAtGate(
          entered.promise,
          running,
          signal,
          "tool did not reach its final boundary",
          release.resolve,
        );
        await expectRejected(await running, target);
        if (launches) {
          expect(launches()).toBe(0);
        }
      },
    );
  },
);
