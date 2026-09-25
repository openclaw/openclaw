import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { buildCronExecOperationBinding } from "../gateway/operator-approval-standing-grants.js";
import {
  insertOperatorApproval,
  resolveOperatorApproval,
} from "../gateway/operator-approval-store.js";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  applyDelegatedExecRestrictions,
  captureDelegatedExecRestriction,
} from "./delegated-exec-policy.js";
import { captureDelegatedSourceToolPolicy } from "./inherited-tool-policy.js";
import { callGatewayTool } from "./tools/gateway.js";

export function registerDelegatedExecPolicyTests({
  getRoot,
  createExecTool,
  writeExecApprovalsFixture,
  installAllowlistedGogFixture,
  mockApprovalGateway,
}: {
  getRoot: () => string;
  createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
  writeExecApprovalsFixture: (root: string, file: Record<string, unknown>) => void;
  installAllowlistedGogFixture: (root: string) => string;
  mockApprovalGateway: (decision?: "allow-once" | "deny" | null) => string[];
}) {
  it.each([
    { source: "ask", receiver: "auto", bypass: false, approval: true },
    { source: "ask", receiver: "full", bypass: true, approval: true },
    { source: "allowlist", receiver: "auto", bypass: false, approval: false },
  ] as const)(
    "retains delegated $source against receiver $receiver (bypass=$bypass)",
    async (testCase) => {
      const root = getRoot();
      const effect = path.join(root, "delegated-effect");
      const script = path.join(root, "delegated-effect.cjs");
      fs.writeFileSync(
        script,
        `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'effect');`,
      );
      writeExecApprovalsFixture(root, {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "deny" },
        agents: {},
      });
      const calls = mockApprovalGateway("deny");
      const autoReviewer = vi.fn<ExecAutoReviewer>(async () => ({
        decision: "allow-once",
        risk: "low",
        rationale: "receiver would authorize",
      }));
      const source = captureDelegatedExecRestriction({
        host: "gateway",
        mode: testCase.source,
        safeBins: [],
      });
      const tool = createExecTool(
        applyDelegatedExecRestrictions(
          {
            host: "gateway",
            mode: testCase.receiver,
            bypassHostApprovalFloors: testCase.bypass,
            safeBins: [],
            autoReviewer,
            cwd: root,
            notifyOnExit: false,
          },
          [source.restriction],
          false,
        ),
      );
      const result = await tool.execute("delegated-effect", { command: `node "${script}"` });
      expect(result.details.status).toBe("failed");
      expect(fs.existsSync(effect)).toBe(false);
      expect(autoReviewer).not.toHaveBeenCalled();
      expect(calls).toEqual(
        testCase.approval ? ["exec.approval.request", "exec.approval.waitDecision"] : [],
      );
      if (!testCase.approval) {
        expect(result.content).toContainEqual(
          expect.objectContaining({ text: expect.stringContaining("delegated-allowlist-miss") }),
        );
      }
      const ordinary = createExecTool({
        host: "gateway",
        mode: "full",
        cwd: root,
        notifyOnExit: false,
      });
      expect(
        (await ordinary.execute("ordinary-effect", { command: `node "${script}"` })).details.status,
      ).toBe("completed");
      expect(fs.readFileSync(effect, "utf8")).toBe("effect");
    },
  );

  it.each([
    {
      sourceFallback: "deny",
      sourceAsk: "always",
      decision: null,
      command: "gog version",
      succeeds: false,
    },
    {
      sourceFallback: "full",
      sourceAsk: "always",
      decision: null,
      command: "gog version",
      succeeds: true,
    },
    {
      sourceFallback: "allowlist",
      sourceAsk: "always",
      decision: null,
      command: "gog version",
      succeeds: false,
    },
    {
      sourceFallback: "allowlist",
      sourceAsk: "always",
      decision: null,
      command: "head --bytes=1",
      succeeds: true,
    },
    {
      sourceFallback: "deny",
      sourceAsk: "off",
      decision: null,
      command: "gog version",
      succeeds: true,
    },
    {
      sourceFallback: "deny",
      sourceAsk: "always",
      decision: "allow-once",
      command: "gog version",
      succeeds: true,
    },
  ] as const)(
    "retains source $sourceFallback timeout fallback for $command after receiver policy changes (source ask=$sourceAsk, decision=$decision)",
    async ({ sourceFallback, sourceAsk, decision, command, succeeds }) => {
      const root = getRoot();
      const binDir = installAllowlistedGogFixture(root);
      const effect = path.join(root, "source-fallback-effect");
      fs.writeFileSync(
        path.join(binDir, "gog"),
        `#!/bin/sh\nprintf 'effect' > ${JSON.stringify(effect)}\n`,
        { mode: 0o755 },
      );
      writeExecApprovalsFixture(root, {
        version: 1,
        defaults: { security: "full", ask: sourceAsk, askFallback: sourceFallback },
        agents: {},
      });
      const saved = await captureDelegatedSourceToolPolicy({
        policy: {
          clauses: [],
          parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
        },
        exec: { host: "gateway", security: "full", ask: "off", safeBins: ["head"] },
        sandboxed: false,
        config: {},
        agentId: "main",
        assertCurrent: () => {},
      });
      writeExecApprovalsFixture(root, {
        version: 1,
        defaults: { security: "full", ask: "off", askFallback: "full" },
        agents: { "*": { allowlist: [{ pattern: path.join(binDir, "gog") }] } },
      });
      const calls = mockApprovalGateway(decision);
      const receiver = {
        host: "gateway" as const,
        security: "full" as const,
        ask: "always" as const,
        pathPrepend: [binDir],
        safeBins: [],
        notifyOnExit: false,
      };
      const ordinary = await createExecTool(receiver).execute("ordinary-timeout-fallback", {
        command: "gog version",
      });
      expect(ordinary.details.status).toBe("completed");
      expect(fs.readFileSync(effect, "utf8")).toBe("effect");
      fs.rmSync(effect);
      calls.length = 0;
      const restricted = createExecTool(
        applyDelegatedExecRestrictions(receiver, saved.parameters.exec, false),
      );
      const result = await restricted.execute("delegated-timeout-fallback", { command });
      expect(result.details.status).toBe(succeeds ? "completed" : "failed");
      expect(fs.existsSync(effect)).toBe(succeeds && command === "gog version");
      expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
    },
  );

  it("keeps a receiver cron standing grant from satisfying a delegated command miss", async () => {
    const root = getRoot();
    const workdir = fs.realpathSync(root);
    const effect = path.join(root, "standing-grant-effect");
    writeExecApprovalsFixture(root, {
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "deny" },
      agents: {},
    });
    const database = openOpenClawStateDatabase();
    const cronStoreKey = path.join(root, "cron");
    const job: CronStoredJob = {
      id: "delegated-grant-job",
      agentId: "main",
      name: "Grant fixture",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "check status" },
      state: {},
    };
    upsertCronJobRow(database.db, cronStoreKey, job, 0);
    const storedJob = loadedCronStoreFromRows(loadCronRows(database.db, cronStoreKey)).store
      .jobs[0];
    if (!storedJob) {
      throw new Error("Missing cron fixture");
    }
    const revision = resolveCronJobConfigRevision(storedJob);
    const command = `touch ${JSON.stringify(effect)}`;
    const now = Date.now();
    await insertOperatorApproval({
      approval: {
        id: "delegated-grant-approval",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: command,
          commandPreview: command,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        },
        reviewerDeviceIds: [],
        source: {
          agentId: "main",
          sessionKey: "agent:main:cron:delegated-grant-job",
          sessionId: "grant-session",
          runId: "grant-creation-run",
          toolCallId: null,
          toolName: "exec",
        },
        audienceSessionKeys: [],
        runtimeEpoch: "fixture-epoch",
        createdAtMs: now,
        expiresAtMs: now + 60_000,
      },
    });
    expect(
      (
        await resolveOperatorApproval({
          id: "delegated-grant-approval",
          decision: "allow-always",
          resolver: { kind: "device", id: "fixture-reviewer" },
          standingGrant: {
            kind: "cron",
            agentId: "main",
            cronJobId: job.id,
            jobConfigRevision: revision,
            operationBinding: buildCronExecOperationBinding({
              command,
              cwd: workdir,
              env: undefined,
            }),
            expiresAtMs: null,
          },
        })
      ).outcome,
    ).toBe("resolved");
    const unregister = registerCronRunExecSource("grant-receiver-run", {
      agentId: "main",
      jobId: job.id,
      jobName: job.name,
      jobConfigRevision: revision,
    });
    const calls = mockApprovalGateway("deny");
    const receiver = {
      host: "gateway" as const,
      mode: "ask" as const,
      safeBins: [],
      cwd: workdir,
      runId: "grant-receiver-run",
      notifyOnExit: false,
    };
    try {
      expect(
        (await createExecTool(receiver).execute("ordinary-cron-grant", { command })).details.status,
      ).toBe("completed");
      expect(fs.existsSync(effect)).toBe(true);
      expect(calls).toEqual([]);
      fs.rmSync(effect);
      const source = captureDelegatedExecRestriction({
        host: "gateway",
        mode: "ask",
        safeBins: [],
      });
      const restricted = createExecTool(
        applyDelegatedExecRestrictions(receiver, [source.restriction], false),
      );
      const result = await restricted.execute("delegated-cron-grant", { command });
      expect(result.details.status).toBe("failed");
      expect(fs.existsSync(effect)).toBe(false);
      expect(calls).toEqual(["exec.approval.request", "exec.approval.waitDecision"]);
    } finally {
      unregister();
    }
  });

  it.each([
    { sourceMode: "allowlist", decision: "deny" },
    { sourceMode: "ask", decision: "deny" },
    { sourceMode: "ask", decision: null },
  ] as const)(
    "does not substitute a receiver grant for delegated $sourceMode after $decision",
    async ({ sourceMode, decision }) => {
      const root = getRoot();
      const binDir = installAllowlistedGogFixture(root);
      const effect = path.join(root, "receiver-grant-effect");
      fs.writeFileSync(
        path.join(binDir, "gog"),
        `#!/bin/sh\nprintf 'effect' > ${JSON.stringify(effect)}\n`,
        { mode: 0o755 },
      );
      const calls = mockApprovalGateway(decision);
      const source = captureDelegatedExecRestriction({
        host: "gateway",
        mode: sourceMode,
        safeBins: [],
      });
      const receiver = {
        host: "gateway" as const,
        mode: "full" as const,
        pathPrepend: [binDir],
        safeBins: [],
        notifyOnExit: false,
      };
      const tool = createExecTool(
        applyDelegatedExecRestrictions(receiver, [source.restriction], false),
      );
      const result = await tool.execute("delegated-receiver-grant", { command: "gog version" });
      expect(result.details.status).toBe("failed");
      expect(fs.existsSync(effect)).toBe(false);
      expect(calls).toEqual(
        sourceMode === "ask" ? ["exec.approval.request", "exec.approval.waitDecision"] : [],
      );
      const ordinary = await createExecTool(receiver).execute("ordinary-receiver-grant", {
        command: "gog version",
      });
      expect(ordinary.details.status).toBe("completed");
      expect(fs.readFileSync(effect, "utf8")).toBe("effect");
    },
  );

  it.runIf(process.platform !== "win32").each(["allowlist", "full", "grant"] as const)(
    "retains delegated safe-bin arguments with a %s receiver",
    async (receiverMode) => {
      writeExecApprovalsFixture(getRoot(), {
        version: 1,
        defaults: { security: "full", ask: "off" },
        agents: receiverMode === "grant" ? { "*": { allowlist: [{ pattern: "head" }] } } : {},
      });
      const source = captureDelegatedExecRestriction({
        host: "gateway",
        mode: "allowlist",
        safeBins: ["head"],
        safeBinProfiles: { head: { maxPositional: 0, allowedValueFlags: ["--bytes"] } },
      });
      const tool = createExecTool(
        applyDelegatedExecRestrictions(
          {
            host: "gateway",
            mode: receiverMode === "full" ? "full" : "allowlist",
            safeBins: receiverMode === "allowlist" ? ["head"] : [],
            notifyOnExit: false,
            safeBinProfiles: {
              head: { maxPositional: 0, allowedValueFlags: ["--bytes", "--lines"] },
            },
          },
          [source.restriction],
          false,
        ),
      );
      const denied = await tool.execute("delegated-profile-denied", { command: "head --lines=1" });
      expect(denied.details.status).toBe("failed");
      expect(callGatewayTool).not.toHaveBeenCalled();
      expect(
        (await tool.execute("delegated-profile-allowed", { command: "head --bytes=1" })).details
          .status,
      ).toBe("completed");
    },
  );

  it("refuses inherited approval semantics before sandbox allocation and at the retained exec boundary", async () => {
    const source = captureDelegatedExecRestriction({ mode: "ask", safeBins: [] });
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, "--version"],
      env: process.env,
      stdinMode: "pipe-closed" as const,
    }));
    const defaults = {
      sandbox: {
        containerName: "delegated-backend",
        workspaceDir: getRoot(),
        containerWorkdir: "/workspace",
        buildExecSpec,
      },
    };
    expect(() => applyDelegatedExecRestrictions(defaults, [source.restriction], true)).toThrow(
      /unsupported by this backend/,
    );
    expect(() =>
      createExecTool({ ...defaults, delegatedRestrictions: [source.restriction] }),
    ).toThrow(/unsupported by this backend/);
    expect(buildExecSpec).not.toHaveBeenCalled();
  });
}
