import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { saveExecApprovals, type ExecApprovalsFile } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer, ExecAutoReviewTranscript } from "../infra/exec-auto-review.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool as createExecToolImpl } from "./bash-tools.exec-run.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import { callGatewayTool } from "./tools/gateway.js";

const createExecTool = (
  defaults?: Parameters<typeof createExecToolImpl>[0],
): ReturnType<typeof createExecToolImpl> => createExecToolImpl({ agentId: "main", ...defaults });

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
  writeExecApprovalsFixture({
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "allowlist" },
    agents: { "*": { allowlist: [{ pattern: gogPath }] } },
  });
  return binDir;
}

function writeExecApprovalsFixture(file: ExecApprovalsFile): void {
  saveExecApprovals(file);
}

function writeDenyExecApprovalsFixture(): void {
  writeExecApprovalsFixture({
    version: 1,
    defaults: { security: "deny", ask: "off" },
    agents: {},
  });
}

function writeFullAskExecApprovalsFixture(): void {
  writeExecApprovalsFixture({
    version: 1,
    defaults: { security: "full", ask: "always" },
    agents: {},
  });
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

function createAskingAutoReviewer() {
  return vi.fn<ExecAutoReviewer>(async () => ({
    decision: "ask",
    risk: "high",
    rationale: "test reviewer asks for approval",
  }));
}

function createAutoTool(defaults?: Parameters<typeof createExecToolImpl>[0]) {
  return createExecTool({ host: "gateway", mode: "auto", safeBins: [], ...defaults });
}

describe("exec security floor", () => {
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
    const dir = tempRoot;
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("does not load optional review or delivery runtimes for full/off execution", async () => {
    const tool = createExecTool({ host: "gateway", mode: "full" });

    const result = await tool.execute("call-unused-optional-runtimes", { command: "echo hello" });

    expect(result.details.status).toBe("completed");
    expect(optionalRuntimeImports).toEqual({ reviewer: 0, followup: 0 });
  });

  it("ignores model-supplied ask overrides when configured ask is off", async () => {
    const root = tempRoot;
    const binDir = installAllowlistedGogFixture(root);
    const tool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      pathPrepend: [binDir],
      messageProvider: "telegram",
      currentChannelId: "telegram:12345",
      accountId: "default",
    });

    const result = await tool.execute("call-model-ask-ignored", {
      command: "gog tasks add tasklist --title test",
      ask: "always",
    });

    expect(result.details.status).toBe("completed");
    expect((result.content[0] as { text?: string }).text ?? "").toContain(
      "gog-ok tasks add tasklist --title test",
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("does not collect conversation context for allowlisted auto-mode commands", async () => {
    const binDir = installAllowlistedGogFixture(tempRoot);
    const autoReviewer = createAskingAutoReviewer();
    const reviewTranscript = vi.fn<() => ExecAutoReviewTranscript | undefined>();
    const tool = createAutoTool({
      pathPrepend: [binDir],
      autoReviewer,
      reviewTranscript,
    });

    const result = await tool.execute("call-allowlisted-context", { command: "gog version" });

    expect(result.details.status).toBe("completed");
    expect((result.content[0] as { text?: string }).text).toContain("gog-ok version");
    expect(autoReviewer).not.toHaveBeenCalled();
    expect(reviewTranscript).not.toHaveBeenCalled();
  });

  it("honors per-call ask hardening for trusted callers without messageProvider", async () => {
    const root = tempRoot;
    const binDir = installAllowlistedGogFixture(root);
    const calls = mockApprovalGateway("deny");
    const tool = createExecTool({
      host: "gateway",
      security: "allowlist",
      ask: "off",
      safeBins: [],
      pathPrepend: [binDir],
    });

    const result = await tool.execute("call-trusted-ask-always", {
      command: "gog tasks add tasklist --title test",
      ask: "always",
    });

    expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
    expect(result.details).toMatchObject({ status: "failed", timedOut: false });
    expect((result.content[0] as { text?: string }).text).toContain("user-denied");
  });

  it("ignores model-supplied full security when configured security is deny", async () => {
    const tool = createExecTool({
      security: "deny",
      ask: "off",
    });

    const modelArgs = {
      command: "echo hello",
      security: "full",
      ask: "off",
    };
    await expect(tool.execute("call-4", modelArgs)).rejects.toThrow(/exec denied/i);
  });

  it.each([undefined, "deny"] as const)(
    "uses sandbox mode=%s independently of gateway approval defaults",
    async (mode) => {
      writeDenyExecApprovalsFixture();
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
    writeDenyExecApprovalsFixture();
    const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
      decision: "allow-once",
      risk: "low",
      rationale: "would otherwise run",
    }));
    const tool = createAutoTool({
      autoReviewer,
    });

    await expect(
      tool.execute("call-auto-mode-host-deny", {
        command: "echo blocked",
      }),
    ).rejects.toThrow(/security=deny|exec denied/i);
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
    const currentTranscript: ExecAutoReviewTranscript = {
      entries: [{ kind: "user", origin: "operator", text: "Check the Node version." }],
      omittedEntries: 0,
      truncated: false,
    };

    const liveReviews: unknown[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.data.phase === "review") {
        liveReviews.push(event.data);
      }
    });
    let result: Awaited<ReturnType<typeof tool.execute>>;
    try {
      result = await tool.execute("call-guardian-review", {
        command: "node --version",
      });
    } finally {
      unsubscribe();
    }

    expect(liveReviews).toEqual([]);
    expect(reviewTranscript).toHaveBeenCalledTimes(1);
    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "gateway", transcript: currentTranscript }),
    );
    expect(reviewerRuntime.prepare).not.toHaveBeenCalled();
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("risk=low, authorization=high") }),
      ]),
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

  it.runIf(process.platform !== "win32")(
    "executes reviewed globs and chains as written",
    async () => {
      const workdir = tempRoot;
      fs.writeFileSync(path.join(workdir, "first.review-fixture"), "fixture");
      const command = "ls *.review-fixture; echo chain-complete";
      const calls = mockApprovalGateway();
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "medium",
        rationale: "project inspection",
      }));
      const tool = createAutoTool({
        autoReviewer,
        cwd: workdir,
      });
      const result = await tool.execute("call-reviewed-glob", { command });
      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({ command, reason: "execution-plan-miss" }),
      );
      expect(calls).toEqual([]);
      expect(result.details).toMatchObject({
        status: "completed",
        exitCode: 0,
        approvalReviewOutcome: "approved",
      });
      expect(result.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining("first.review-fixture\nchain-complete"),
        }),
      );
    },
  );

  it.each(["sh script.sh; ls *.sh"])(
    "retains Guardian evidence and denies script drift for %s",
    async (command) => {
      const workdir = tempRoot;
      const script = path.join(workdir, "script.sh");
      fs.writeFileSync(script, "#!/bin/sh\necho approved\n");
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "approved script",
      }));
      const tool = createAutoTool({
        autoReviewer,
        runId: "run-guardian-script",
        cwd: workdir,
      });
      let changedAfterApproval = false;
      const unsubscribe = onAgentEvent((event) => {
        if (
          event.runId === "run-guardian-script" &&
          event.data.approvalReviewOutcome === "approved"
        ) {
          fs.writeFileSync(script, "#!/bin/sh\necho mutated\n");
          changedAfterApproval = true;
        }
      });
      let result: Awaited<ReturnType<typeof tool.execute>>;
      try {
        result = await tool.execute("tool-guardian-script", { command });
      } finally {
        unsubscribe();
      }

      expect(changedAfterApproval).toBe(true);
      expect(result.content[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining("approval script operand changed before execution"),
        }),
      );
      expect(result.details).toMatchObject({
        status: "failed",
        approvalReviewOutcome: "approved",
        approvalReviews: [{ id: "guardian:tool-guardian-script", status: "approved" }],
      });
    },
  );

  it("uses agent-scoped host policy when clamping normalized modes", async () => {
    writeExecApprovalsFixture({
      version: 1,
      defaults: { security: "deny", ask: "off" },
      agents: { main: { security: "full", ask: "off" } },
    });
    const tool = createExecTool({
      host: "gateway",
      mode: "full",
      agentId: "main",
    });

    const result = await tool.execute("call-agent-host-policy", {
      command: "echo agent-ok",
    });

    expect(result.content[0]?.type).toBe("text");
    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text.trim()).toContain("agent-ok");
  });

  it("preserves host ask floors for elevated full gateway exec", async () => {
    writeFullAskExecApprovalsFixture();
    const calls = mockApprovalGateway();
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      approvalRunningNoticeMs: 0,
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-elevated-full-host-ask-floor", {
      command: "echo ok",
      elevated: true,
    });

    expect(result.details).toMatchObject({ status: "failed", timedOut: true });
    expect((result.content[0] as { text?: string }).text).toContain("approval-timeout");
    expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
  });

  it("does not prompt explicit full sessions despite host ask floors", async () => {
    writeFullAskExecApprovalsFixture();
    const tool = createExecTool({
      host: "gateway",
      mode: "full",
      bypassHostApprovalFloors: true,
      approvalRunningNoticeMs: 0,
    });

    const result = await tool.execute("call-session-full-host-ask-floor", {
      command: "echo session-full-ok",
    });

    expect(result.details.status).toBe("completed");
    expect((result.content[0] as { text?: string }).text).toContain("session-full-ok");
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it.each([true])(
    "honors ask-only tightening without restoring full-session host floors (approved=%s)",
    async (approved) => {
      writeDenyExecApprovalsFixture();
      const calls = mockApprovalGateway(approved ? "allow-once" : null);
      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "always",
        bypassHostApprovalFloors: true,
        approvalRunningNoticeMs: 0,
      });

      const result = await tool.execute("call-session-full-tightened-ask", { command: "echo ok" });

      expect(result.details).toMatchObject(
        approved ? { status: "completed", exitCode: 0 } : { status: "failed", timedOut: true },
      );
      expect((result.content[0] as { text?: string }).text).toContain(
        approved ? "ok" : "approval-timeout",
      );
      expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
    },
  );

  it("honors normalized auto mode before elevated full bypass", async () => {
    const calls = mockApprovalGateway();
    const autoReviewer = createAskingAutoReviewer();
    const tool = createAutoTool({
      autoReviewer,
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });

    const result = await tool.execute("call-elevated-full-auto-mode", {
      command: "whoami",
      elevated: true,
    });

    expect(autoReviewer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/(?:^|[/\\])whoami(?:\.exe)?$/u),
        host: "gateway",
        reason: "allowlist-miss",
      }),
    );
    expect(result.details).toMatchObject({ status: "failed", timedOut: true });
    expect((result.content[0] as { text?: string }).text).toContain("approval-timeout");
    expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
  });

  it.each(["off"] as const)(
    "keeps auto review enabled when legacy ask=%s does not strengthen auto mode",
    async (ask) => {
      const calls = mockApprovalGateway();
      const autoReviewer = createAskingAutoReviewer();
      const tool = createAutoTool({
        autoReviewer,
      });

      const result = await tool.execute(`call-auto-review-${ask}`, {
        command: "whoami",
        ask,
      });

      expect(autoReviewer).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.stringMatching(/(?:^|[/\\])whoami(?:\.exe)?$/u),
          host: "gateway",
          reason: "allowlist-miss",
        }),
      );
      expect(result.details).toMatchObject({ status: "failed", timedOut: true });
      expect((result.content[0] as { text?: string }).text).toContain("approval-timeout");
      expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
    },
  );

  it("keeps default reviewer settings, conversation and cancellation scoped to each execution", async () => {
    let userRequest = "Check the Node version before building.";
    const reviewTranscript = vi.fn((): ExecAutoReviewTranscript => ({
      entries: [{ kind: "user", origin: "operator", text: userRequest }],
      omittedEntries: 0,
      truncated: false,
    }));
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
    const firstRun = tool.execute(
      "default-review-first",
      { command: "node --version" },
      first.signal,
    );
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
      const result = await tool.execute(
        "default-review-second",
        { command: "node --version" },
        second.signal,
      );
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
});
