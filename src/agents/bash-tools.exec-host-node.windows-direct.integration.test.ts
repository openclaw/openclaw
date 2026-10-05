import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { readExecApprovalsSnapshot, saveExecApprovals } from "../infra/exec-approvals.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import { resolveWindowsDirectCommandArgv } from "../infra/windows-direct-command.js";
import { handleInvoke } from "../node-host/invoke.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import type { Deferred } from "../shared/deferred.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeNodeHostCommand } from "./bash-tools.exec-host-node.js";
import type { ExecuteNodeHostCommandParams } from "./bash-tools.exec-host-node.types.js";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: rpc,
  readGatewayCallOptions: vi.fn(() => ({})),
}));
vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: async () => [
    {
      nodeId: "win-node",
      connected: true,
      platform: "win32",
      commands: ["system.run", "system.run.prepare"],
    },
  ],
  resolveNodeIdFromList: () => "win-node",
}));

const ACCENTED_ARGUMENT = "deux mots é";

type CapturedParams = Record<string, unknown> & { command?: unknown; rawCommand?: unknown };

let state: OpenClawTestState;
let request: ExecuteNodeHostCommandParams & { workdir: string };
let prepareParams: CapturedParams[];
let runParams: CapturedParams[];
let approvalRequests: Array<Record<string, unknown>>;
let waitDecisionCount: number;
let resolveDecision: (result: { decision: string }) => void;
let decisionEntered: Deferred;

function decodeChildArgv(output: unknown): unknown {
  return JSON.parse(decodeURIComponent(String(output).trim()));
}

describe.runIf(process.platform === "win32")("Windows node direct argv transport", () => {
  beforeEach(async ({ onTestFinished }) => {
    const previousRegistry = captureActivePluginRegistrySnapshot();
    onTestFinished(() => {
      rollbackStagedPluginRegistry(previousRegistry);
    });
    stageActivePluginRegistry(
      createTestRegistry([
        { pluginId: "a2a", source: "test", plugin: createChannelTestPluginBase({ id: "a2a" }) },
      ]),
      null,
      "default",
    );
    state = await createOpenClawTestState({ label: "node-exec-windows-direct" });
    await state.writeConfig({});
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
    const workdir = await fs.realpath(state.root);
    const script = path.join(workdir, "print-argv.cjs");
    await fs.writeFile(
      script,
      "process.stdout.write(encodeURIComponent(JSON.stringify(process.argv.slice(2))));\n",
    );
    request = {
      command: `"${process.execPath}" "${script}" "${ACCENTED_ARGUMENT}"`,
      workdir,
      env: {},
      sessionKey: "agent:main:windows-direct",
      agentId: "main",
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 1000,
      warnings: [],
      turnSourceChannel: "webchat",
    };
    prepareParams = [];
    runParams = [];
    approvalRequests = [];
    waitDecisionCount = 0;
    const decision = new Promise<{ decision: string }>((resolve) => {
      resolveDecision = resolve;
    });
    decisionEntered = createDeferred();
    rpc.mockReset().mockImplementation(async (method, _options, params) => {
      if (method === "exec.approvals.node.get") {
        return readExecApprovalsSnapshot();
      }
      if (method === "exec.approval.request") {
        approvalRequests.push(params);
        return { id: params.id, expiresAtMs: Date.now() + 60000 };
      }
      if (method === "exec.approval.resolve") {
        return { ok: true };
      }
      if (method === "exec.approval.waitDecision") {
        waitDecisionCount += 1;
        decisionEntered.resolve();
        return await decision;
      }
      if (method !== "node.invoke") {
        throw new Error(`Unexpected RPC: ${method}`);
      }
      if (params.command === "system.run.prepare") {
        prepareParams.push(params.params);
      }
      if (params.command === "system.run") {
        runParams.push(params.params);
      }
      let response:
        | { ok: boolean; payloadJSON?: string; error?: { code?: string; message?: string } }
        | undefined;
      await handleInvoke(
        {
          id: "invoke-1",
          nodeId: "win-node",
          command: params.command,
          paramsJSON: JSON.stringify(params.params),
        },
        {
          async request<T>(name: string, value?: unknown): Promise<T> {
            if (name === "node.invoke.result") {
              response = value as typeof response;
            }
            return {} as T;
          },
        },
        { current: async () => [] },
      );
      if (!response?.ok) {
        throw Object.assign(new Error(response?.error?.message ?? "Node rejected invocation"), {
          details: { nodeError: response?.error },
        });
      }
      return { payload: JSON.parse(response.payloadJSON ?? "{}") };
    });
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("launches a quoted argument with spaces and accents without cmd.exe", async () => {
    const expectedArgv = resolveWindowsDirectCommandArgv(request.command);
    expect(expectedArgv, "node and temp paths must not contain cmd.exe characters").not.toBeNull();

    const result = await executeNodeHostCommand(request);

    expect(prepareParams[0]?.command).toEqual(expectedArgv);
    expect(runParams).toHaveLength(1);
    const executed = runParams[0]?.command as string[];
    expect(executed.slice(1)).toEqual(expectedArgv?.slice(1));
    expect(path.win32.basename(executed[0] ?? "").toLowerCase()).toBe("node.exe");
    expect(result.details).toMatchObject({ status: "completed" });
    expect(decodeChildArgv((result.details as { aggregated?: unknown }).aggregated)).toEqual([
      ACCENTED_ARGUMENT,
    ]);
  });

  it("binds the approval card, the approval, and the executed argv to the same argv", async () => {
    setRuntimeConfigSnapshot({ tools: { exec: { security: "allowlist", ask: "on-miss" } } });
    saveExecApprovals({ version: 1, defaults: { security: "allowlist", ask: "on-miss" } });

    const execution = executeNodeHostCommand({ ...request, security: "allowlist", ask: "on-miss" });
    await Promise.race([decisionEntered.promise, execution]);
    expect(runParams).toHaveLength(0);
    const plan = approvalRequests[0]?.systemRunPlan as { argv: string[]; commandText: string };
    expect(plan.argv.slice(1)).toEqual(resolveWindowsDirectCommandArgv(request.command)?.slice(1));
    expect(plan.commandText).toBe(formatExecCommand(plan.argv));
    expect(approvalRequests[0]?.unavailableDecisions).toContain("allow-always");
    resolveDecision({ decision: "allow-once" });
    const result = await execution;

    expect(runParams[0]?.command).toEqual(plan.argv);
    expect(runParams[0]?.rawCommand).toBe(plan.commandText);
    expect(decodeChildArgv((result.details as { aggregated?: unknown }).aggregated)).toEqual([
      ACCENTED_ARGUMENT,
    ]);
  });

  it("offers allow-always for an ordinary executable and reuses it without a new approval", async () => {
    setRuntimeConfigSnapshot({ tools: { exec: { security: "allowlist", ask: "on-miss" } } });
    saveExecApprovals({ version: 1, defaults: { security: "allowlist", ask: "on-miss" } });
    const where = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
    const allowlisted = {
      ...request,
      command: `"${where}" "${ACCENTED_ARGUMENT}"`,
      security: "allowlist" as const,
      ask: "on-miss" as const,
    };

    const first = executeNodeHostCommand(allowlisted);
    await Promise.race([decisionEntered.promise, first]);
    const plan = approvalRequests[0]?.systemRunPlan as { argv: string[]; commandText: string };
    expect(plan.argv.slice(1)).toEqual([ACCENTED_ARGUMENT]);
    expect(approvalRequests[0]?.unavailableDecisions ?? []).not.toContain("allow-always");
    resolveDecision({ decision: "allow-always" });
    await first;
    expect(runParams[0]?.command).toEqual(plan.argv);

    await executeNodeHostCommand(allowlisted);

    expect(waitDecisionCount).toBe(1);
    expect(approvalRequests).toHaveLength(1);
    expect(runParams).toHaveLength(2);
    expect(runParams[1]?.command).toEqual(plan.argv);
  });

  it("keeps a command that needs cmd.exe on the unchanged envelope", async () => {
    const result = await executeNodeHostCommand({ ...request, command: "echo cmd-envelope-proof" });

    expect(prepareParams[0]?.command).toEqual([
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "echo cmd-envelope-proof",
    ]);
    expect(prepareParams[0]?.rawCommand).toBe("echo cmd-envelope-proof");
    expect(String((result.details as { aggregated?: unknown }).aggregated).trim()).toBe(
      "cmd-envelope-proof",
    );
  });
});
