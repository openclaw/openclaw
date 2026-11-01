import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import type { PluginHookBeforeToolCallEvent } from "../plugins/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { copyAgentToolMetadata } from "./agent-tool-metadata.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { resetAdjustedParamsByToolCallIdForTests } from "./agent-tools.before-tool-call.state.js";
import * as nodeHost from "./bash-tools.exec-host-node.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import * as codeModeBridge from "./code-mode-bridge.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  expectCompleted,
  jsonTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import * as gatewayTool from "./tools/gateway.js";

const sandbox = {
  containerName: "test-sandbox",
  workspaceDir: process.cwd(),
  containerWorkdir: "/workspace",
};
const requiredSandbox = { sandboxRequired: true, sandbox };
const approval = { title: "Confirm command", description: "Review host command" };
const deniedCode = 'return await exec({ command: "printf host-denied", host: "node" });';
const harnessDisposers: Array<() => void> = [];
const execCode = (args: object, command = "host-denied") =>
  `return await exec(${JSON.stringify({ command: `printf ${command}`, ...args })});`;
const installHooks = (hooks: Parameters<typeof createMockPluginRegistry>[0]) =>
  initializeGlobalHookRunner(createMockPluginRegistry(hooks));

function installBefore(
  handler: (event: PluginHookBeforeToolCallEvent) => unknown = () => undefined,
) {
  const before = vi.fn(handler);
  installHooks([
    { hookName: "before_tool_call", handler: before as (...args: unknown[]) => unknown },
  ]);
  return before;
}

function createHostHarness(
  options: Omit<Parameters<typeof createSubscribedCodeModeHarness>[0], "name"> & {
    name?: string;
    defaults?: ExecToolDefaults;
    approvalMode?: "report";
  } = {},
) {
  const harness = createSubscribedCodeModeHarness({ name: "host-denial", ...options });
  harnessDisposers.push(harness.dispose);
  const source = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    ...options.defaults,
  });
  const shell = wrapToolWithBeforeToolCallHook(
    source,
    { runId: harness.runId, sessionKey: harness.sessionKey },
    { approvalMode: options.approvalMode },
  );
  const addTools = (...tools: AnyAgentTool[]) =>
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, shell, ...tools] });
  addTools();
  const outer = expectDefined(harness.tools[0], "outer exec");
  const waitTool = expectDefined(harness.tools[1], "wait");
  const spawn = vi.spyOn(getProcessSupervisor(), "spawn");
  const remote = vi.spyOn(nodeHost, "executeNodeHostCommand");
  let nextCall = 0;
  const run = async (code = deniedCode) =>
    resultDetails(await outer.execute(`host-${nextCall++}`, { code }));
  const complete = (details: Record<string, unknown>) => waitUntilCompleted({ details, waitTool });
  return {
    ...harness,
    source,
    waitTool,
    spawn,
    remote,
    addTools,
    complete,
    expectNoStart: () => [spawn, remote].forEach((spy) => expect(spy).not.toHaveBeenCalled()),
    run,
    runToCompletion: async (code = deniedCode) => complete(await run(code)),
  };
}

describe("Code Mode subscribed host denial", () => {
  afterEach(async () => {
    harnessDisposers.splice(0).forEach((dispose) => dispose());
    vi.useRealTimers();
    await resetCodeModeTestState();
    resetGlobalHookRunner();
    resetAdjustedParamsByToolCallIdForTests();
    vi.restoreAllMocks();
  });

  it.each<[string, ExecToolDefaults, object, string]>([
    [
      "node-conflict",
      { host: "gateway" },
      { host: "gateway", node: "node-1" },
      'exec node="node-1" conflicts with host="gateway"',
    ],
    ["gateway", { host: "gateway" }, { host: "node" }, "exec host not allowed"],
    ["auto-sandbox", { host: "auto", sandbox }, { host: "gateway" }, "exec host not allowed"],
    ["required-missing", { sandboxRequired: true }, {}, "sandbox runtime is unavailable"],
    [
      "required-elevation",
      {
        ...requiredSandbox,
        elevated: { enabled: true, allowed: true, defaultLevel: "off" },
      },
      { elevated: true },
      "Elevated execution is unavailable",
    ],
    ["required-outside", requiredSandbox, { host: "gateway" }, "this session requires a sandbox"],
  ])("preserves subscriber no-start for %s", async (policy, defaults, args, error) => {
    const before = installBefore();
    const observeToolTerminal = vi.fn(createToolTerminalObserver(`run-code-mode-host-${policy}`));
    const harness = createHostHarness({ name: `host-${policy}`, defaults, observeToolTerminal });
    const details = await harness.runToCompletion(execCode(args));
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
      error: expect.stringContaining(error),
    });
    expect(before).toHaveBeenCalledOnce();
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "exec", executionStarted: true, outcome: "failure" }),
    );
    expect(observeToolTerminal.mock.results[0]?.value).toMatchObject({
      effectReceipt: { state: "not_started" },
    });
    harness.expectNoStart();
    expect(harness.subscription.getItemLifecycle()).toMatchObject({
      startedCount: 1,
      completedCount: 1,
      activeCount: 0,
    });
  });
  it.each(["repair", "veto", "throw"] as const)(
    "judges final host arguments after one real hook: %s",
    async (change) => {
      const before = installBefore(() => {
        if (change === "throw") {
          throw new Error("hook failed");
        }
        return change === "veto"
          ? { block: true, blockReason: "hook veto" }
          : { params: { command: "printf host-corrected", host: "gateway" } };
      });
      const timeoutMs = 1_500;
      // Exhaust the budget after the command completes, before VM restore.
      const exhaustBudget = () => {
        vi.advanceTimersByTime(timeoutMs);
      };
      const harness = createHostHarness({
        timeoutMs,
        onToolStreamBoundary: change === "repair" ? exhaustBudget : undefined,
      });
      if (change === "repair") {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      }
      const wait = vi.spyOn(harness.waitTool, "execute");
      const details = await harness.runToCompletion(
        change === "repair"
          ? deniedCode
          : 'return await exec({ command: "printf initial", host: "gateway" });',
      );
      expect(before).toHaveBeenCalledOnce();
      expect(harness.remote).not.toHaveBeenCalled();
      expect(harness.spawn).toHaveBeenCalledTimes(change === "repair" ? 1 : 0);
      expect(details.status).toBe(change === "throw" ? "failed" : "completed");
      if (change === "veto") {
        expect(details.value).toMatchObject({ status: "blocked", reason: "hook veto" });
      }
      if (change === "repair") {
        expect(wait).toHaveBeenCalledOnce();
        expect(details.value).toMatchObject({ exitCode: 0, aggregated: "host-corrected" });
      }
    },
  );

  it.each(["allow-always", "deny", "timeout", "cancel", "report"] as const)(
    "preserves approval callbacks and containment for %s",
    async (decision) => {
      const resolutions: string[] = [];
      const before = installBefore(() => ({
        requireApproval: {
          ...approval,
          onResolution: (value: string) => resolutions.push(value),
        },
      }));
      const rpc = vi.spyOn(gatewayTool, "callGatewayTool").mockImplementation(async (method) => {
        if (method === "plugin.approval.request") {
          return { id: "host-approval", status: "accepted" };
        }
        if (decision === "cancel") {
          throw new Error("approval route closed");
        }
        return { id: "host-approval", decision: decision === "timeout" ? null : decision };
      });
      const harness = createHostHarness({
        approvalMode: decision === "report" ? "report" : undefined,
      });
      const details = await harness.runToCompletion();
      expect(details.status).toBe("failed");
      expect(before).toHaveBeenCalledOnce();
      expect(resolutions).toEqual([
        decision === "cancel" || decision === "report" ? "cancelled" : decision,
      ]);
      expect(rpc.mock.calls.map(([method]) => method)).toEqual(
        decision === "report" ? [] : ["plugin.approval.request", "plugin.approval.waitDecision"],
      );
      harness.expectNoStart();
      if (decision === "allow-always") {
        const corrected = await harness.runToCompletion(
          execCode({ host: "gateway" }, "approved-correction"),
        );
        expectCompleted(corrected, { exitCode: 0, aggregated: "approved-correction" });
        expect(before).toHaveBeenCalledTimes(2);
        expect(resolutions).toEqual([decision, decision]);
        expect(rpc).toHaveBeenCalledTimes(4);
        expect(harness.spawn).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps the approved host snapshot frozen against later hook rewrites", async () => {
    const approve = vi.fn(() => ({
      params: { command: "printf approved", host: "node" },
      requireApproval: approval,
    }));
    const rewrite = vi.fn(() => ({ params: { command: "printf changed", host: "gateway" } }));
    installHooks([
      { hookName: "before_tool_call", handler: approve, priority: 1 },
      { hookName: "before_tool_call", handler: rewrite },
    ]);
    vi.spyOn(gatewayTool, "callGatewayTool").mockResolvedValue({
      id: "frozen",
      decision: "allow-once",
    });
    const harness = createHostHarness();
    const details = await harness.runToCompletion();
    expect(details.error).toContain("requested node");
    expect(approve).toHaveBeenCalledOnce();
    expect(rewrite).toHaveBeenCalledOnce();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("does not resurrect cancellation-ignoring work across awaited preparation", async () => {
    const [entered, release, finished] = [createDeferred(), createDeferred(), createDeferred()];
    const pause = async () => {
      entered.resolve();
      await release.promise;
      finished.resolve();
    };
    const harness = createHostHarness();
    installHooks([
      { hookName: "resolve_exec_env", handler: pause },
      {
        hookName: "before_tool_call",
        handler: () => ({ params: { command: "printf no", host: "node" } }),
      },
    ]);
    const after = jsonTool("after_abort", { ran: true });
    harness.addTools(after);
    try {
      const code = deniedCode.replace('host: "node"', 'host: "gateway"');
      const running = harness.run(`${code.replace("return ", "")} await after_abort({});`);
      await entered.promise;
      harness.runAbortController.abort(new Error("cancel host test"));
      const details = await running;
      expect(details).toMatchObject({
        status: "failed",
        error: expect.stringMatching(/abort|cancel/i),
      });
      release.resolve();
      await finished.promise;
      await vi.waitFor(() =>
        expect(harness.subscription.getItemLifecycle()).toEqual({
          startedCount: 1,
          completedCount: 1,
          activeCount: 0,
        }),
      );
      harness.expectNoStart();
      expect(after.execute).not.toHaveBeenCalled();
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      release.resolve();
    }
  });

  it("does not transfer the consumed fact when awaited completion replaces the error", async () => {
    const replacement = new Error("completion observer failed");
    const harness = createHostHarness({
      observeToolTerminal: () => {
        throw replacement;
      },
    });
    const execute = harness.source.execute;
    let producerError: unknown;
    const capture = wrapToolWithBeforeToolCallHook(
      copyAgentToolMetadata(harness.source, {
        ...harness.source,
        execute: (...args: Parameters<typeof execute>) =>
          execute(...args).catch((error: unknown) => {
            producerError = error;
            throw error;
          }),
      }),
      { runId: harness.runId },
    );
    applyCodeModeCatalog({ ...harness, tools: [...harness.tools, capture] });
    const details = await harness.runToCompletion();
    expect(details.error).toContain(replacement.message);
    expect(producerError).toBeInstanceOf(Error);
    expect(consumeTrustedToolNoStartError(producerError)).toBe(false);
    expect(consumeTrustedToolNoStartError(replacement)).toBe(false);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it.each([
    "mutation-first/settles-first",
    "denial-first/settles-last",
    "late-settlement",
  ] as const)("does not replay completed work around a host denial: %s", async (order) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-mode-host-marker-"));
    const marker = path.join(dir, "mutation.txt");
    const [mutated, denied] = [createDeferred(), createDeferred()];
    const [releaseLateMutation, lateMutationFinished] = [createDeferred(), createDeferred()];
    const dispatchOrder: string[] = [];
    const settlementOrder: string[] = [];
    const runBridge = codeModeBridge.runBridgeRequest;
    vi.spyOn(codeModeBridge, "runBridgeRequest").mockImplementation(async (params) => {
      const name = String(params.request.args[0]);
      dispatchOrder.push(name);
      const settled = await runBridge(params);
      settlementOrder.push(name);
      if (name === "record_mutation") {
        mutated.resolve();
      }
      if (name === "exec") {
        denied.resolve();
      }
      return settled;
    });
    const mutationFirstSettlement = order.endsWith("settles-first");
    const parallel = order.includes("/");
    installBefore(async (event) => {
      if (event.toolName === "exec" && parallel && mutationFirstSettlement) {
        await mutated.promise;
      }
    });
    const harness = createHostHarness({
      // The late sibling is released only after this budget forces the cell to park.
      timeoutMs: order === "late-settlement" ? 1_500 : undefined,
    });
    const mutation = pluginToolWithExecute("record_mutation", "Append marker", async () => {
      if (order === "late-settlement") {
        await releaseLateMutation.promise;
      }
      if (parallel && !mutationFirstSettlement) {
        await denied.promise;
      }
      await fs.appendFile(marker, "applied\n");
      lateMutationFinished.resolve();
      return jsonResult({ applied: true });
    });
    harness.addTools(mutation);
    try {
      const deny = deniedCode.replace("return await ", "").replace(/;$/, "");
      const expressions = order.startsWith("denial-first")
        ? [deny, "record_mutation({})"]
        : ["record_mutation({})", deny];
      const code =
        order === "late-settlement"
          ? `await Promise.all([record_mutation({}), ${deny}]);`
          : `const results = await Promise.allSettled([${expressions.join(",")}]); throw new Error(results.find(r => r.status === "rejected").reason.message);`;
      let details = await harness.run(code);
      if (order === "late-settlement") {
        expect(details.status).toBe("waiting");
        await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        releaseLateMutation.resolve();
        await lateMutationFinished.promise;
        details = resultDetails(
          await harness.waitTool.execute("settle-late", {
            runId: details.runId,
          }),
        );
        await vi.waitFor(() => expect(harness.subscription.getItemLifecycle().activeCount).toBe(0));
      }
      details = await harness.complete(details);
      expect(details).toMatchObject({
        status: "failed",
        bridgeDispatchStarted: true,
        error: expect.stringContaining("exec host not allowed"),
      });
      expect(await fs.readFile(marker, "utf8")).toBe("applied\n");
      expect(mutation.execute).toHaveBeenCalledOnce();
      if (parallel) {
        const expectedOrder = order.startsWith("denial-first")
          ? ["exec", "record_mutation"]
          : ["record_mutation", "exec"];
        expect({ dispatchOrder, settlementOrder }).toEqual({
          dispatchOrder: expectedOrder,
          settlementOrder: expectedOrder,
        });
      }
      harness.expectNoStart();
    } finally {
      mutated.resolve();
      denied.resolve();
      releaseLateMutation.resolve();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("reports security denial without starting a shell process", async () => {
    const harness = createHostHarness({ defaults: { security: "deny" } });
    const details = await harness.runToCompletion(execCode({ host: "gateway" }, "no"));
    expect(details.status).toBe("failed");
    harness.expectNoStart();
  });
});
