import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import type { ExecAutoReviewer, ExecAutoReviewTranscript } from "../infra/exec-auto-review.js";
import * as logger from "../logger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { callGatewayTool } from "./tools/gateway.js";

type ToolOptions = Parameters<typeof createExecToolImpl>[0];
const createExecTool = (defaults?: ToolOptions) =>
  createExecToolImpl({ agentId: "main", ...defaults });
const elevated = { enabled: true, allowed: true, defaultLevel: "full" } as const;
const approvalCalls = ["exec.approval.request", "exec.approval.waitDecision"];
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content[0]?.text;
const makeReviewer = (decision: Awaited<ReturnType<ExecAutoReviewer>>) =>
  vi.fn<ExecAutoReviewer>(async () => decision);
const transcript = (message: string): ExecAutoReviewTranscript => ({
  entries: [{ kind: "user", origin: "operator", text: message }],
  omittedEntries: 0,
  truncated: false,
});
const run = (options: ToolOptions, command: string, args = {}) =>
  createExecTool(options).execute("security-floor", { command, ...args });
const expectOutput = (
  result: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>,
  output: string,
  details: object = { status: "completed" },
) => {
  expect(result.details).toMatchObject(details);
  expect(text(result)).toContain(output);
};

const optionalRuntimeImports = vi.hoisted(() => ({ reviewer: 0, followup: 0 }));
const reviewerRuntime = vi.hoisted(() => ({
  prepare:
    vi.fn<typeof import("./simple-completion-runtime.js").acquireSimpleCompletionModelForAgent>(),
  complete:
    vi.fn<
      typeof import("./simple-completion-runtime.js").completeWithPreparedSimpleCompletionModel
    >(),
}));

vi.mock("./simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: reviewerRuntime.prepare,
  completeWithPreparedSimpleCompletionModel: reviewerRuntime.complete,
}));

vi.mock("./exec-auto-reviewer.js", async (importOriginal) => {
  optionalRuntimeImports.reviewer += 1;
  return importOriginal<typeof import("./exec-auto-reviewer.js")>();
});

vi.mock("./bash-tools.exec-approval-followup.js", async (importOriginal) => {
  optionalRuntimeImports.followup += 1;
  return importOriginal<typeof import("./bash-tools.exec-approval-followup.js")>();
});

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

function installAllowlistedGogFixture(root: string): string {
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const gogPath = path.join(binDir, "gog");
  fs.writeFileSync(gogPath, "#!/bin/sh\nprintf 'gog-ok %s\\n' \"$*\"\n", { mode: 0o755 });
  saveExecApprovals({
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "allowlist" },
    agents: { "*": { allowlist: [{ pattern: gogPath }] } },
  });
  return binDir;
}

function writePolicy(security: "deny" | "full", ask: "off" | "always" = "off") {
  saveExecApprovals({ version: 1, defaults: { security, ask }, agents: {} });
}

function mockApprovalGateway(decision: "allow-once" | "deny" | null = null): string[] {
  const calls: string[] = [];
  vi.mocked(callGatewayTool).mockImplementation(async (method) => {
    calls.push(method);
    if (method === "exec.approval.request") {
      return { status: "accepted", id: "approval-id" };
    }
    if (method === "exec.approval.waitDecision") {
      return { decision };
    }
    return { ok: true };
  });
  return calls;
}

function createAutoTool(defaults?: ToolOptions) {
  return createExecTool({ host: "gateway", mode: "auto", safeBins: [], ...defaults });
}
const runAuto = (options: ToolOptions, command: string, args = {}) =>
  createAutoTool(options).execute("auto-review", { command, ...args });

let envSnapshot: ReturnType<typeof captureEnv>;
let tempRoot: string;

beforeEach(() => {
  envSnapshot = captureEnv([
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "SHELL",
  ]);
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-security-floor-"));
  setTestEnvValue("HOME", tempRoot);
  setTestEnvValue("USERPROFILE", tempRoot);
  setTestEnvValue("OPENCLAW_HOME", tempRoot);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  if (process.platform === "win32") {
    const parsed = path.parse(tempRoot);
    setTestEnvValue("HOMEDRIVE", parsed.root.slice(0, 2));
    setTestEnvValue("HOMEPATH", tempRoot.slice(2) || "\\");
  } else {
    deleteTestEnvValue("HOMEDRIVE");
    deleteTestEnvValue("HOMEPATH");
  }
  resetProcessRegistryForTests();
  vi.mocked(callGatewayTool).mockReset();
  reviewerRuntime.prepare.mockReset();
  reviewerRuntime.complete.mockReset();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  envSnapshot.restore();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

it("does not load optional review or delivery runtimes for full/off execution", async () => {
  const result = await run({ host: "gateway", mode: "full" }, "echo hello");
  expect(result.details.status).toBe("completed");
  expect(optionalRuntimeImports).toEqual({ reviewer: 0, followup: 0 });
});

it("records elevated execution without logging the command payload", async () => {
  const logInfo = vi.spyOn(logger, "logInfo").mockImplementation(() => {});
  try {
    const result = await run(
      { host: "gateway", mode: "full", elevated },
      "echo private-elevated-payload",
      { elevated: true },
    );
    expectOutput(result, "private-elevated-payload");
    expect(logInfo).toHaveBeenCalledWith("exec: elevated command");
    expect(JSON.stringify(logInfo.mock.calls)).not.toContain("private-elevated-payload");
  } finally {
    logInfo.mockRestore();
  }
});

it.each([false, true])("honors ask overrides only for trusted callers (%s)", async (trusted) => {
  const calls = trusted ? mockApprovalGateway("deny") : [];
  const tool = createExecTool({
    host: "gateway",
    security: "allowlist",
    ask: "off",
    safeBins: [],
    pathPrepend: [installAllowlistedGogFixture(tempRoot)],
    ...(trusted
      ? {}
      : {
          messageProvider: "telegram",
          currentChannelId: "telegram:12345",
          accountId: "default",
        }),
  });
  const result = await tool.execute("ask-override", {
    command: "gog tasks add tasklist --title test",
    ask: "always",
  });
  if (trusted) {
    expect(calls).toEqual(approvalCalls);
    expectOutput(result, "user-denied", { status: "failed", timedOut: false });
  } else {
    expectOutput(result, "gog-ok tasks add tasklist --title test");
    expect(callGatewayTool).not.toHaveBeenCalled();
  }
});

it("ignores model-supplied full security when configured security is deny", async () => {
  await expect(
    run({ security: "deny", ask: "off" }, "echo hello", { security: "full", ask: "off" }),
  ).rejects.toThrow(/exec denied/i);
});

it.each([undefined, "deny"] as const)(
  "uses sandbox mode=%s independently of gateway approval defaults",
  async (mode) => {
    writePolicy("deny");
    const buildExecSpec = vi.fn(async () => ({
      argv: ["/bin/sh", "-lc", "printf sandbox-ok"],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const tool = createExecTool({
      host: "auto",
      mode,
      sandbox: {
        containerName: "sandbox-policy-test",
        workspaceDir: tempRoot,
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    });
    const execution = tool.execute("sandbox-policy", { command: "echo sandbox-ok" });
    if (mode === "deny") {
      await expect(execution).rejects.toThrow(/security=deny|exec denied/i);
      expect(buildExecSpec).not.toHaveBeenCalled();
    } else {
      const result = await execution;
      expect(buildExecSpec).toHaveBeenCalledOnce();
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("sandbox-ok"),
      });
    }
  },
);

it("intersects normalized gateway auto mode with host approval deny defaults", async () => {
  writePolicy("deny");
  const autoReviewer = makeReviewer({
    decision: "allow-once",
    risk: "low",
    rationale: "would otherwise run",
  });
  await expect(runAuto({ autoReviewer }, "echo blocked")).rejects.toThrow(
    /security=deny|exec denied/i,
  );
  expect(autoReviewer).not.toHaveBeenCalled();
});

it("reviews current conversation context and retains Guardian approval without a run ID", async () => {
  const reviewTranscript = vi.fn(() => currentTranscript);
  const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
    decision: "allow-once",
    risk: "low",
    rationale: "read-only version check",
    userAuthorization: "high",
  }));
  const tool = createAutoTool({
    autoReviewer,
    reviewTranscript,
    sessionKey: "agent:main:main",
  });
  expect(reviewTranscript).not.toHaveBeenCalled();
  const currentTranscript = transcript("Check the Node version.");
  const liveReviews: unknown[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (event.data.phase === "review") {
      liveReviews.push(event.data);
    }
  });
  const result = await tool
    .execute("call-guardian-review", { command: "node --version" })
    .finally(unsubscribe);
  expect(liveReviews).toEqual([]);
  expect(reviewTranscript).toHaveBeenCalledTimes(1);
  expect(autoReviewer).toHaveBeenCalledWith(
    expect.objectContaining({ host: "gateway", transcript: currentTranscript }),
  );
  expect(reviewerRuntime.prepare).not.toHaveBeenCalled();
  expect(result.content).toContainEqual(
    expect.objectContaining({ text: expect.stringContaining("risk=low, authorization=high") }),
  );
  expect(result.details).toMatchObject({
    status: "completed",
    approvalReviewOutcome: "approved",
    approvalReviews: [
      {
        id: "guardian:call-guardian-review",
        label: "Guardian",
        status: "approved",
        riskLevel: "low",
        rationale: "read-only version check",
      },
    ],
  });
});

it("defers to human approval when the default reviewer import fails", async () => {
  const loadReviewer = vi.fn(() => {
    throw new Error("synthetic reviewer import failure");
  });
  vi.doMock("./exec-auto-reviewer.js", loadReviewer);
  vi.mocked(callGatewayTool).mockResolvedValue({ decision: "deny" });
  try {
    const tool = createAutoTool({
      messageProvider: "webchat",
    });
    const result = await tool.execute("default-review-import-failure", {
      command: "node --version",
    });
    expect(loadReviewer).toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "failed",
      approvalReviewOutcome: "denied",
      approvalReviews: [
        { riskLevel: "unknown", rationale: expect.stringContaining("exec reviewer failed:") },
      ],
    });
    expect(reviewerRuntime.prepare).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("./exec-auto-reviewer.js");
  }
});

it.each(process.platform === "win32" ? [true] : [false, true])(
  "retains Guardian evidence and revalidates reviewed scripts (drift=%s)",
  async (mutate) => {
    const command = "sh script.sh; ls *.sh";
    const script = path.join(tempRoot, "script.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho approved\n");
    const autoReviewer = makeReviewer({
      decision: "allow-once",
      risk: "low",
      rationale: "approved script",
    });
    const tool = createAutoTool({
      autoReviewer,
      runId: "run-guardian-script",
      cwd: tempRoot,
    });
    let changedAfterApproval = false;
    const unsubscribe = onAgentEvent((event) => {
      if (
        mutate &&
        event.runId === "run-guardian-script" &&
        event.data.approvalReviewOutcome === "approved"
      ) {
        fs.writeFileSync(script, "#!/bin/sh\necho mutated\n");
        changedAfterApproval = true;
      }
    });
    const result = await tool.execute("tool-guardian-script", { command }).finally(unsubscribe);
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({ command, reason: "execution-plan-miss" }),
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(changedAfterApproval).toBe(mutate);
    const output = mutate ? "approval script operand changed before execution" : "approved";
    expect(text(result)).toContain(output);
    expect(result.details).toMatchObject({
      status: mutate ? "failed" : "completed",
      ...(!mutate ? { exitCode: 0 } : {}),
      approvalReviewOutcome: "approved",
      approvalReviews: [
        { id: "guardian:tool-guardian-script", label: "Guardian", status: "approved" },
      ],
      aggregated: mutate ? expect.stringContaining(output) : "approved\nscript.sh",
    });
  },
);

it("uses agent-scoped host policy when clamping normalized modes", async () => {
  saveExecApprovals({
    version: 1,
    defaults: { security: "deny", ask: "off" },
    agents: { main: { security: "full", ask: "off" } },
  });
  const result = await run({ host: "gateway", mode: "full", agentId: "main" }, "echo agent-ok");
  expect(result.content[0]?.type).toBe("text");
  expect((text(result) ?? "").trim()).toContain("agent-ok");
});

it.each([
  ["elevated", { security: "full", ask: "off", elevated }],
  ["session", { mode: "full", bypassHostApprovalFloors: true }],
  ["tightened", { security: "full", ask: "always", bypassHostApprovalFloors: true }],
] as const)("applies host approval floors to %s full execution", async (kind, options) => {
  writePolicy(kind === "tightened" ? "deny" : "full", kind === "tightened" ? "off" : "always");
  const calls = mockApprovalGateway(kind === "tightened" ? "allow-once" : null);
  const result = await run(
    { host: "gateway", approvalRunningNoticeMs: 0, ...options },
    "echo session-full-ok",
    kind === "elevated" ? { elevated: true } : {},
  );
  if (kind === "elevated") {
    expectOutput(result, "approval-timeout", { status: "failed", timedOut: true });
  } else {
    expectOutput(result, "session-full-ok");
    if (kind === "tightened") {
      expect(result.details).toMatchObject({ exitCode: 0 });
    }
  }
  expect(calls).toEqual(kind === "session" ? [] : approvalCalls);
});

it("honors normalized auto mode before elevated full bypass", async () => {
  const calls = mockApprovalGateway();
  const autoReviewer = makeReviewer({
    decision: "ask",
    risk: "high",
    rationale: "test reviewer asks for approval",
  });
  const result = await runAuto({ autoReviewer, elevated }, "whoami", { elevated: true });
  expect(autoReviewer).toHaveBeenCalledWith(
    expect.objectContaining({
      command: expect.stringMatching(/(?:^|[/\\])whoami(?:\.exe)?$/u),
      host: "gateway",
      reason: "allowlist-miss",
    }),
  );
  expectOutput(result, "approval-timeout", { status: "failed", timedOut: true });
  expect(calls).toEqual(approvalCalls);
});

it("keeps default reviewer settings, conversation and cancellation scoped to each execution", async () => {
  let userRequest = "Check the Node version before building.";
  const reviewTranscript = vi.fn(() => transcript(userRequest));
  const reviewer = { model: "synthetic/reviewer-first" };
  const config: OpenClawConfig = {
    tools: { exec: { reviewer: { model: "synthetic/reviewer-global" } } },
    agents: { entries: { main: { tools: { exec: { reviewer } } } } },
  };
  reviewerRuntime.prepare.mockResolvedValue({
    selection: { provider: "synthetic", modelId: "reviewer", agentDir: tempRoot },
    model: makeProviderModelFixture({
      provider: "synthetic",
      id: "reviewer",
      api: "openai-responses",
      baseUrl: "https://example.invalid",
    }),
    auth: { source: "synthetic", mode: "aws-sdk" },
    [Symbol.asyncDispose]: async () => {},
  });
  const completion = createDeferred<never>();
  const completionEntered = createDeferred();
  reviewerRuntime.complete
    .mockImplementationOnce(() => {
      completionEntered.resolve();
      return completion.promise;
    })
    .mockRejectedValueOnce(new Error("synthetic completion unavailable"));
  vi.mocked(callGatewayTool).mockResolvedValue({ decision: "deny" });
  const tool = createAutoTool({
    config,
    reviewTranscript,
    messageProvider: "webchat",
  });
  expect(reviewTranscript).not.toHaveBeenCalled();
  const first = new AbortController();
  const second = new AbortController();
  const firstRun = tool.execute("first", { command: "node --version" }, first.signal);
  try {
    await Promise.race([completionEntered.promise, firstRun]);
    first.abort(new Error("first execution cancelled"));
    await expect(firstRun).rejects.toThrow("first execution cancelled");
    expect(reviewerRuntime.complete.mock.calls[0]?.[0].options?.signal?.aborted).toBe(true);
    expect(reviewerRuntime.complete.mock.calls[0]?.[0].context.messages[0]?.content).toContain(
      userRequest,
    );
    userRequest = "Check the Node version after building.";
    reviewer.model = "synthetic/reviewer-second";
    const result = await tool.execute("second", { command: "node --version" }, second.signal);
    expect(reviewerRuntime.prepare.mock.calls.map(([params]) => params.modelRef)).toEqual([
      "synthetic/reviewer-first",
      "synthetic/reviewer-second",
    ]);
    expect(reviewerRuntime.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({ cfg: config, agentId: "main" }),
    );
    expect(reviewerRuntime.complete.mock.calls[1]?.[0].options?.signal?.aborted).toBe(false);
    expect(reviewerRuntime.complete.mock.calls[1]?.[0].context.messages[0]?.content).toContain(
      userRequest,
    );
    expect(reviewTranscript).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      status: "failed",
      approvalReviewOutcome: "denied",
      approvalReviews: [{ rationale: "exec reviewer failed: synthetic completion unavailable" }],
    });
  } finally {
    first.abort();
    completion.reject(new Error("review fixture closed"));
    await firstRun.catch(() => undefined);
  }
});
