import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequireRecord } from "../../test/helpers/record.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import {
  loadExecApprovals,
  type ExecApprovalsFile,
  type ExecApprovalsAgent,
} from "../infra/exec-approvals.js";
import { sendMessage } from "../infra/outbound/message.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";
import { callGatewayTool } from "./tools/gateway.js";

type ToolOptions = Parameters<typeof createExecToolImpl>[0];
const createExecTool = (defaults?: ToolOptions) =>
  createExecToolImpl({ agentId: "main", approvalRunningNoticeMs: 0, ...defaults });
type ExecResult = Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>;

const localSpawn = vi.hoisted(() => vi.fn());

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/nodes-utils.js", () => ({
  listNodes: vi.fn(async () => [
    {
      nodeId: "node-1",
      commands: ["system.run", "system.run.prepare"],
      connected: true,
      platform: "darwin",
    },
  ]),
  resolveNodeIdFromList: vi.fn((nodes: Array<{ nodeId: string }>) => nodes[0]?.nodeId),
}));

// mock-isolation: Approval routing is observed without sending notices to real channels.
vi.mock("../infra/outbound/message.js", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }));

// mock-isolation: Approval-id routing uses synthetic clients without consulting live channel approvals.
vi.mock("../infra/exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: () => null,
  listNativeExecApprovalClientLabels: () => [],
  resolveExecApprovalInitiatingSurfaceStateAsync: async (params: {
    channel?: string | null;
    accountId?: string | null;
  }) => {
    const channel = params.channel ?? undefined;
    return {
      kind: "enabled",
      channel,
      channelLabel:
        channel === "tui" ? "terminal UI" : channel === "webchat" ? "Web UI" : "this platform",
      accountId: params.accountId ?? undefined,
    };
  },
  supportsNativeExecApprovalClient: (channel?: string | null) =>
    !channel || channel === "webchat" || channel === "tui",
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
}));

// mock-isolation: Keep the shared supervisor isolated while routing fixtures capture local spawns.
vi.mock("../process/supervisor/index.js", async () => {
  const { createProcessSupervisor } = await import("../process/supervisor/supervisor.js");
  const { createRunExit } = await import("./bash-tools.exec-runtime.test-support.js");
  const nativeSupervisor = createProcessSupervisor();
  afterAll(() => nativeSupervisor.shutdown());
  const outputs = [
    ["gog-wrapper", '{"events":[]}\n'],
    ["echo cron-ok", "cron-ok\n"],
    ["echo ok", "ok\n"],
  ] as const;
  return {
    getProcessSupervisor: () => ({
      spawn: async (input: SpawnInput) => {
        localSpawn(input);
        const command = "argv" in input ? input.argv.join(" ") : "";
        const inlineOutput = ["delayed-ok", "approval-one", "approval-two", "allow-always"].find(
          (value) => command.includes(value),
        );
        // Let the real POSIX shell handle executable quoting; Windows keeps the routing fixture.
        if (inlineOutput && process.platform !== "win32") {
          return nativeSupervisor.spawn(input);
        }
        const stdout =
          inlineOutput ?? outputs.find(([match]) => command.includes(match))?.[1] ?? "";
        if (stdout) {
          input.onStdout?.(stdout);
        }
        return {
          activity: { resultSettled: true, lastOutputAtMs: Date.now() },
          runId: "mock-approval-run",
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: async () => createRunExit({ durationMs: 0 }),
          cancel: vi.fn(),
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
    }),
  };
});

function buildPreparedSystemRunPayload(rawInvokeParams: unknown) {
  const invoke = requireRecord(rawInvokeParams ?? {}, "prepare invoke");
  return buildSystemRunPreparePayload(requireRecord(invoke.params ?? {}, "prepare params"));
}

type GatewayHandlers = Record<string, (params: unknown) => unknown>;
const requireRecord = createRequireRecord("record", "expected-label");
const requestApproval = "exec.approval.request";
const waitDecision = "exec.approval.waitDecision";
const elevated = { enabled: true, allowed: true, defaultLevel: "ask" } as const;
const agentFollowup = { approvalFollowupMode: "agent" } as const;

function policy(
  defaults?: ExecApprovalsFile["defaults"],
  allowlist?: ExecApprovalsAgent["allowlist"],
): ExecApprovalsFile {
  return { version: 1, defaults, agents: allowlist ? { main: { allowlist } } : {} };
}

function mockGateway(handlers: GatewayHandlers = {}) {
  const calls: string[] = [];
  vi.mocked(callGatewayTool).mockImplementation(async (method, _opts, params) => {
    calls.push(method);
    return handlers[method] ? await handlers[method](params) : { ok: true };
  });
  return calls;
}

function mockApproval(decision: string | null, handlers: GatewayHandlers = {}) {
  return mockGateway({
    [requestApproval]: (params) => ({
      status: "accepted",
      id: requireRecord(params, "request").id,
    }),
    [waitDecision]: () => ({ decision }),
    ...handlers,
  });
}

function mockFollowup(decision: string, handlers: GatewayHandlers = {}) {
  const followup = createDeferredCore<Record<string, unknown>>();
  mockApproval(decision, {
    ...handlers,
    agent: (params) => {
      followup.resolve(requireRecord(params, "agent"));
      return { status: "ok" };
    },
  });
  return followup.promise;
}

function prepareOnly(params: unknown) {
  return requireRecord(params, "node invoke").command === "system.run.prepare"
    ? buildPreparedSystemRunPayload(params)
    : { ok: true };
}

function nodeFixture(stdout = "ok", prepare = buildPreparedSystemRunPayload) {
  const runs: Record<string, unknown>[] = [];
  return {
    runs,
    handle: (params: unknown) => {
      const invoke = requireRecord(params, "node invoke");
      if (invoke.command === "system.run.prepare") {
        return prepare(params);
      }
      if (invoke.command === "system.run") {
        runs.push(requireRecord(invoke.params, "system.run params"));
        return { payload: { success: true, stdout } };
      }
      return { ok: true };
    },
  };
}

function approvalTool(overrides: ToolOptions = {}) {
  return createExecTool({ host: "gateway", ask: "always", ...overrides });
}

const allowlistDefaults = { security: "allowlist", ask: "on-miss", askFallback: "deny" } as const;
const alwaysFullDefaults = { security: "full", ask: "always", askFallback: "full" } as const;
const allowlistTool = (ask: "on-miss" | "off" = "on-miss", overrides: ToolOptions = {}) =>
  createExecTool({ host: "gateway", security: "allowlist", ask, ...overrides });

async function executable(name: string, content = "") {
  const binDir = path.join(tempDir, "bin");
  await fs.mkdir(binDir);
  const file = path.join(binDir, name);
  await fs.writeFile(file, content);
  if (process.platform !== "win32") {
    await fs.chmod(file, 0o755);
  }
  return file;
}

function externalRoute(channel: string) {
  return {
    sessionKey: `agent:main:${channel}:channel:123`,
    elevated,
    messageProvider: channel,
    currentChannelId: "123",
    accountId: "default",
    currentThreadTs: "456",
  };
}

function getResultText(result: { content: Array<{ type?: string; text?: string }> }) {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function expectText(result: Parameters<typeof getResultText>[0], ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(getResultText(result)).toContain(fragment);
  }
}

function expectCompleted(result: ExecResult, text: string) {
  expect(result.details.status).toBe("completed");
  expectText(result, text);
}

function pendingDetails(result: ExecResult) {
  if (result.details.status !== "approval-pending") {
    throw new Error("Expected a pending approval");
  }
  return result.details;
}

function gatewayParams(method: string) {
  return vi
    .mocked(callGatewayTool)
    .mock.calls.filter(([name]) => name === method)
    .map((call) => requireRecord(call[2], `${method} params`));
}

function expectAuthenticatedExecFollowup(record: Record<string, unknown>, sessionKey: string) {
  expect(record).toMatchObject({
    sessionKey,
    message: expect.stringContaining("<<<BEGIN_UNTRUSTED_EXEC_OUTPUT>>>"),
    internalRuntimeHandoffId: expect.any(String),
  });
  expect(record.inputProvenance).toEqual({
    kind: "inter_session",
    sourceSessionKey: sessionKey,
    sourceTool: "exec_approval_followup",
  });
  expect(String(record.idempotencyKey)).toMatch(/^exec-approval-followup:.+:nonce:/);
}

function mockNoRoute(handlers: GatewayHandlers = {}) {
  return mockApproval(null, {
    [requestApproval]: () => ({ id: "approval-id", decision: null }),
    ...handlers,
  });
}

function expectCronDelivery(host: "gateway" | "node") {
  const [request] = gatewayParams(requestApproval);
  expect(request?.suppressDelivery).toBe(host === "node" ? true : undefined);
  expect(request?.deliverToApprovalClientsOnly).toBe(host === "gateway" ? true : undefined);
}

const tempDirs = createTempDirTracker();
let tempDir = "";

beforeAll(async () => {
  // Detached assertions exercise delivery, not cold loading of the recovery graph.
  await import("./bash-tools.exec-approval-followup.js");
});

beforeEach(() => {
  tempDir = tempDirs.make("openclaw-exec-approvals-");
  vi.stubEnv("HOME", tempDir);
  vi.stubEnv("USERPROFILE", tempDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempDir, ".openclaw"));
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.mocked(callGatewayTool).mockReset();
  vi.mocked(sendMessage).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

afterAll(tempDirs.cleanup);

it.each([
  { host: undefined, node: "node-1", route: "node" },
  { host: "node", node: "node-1", route: "node" },
  { host: "gateway", node: "node-1", route: "conflict" },
  { host: "sandbox", node: "node-1", route: "conflict" },
  { host: "auto", node: "node-1", route: "conflict" },
  { host: undefined, node: undefined, route: "gateway" },
] as const)("routes node=$node host=$host through $route", async ({ host, node, route }) => {
  const fixture = nodeFixture("node-ok");
  mockGateway({ "node.invoke": fixture.handle });
  const tool = createExecTool({ security: "full", ask: "off", allowBackground: false });
  const run = () =>
    tool.execute("host-routing", {
      command: "echo ok",
      node,
      host,
      ...(route === "node" ? { workdir: "/Users/vv", background: true } : {}),
    });
  if (route === "conflict") {
    await expect(run()).rejects.toThrow(
      `exec node="node-1" conflicts with host="${host}"; omit host or use host="node" to run on this node.`,
    );
    expect(localSpawn).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  } else {
    const result = await run();
    expect(result.details.status).toBe("completed");
    if (route === "node") {
      expect(result.details).toMatchObject({ nodeId: "node-1" });
      expect(getResultText(result)).toContain("node-ok");
      expect(fixture.runs).toHaveLength(1);
      expect(fixture.runs[0]?.cwd).toBe("/Users/vv");
      expectText(
        result,
        "Warning: continuation options are unavailable for host=node; running synchronously via remote system.run without a process session.",
      );
      expect(localSpawn).not.toHaveBeenCalled();
    } else {
      expect(result.details).not.toHaveProperty("nodeId");
      expect(localSpawn).toHaveBeenCalledOnce();
      expect(gatewayParams("node.invoke")).toEqual([]);
    }
  }
});

it("reuses approval id as the node runId for an explicit agent follow-up", async () => {
  const node = nodeFixture();
  const followup = mockFollowup("allow-once", { "node.invoke": node.handle });
  const route = externalRoute("feishu");
  const tool = approvalTool({ host: "node", ...agentFollowup, ...route });
  const result = await tool.execute("call1", { command: "ls -la" });
  const details = pendingDetails(result);
  const pendingText = getResultText(result);
  expectText(
    result,
    `Reply with: /approve ${details.approvalSlug} allow-once|deny`,
    `full ${details.approvalId}`,
    "Host: node",
    "Node: node-1",
    "CWD: (node default)",
    "Command:\n```sh\n",
    "ls -la",
    "Mode: foreground (interactive approvals available).",
  );
  expect(pendingText).not.toContain("Background mode");
  const agent = await followup;
  const run = requireRecord(node.runs[0], "system.run params");
  expect(run).toMatchObject({ runId: details.approvalId, suppressNotifyOnExit: true });
  expect(Object.hasOwn(run, "cwd")).toBe(false);
  expectAuthenticatedExecFollowup(agent, route.sessionKey);
  expect(agent).toMatchObject({
    deliver: true,
    bestEffortDeliver: true,
    channel: "feishu",
    to: "123",
    accountId: "default",
    threadId: "456",
  });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(String(agent.idempotencyKey)).toContain(details.approvalId);
});

it("keeps ask=always prompts for gateway runs with durable trust", async () => {
  const allowlist: ExecApprovalsAgent["allowlist"] = [
    { pattern: process.execPath, source: "allow-always" },
  ];
  saveExecApprovals(policy(alwaysFullDefaults, allowlist));
  mockGateway({
    [requestApproval]: () => ({ status: "accepted", id: "approval-id" }),
    // Detached work must stay pending instead of racing the next policy fixture.
    [waitDecision]: () => new Promise<never>(() => {}),
  });
  const tool = approvalTool({ security: "full", ...agentFollowup, allowBackground: false });
  const result = await tool.execute("call-gateway-durable", {
    command: `${JSON.stringify(process.execPath)} --version`,
    background: true,
  });
  expect(result.details.status).toBe("approval-pending");
  expect(requireRecord(result.details, "result details").allowedDecisions).toEqual([
    "allow-once",
    "deny",
  ]);
  expect(gatewayParams(requestApproval)).toHaveLength(1);
  expect(getResultText(result)).not.toMatch(/process|background|yieldMs|poll/i);
  expect(gatewayParams(requestApproval)[0]?.warningText).toBeUndefined();
  expectText(result, "Reply with: /approve ", "allow-once|deny", "Allow Always is unavailable");
  expect(getResultText(result)).not.toContain("allow-once|allow-always|deny");
});

it("reuses gateway allow-always approvals for repeated exact commands", async () => {
  saveExecApprovals(policy(allowlistDefaults));
  const calls = mockApproval("allow-always");
  const tool = allowlistTool();
  const command = "echo allow-always";
  const first = await tool.execute("allow-first", { command });
  expectCompleted(first, "allow-always");
  expect(calls).toContain(requestApproval);
  expect(calls).toContain(waitDecision);
  expect(
    loadExecApprovals().agents?.main?.allowlist?.some((entry) => entry.source === "allow-always"),
  ).toBe(true);
  calls.length = 0;
  const second = await tool.execute("allow-next", { command });
  expectCompleted(second, "allow-always");
  expect(calls).not.toContain(requestApproval);
  expect(calls).not.toContain(waitDecision);
});

it("waits inline for native Discord approval and resumes the same session without a second user turn", async () => {
  const decision = createDeferredCore<{ decision: string }>();
  mockApproval("allow-once", {
    [waitDecision]: () => decision.promise,
    agent: () => ({ status: "ok" }),
  });
  const tool = approvalTool(externalRoute("discord"));
  let settled = false;
  const resultPromise = tool.execute("discord", {
    command: "printf delayed-ok",
    workdir: process.cwd(),
  });
  void resultPromise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(gatewayParams("agent")).toHaveLength(0);
  decision.resolve({ decision: "allow-once" });
  const result = await resultPromise;
  expectCompleted(result, "delayed-ok");
  expect(gatewayParams("agent")).toHaveLength(0);
  expect(sendMessage).not.toHaveBeenCalled();
});

it("requires a separate approval for each elevated command after allow-once", async () => {
  mockApproval("allow-once");
  const tool = createExecTool({ ask: "on-miss", security: "allowlist", elevated });
  const first = await tool.execute("seq1", { command: "printf approval-one", elevated: true });
  const second = await tool.execute("seq2", { command: "printf approval-two", elevated: true });
  expectCompleted(first, "approval-one");
  expectCompleted(second, "approval-two");
  const requests = gatewayParams(requestApproval);
  expect(requests.map((request) => request.command)).toEqual([
    "printf approval-one",
    "printf approval-two",
  ]);
  const ids = requests.map((request) => request.id);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
  expect(gatewayParams(waitDecision).map((request) => request.id)).toEqual(ids);
});

it("runs a direct skill wrapper command without prompting when the wrapper is allowlisted", async () => {
  if (process.platform === "win32") {
    return;
  }
  const wrapperPath = await executable("gog-wrapper", "#!/bin/sh\necho '{\"events\":[]}'\n");
  saveExecApprovals(
    policy({ ...allowlistDefaults, ask: "off" }, [{ pattern: await fs.realpath(wrapperPath) }]),
  );
  const calls = mockGateway();
  const tool = allowlistTool("off");
  const result = await tool.execute("wrapper", {
    command: `${JSON.stringify(wrapperPath)} calendar events primary --today --json`,
    workdir: tempDir,
  });
  expectCompleted(result, '{"events":[]}');
  expect(calls).not.toContain(requestApproval);
});

it("waits for approval registration before returning approval-pending", async () => {
  const registration = createDeferredCore<unknown>();
  const calls = mockGateway({
    [requestApproval]: () => registration.promise,
    [waitDecision]: () => ({ decision: "deny" }),
  });
  const tool = allowlistTool("on-miss", agentFollowup);
  let settled = false;
  const executePromise = tool.execute("registration", { command: "echo register" });
  void executePromise.finally(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  registration.resolve({ status: "accepted", id: "approval-id" });
  const result = await executePromise;
  expect(result.details.status).toBe("approval-pending");
  expect(gatewayParams(requestApproval)[0]?.suppressDelivery).toBeUndefined();
  expect(calls[0]).toBe(requestApproval);
  expect(calls).toContain(waitDecision);
});

it("fails fast when approval registration fails", async () => {
  mockGateway({
    [requestApproval]: () => {
      throw new Error("gateway offline");
    },
  });
  const tool = allowlistTool();
  await expect(tool.execute("offline", { command: "echo fail" })).rejects.toThrow(
    "Exec approval registration failed",
  );
});

it("resolves cron no-route approvals inline when askFallback permits trusted automation", async () => {
  saveExecApprovals(policy(alwaysFullDefaults));
  const calls = mockNoRoute();
  const tool = approvalTool({ security: "full", trigger: "cron" });
  const result = await tool.execute("cron", { command: "echo cron-ok" });
  expectCompleted(result, "cron-ok");
  const request = vi
    .mocked(callGatewayTool)
    .mock.calls.find(([method]) => method === requestApproval);
  expect(requireRecord(request?.[3], "request options").expectFinal).toBe(false);
  expectCronDelivery("gateway");
  expect(calls).not.toContain(waitDecision);
});

it("forwards inline cron approval state to node system.run", async () => {
  saveExecApprovals(policy(alwaysFullDefaults));
  const preparedPlan = {
    argv: ["/bin/sh", "-lc", "echo cron-node-ok"],
    cwd: null,
    commandText: "/bin/sh -lc 'echo cron-node-ok'",
    commandPreview: "echo cron-node-ok",
    agentId: null,
    sessionKey: null,
    mutableFileOperand: { argvIndex: 2, path: "/tmp/cron-node-ok.sh", sha256: "deadbeef" },
  };
  const node = nodeFixture("cron-node-ok", () => ({ payload: { plan: preparedPlan } }));
  mockNoRoute({ "node.invoke": node.handle });
  const tool = createExecTool({ host: "node", ask: "always", security: "full", trigger: "cron" });
  const result = await tool.execute("cron-node", { command: "echo cron-node-ok" });
  expectCompleted(result, "cron-node-ok");
  expectCronDelivery("node");
  const params = requireRecord(node.runs[0], "system.run params");
  expect(params.approved).toBeUndefined();
  expect(params.approvalDecision).toBeUndefined();
  expect(params.approvalSource).toBe("ask-fallback");
  expect(params.systemRunPlan).toStrictEqual(preparedPlan);
  expect(params.runId).toBeTypeOf("string");
});

it.each(["gateway", "node"] as const)(
  "denies %s cron no-route approvals when askFallback is deny",
  async (host) => {
    saveExecApprovals(policy({ security: "full", ask: "always", askFallback: "deny" }));
    mockNoRoute(host === "node" ? { "node.invoke": prepareOnly } : {});
    const tool = createExecTool({ host, ask: "always", security: "full", trigger: "cron" });
    await expect(
      tool.execute(`call-cron-${host}-denied`, { command: `echo cron-${host}-denied` }),
    ).rejects.toThrow("Automation runs cannot wait for interactive exec approval");
    expectCronDelivery(host);
    if (host === "node") {
      expect(gatewayParams("node.invoke").some((invoke) => invoke.command === "system.run")).toBe(
        false,
      );
    }
  },
);

describe.each(["gateway", "node"] as const)("inline %s denial", (host) => {
  it.each([
    { decision: "deny", reason: "operator", explanation: "an operator declined" },
    { decision: null, reason: "timeout", explanation: "approval timed out" },
    { decision: undefined, reason: "request failure", explanation: "approval request failed" },
  ] as const)(
    "reports $reason without dispatching the command",
    async ({ decision, explanation }) => {
      saveExecApprovals(policy({ security: "full", ask: "always", askFallback: "deny" }));
      const node = nodeFixture();
      mockApproval(decision ?? null, {
        "node.invoke": node.handle,
        "exec.approval.waitDecision": () => {
          if (decision === undefined) {
            throw new Error("approval transport unavailable");
          }
          return { decision };
        },
      });
      const tool = createExecTool({ host, ask: "always", security: "full" });
      const execution = tool.execute("inline-denial", { command: "echo ok" });
      let text: string;
      if (host === "gateway") {
        const result = await execution;
        expect(result.details).toMatchObject({ status: "failed", exitCode: null, durationMs: 0 });
        text = getResultText(result);
        expect(text).toMatch(/^Exec denied \(gateway id=/);
      } else {
        const error = await execution.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) {
          throw new Error("expected node execution denial");
        }
        text = error.message;
        expect(text).toMatch(/^exec denied:/);
      }
      expect(gatewayParams("exec.approval.request")).toHaveLength(1);
      expect(gatewayParams("exec.approval.waitDecision")).toHaveLength(1);
      expect(localSpawn).not.toHaveBeenCalled();
      expect(node.runs).toHaveLength(0);
      expect(gatewayParams("agent")).toHaveLength(0);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(text).toContain("Command did not run:");
      expect(text).toContain(explanation);
    },
  );
});
