/**
 * dev-task-runner.test.ts — 驗證掃描/lane+安全過濾/狀態機/完成防重跑。
 * 注入 mock worktree+executor → 不需真 codex/真 git，任何環境可跑。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAutomationConfirmGateNotifyApproval,
  createFifoMergeQueue,
  createRunCliAgentTaskExecutor,
  isRealTradingExecution,
  processCard,
  requiresManualApproval,
  runOnce,
  scanTaskCards,
  type DevTaskRunnerDeps,
  type RunCliAgentFn,
  type WorktreeHandle,
} from "../dev-task-runner.js";

let repoRoot = "";

function fakeWorktree(): DevTaskRunnerDeps["acquireWorktree"] {
  return (async (opts) => {
    const dir = path.join(repoRoot, ".worktrees", `${opts.owner}-${opts.taskId}`);
    await fs.mkdir(dir, { recursive: true });
    return {
      dir,
      branch: `ai/${opts.owner}/${opts.taskId}`,
      remove: vi.fn(async () => {}),
    } as WorktreeHandle;
  }) as DevTaskRunnerDeps["acquireWorktree"];
}

function noopMergeQueue(): NonNullable<DevTaskRunnerDeps["mergeQueue"]> {
  return vi.fn(async () => {});
}

async function writeCard(name: string, fm: string, body = "任務內容"): Promise<string> {
  const p = path.join(repoRoot, name);
  await fs.writeFile(p, `---\n${fm}\n---\n\n${body}\n`, "utf8");
  return p;
}

async function readStatus(p: string): Promise<string> {
  const raw = await fs.readFile(p, "utf8");
  return raw.match(/^status:\s*(.+)$/m)?.[1].trim() ?? "";
}

beforeEach(async () => {
  repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-task-"));
});
afterEach(async () => {
  await fs.rm(repoRoot, { recursive: true, force: true });
});

describe("dev-task-runner", () => {
  it("scanTaskCards 解析 front-matter", async () => {
    await writeCard("CODEX_TASK_a.md", "id: a\nstatus: pending\nlane: dev\nverify: echo ok");
    await fs.writeFile(path.join(repoRoot, "README.md"), "not a task", "utf8");
    const cards = await scanTaskCards(repoRoot);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("a");
    expect(cards[0].verify).toBe("echo ok");
  });

  it("scanTaskCards 會跳過 runner: ignore", async () => {
    await writeCard("CODEX_TASK_pick.md", "id: pick\nstatus: pending\nlane: dev\nverify: echo ok");
    await writeCard(
      "CODEX_TASK_skip.md",
      "id: skip\nstatus: pending\nlane: dev\nrunner: ignore\nverify: echo ok",
    );
    const cards = await scanTaskCards(repoRoot);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe("pick");
  });

  it("dev 任務 verify 綠 → completed，executor 被呼叫、worktree 移除", async () => {
    const p = await writeCard(
      "CODEX_TASK_ok.md",
      "id: ok\nstatus: pending\nlane: dev\nverify: echo ok",
    );
    const executor = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const acquireWorktree = (async (o) => ({
      dir: path.join(repoRoot, "wt"),
      branch: `ai/${o.owner}/${o.taskId}`,
      remove,
    })) as DevTaskRunnerDeps["acquireWorktree"];
    await fs.mkdir(path.join(repoRoot, "wt"), { recursive: true });
    const status = await processCard((await scanTaskCards(repoRoot))[0], repoRoot, {
      acquireWorktree,
      executor,
      runVerify: async () => true,
      mergeQueue: noopMergeQueue(),
    });
    expect(status).toBe("completed");
    expect(executor).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(await readStatus(p)).toBe("completed");
  });

  it("approval:required（重大/不可逆）→ needs-approval 並發通知", async () => {
    const p = await writeCard(
      "CODEX_TASK_t.md",
      "id: t\nstatus: pending\napproval: required\nverify: echo",
    );
    const notifyApproval = vi.fn(async () => {});
    const status = await processCard((await scanTaskCards(repoRoot))[0], repoRoot, {
      acquireWorktree: fakeWorktree(),
      notifyApproval,
      mergeQueue: noopMergeQueue(),
    });
    expect(status).toBe("needs-approval");
    expect(notifyApproval).toHaveBeenCalledOnce();
    expect(await readStatus(p)).toBe("needs-approval");
  });

  it("needs-approval 且尚未 granted 時維持等待，不重送通知", async () => {
    await writeCard(
      "CODEX_TASK_wait.md",
      "id: wait\nstatus: needs-approval\napproval: required\napproved: requested\nverify: echo",
    );
    const executor = vi.fn(async () => {});
    const notifyApproval = vi.fn(async () => {});
    const status = await processCard((await scanTaskCards(repoRoot))[0], repoRoot, {
      acquireWorktree: fakeWorktree(),
      executor,
      notifyApproval,
      mergeQueue: noopMergeQueue(),
    });
    expect(status).toBe("needs-approval");
    expect(executor).not.toHaveBeenCalled();
    expect(notifyApproval).not.toHaveBeenCalled();
  });

  it("needs-approval + approved:granted 會恢復執行且完成", async () => {
    const p = await writeCard(
      "CODEX_TASK_resume.md",
      "id: resume\nstatus: needs-approval\napproval: required\napproved: granted\nverify: echo ok",
    );
    const executor = vi.fn(async () => {});
    const notifyApproval = vi.fn(async () => {});
    const status = await processCard((await scanTaskCards(repoRoot))[0], repoRoot, {
      acquireWorktree: fakeWorktree(),
      runVerify: async () => true,
      executor,
      notifyApproval,
      mergeQueue: noopMergeQueue(),
    });
    expect(status).toBe("completed");
    expect(executor).toHaveBeenCalledOnce();
    expect(notifyApproval).not.toHaveBeenCalled();
    expect(await readStatus(p)).toBe("completed");
  });

  it("交易相關但 approval:auto → 自動執行（交易可自動，只有重大才問）", async () => {
    await writeCard(
      "CODEX_TASK_sim.md",
      "id: sim\nstatus: pending\nlane: trading\napproval: auto\nverify: echo ok",
      "跑交易策略回測模擬",
    );
    const status = await processCard((await scanTaskCards(repoRoot))[0], repoRoot, {
      acquireWorktree: fakeWorktree(),
      runVerify: async () => true,
      executor: async () => {},
      mergeQueue: noopMergeQueue(),
    });
    expect(status).toBe("completed");
  });

  it("交易真實執行 metadata → needs-approval，不自動執行", async () => {
    const p = await writeCard(
      "CODEX_TASK_live.md",
      "id: live\nstatus: pending\nlane: trading\napproval: auto\nexecution: live-order\nverify: echo ok",
    );
    const executor = vi.fn(async () => {});
    const notifyApproval = vi.fn(async () => {});
    const card = (await scanTaskCards(repoRoot))[0];
    expect(isRealTradingExecution(card)).toBe(true);
    expect(requiresManualApproval(card)).toBe(true);
    const status = await processCard(card, repoRoot, {
      acquireWorktree: fakeWorktree(),
      executor,
      notifyApproval,
      mergeQueue: noopMergeQueue(),
    });
    expect(status).toBe("needs-approval");
    expect(executor).not.toHaveBeenCalled();
    expect(notifyApproval).toHaveBeenCalledOnce();
    expect(await readStatus(p)).toBe("needs-approval");
  });

  it("verify 失敗 → stuck，超 maxRetries → escalated", async () => {
    const p = await writeCard(
      "CODEX_TASK_f.md",
      "id: f\nstatus: pending\nlane: dev\nverify: exit 1\nmaxRetries: 1",
    );
    const deps: DevTaskRunnerDeps = {
      acquireWorktree: fakeWorktree(),
      runVerify: async () => false,
      mergeQueue: noopMergeQueue(),
    };
    expect(await processCard((await scanTaskCards(repoRoot))[0], repoRoot, deps)).toBe("stuck");
    // 重派（retries 已寫回 front-matter）→ 超 maxRetries → escalated
    expect(await processCard((await scanTaskCards(repoRoot))[0], repoRoot, deps)).toBe("escalated");
    expect(await readStatus(p)).toBe("escalated");
  });

  it("completed 任務被 runOnce 跳過（防重跑）", async () => {
    await writeCard("CODEX_TASK_done.md", "id: done\nstatus: completed\nlane: dev\nverify: echo");
    const executor = vi.fn(async () => {});
    const handled = await runOnce(repoRoot, {
      acquireWorktree: fakeWorktree(),
      executor,
      mergeQueue: noopMergeQueue(),
    });
    expect(handled).toBe(0);
    expect(executor).not.toHaveBeenCalled();
  });

  it("runOnce 會處理 needs-approval + approved:granted", async () => {
    await writeCard(
      "CODEX_TASK_resume_once.md",
      "id: resume-once\nstatus: needs-approval\napproval: required\napproved: granted\nverify: echo ok",
    );
    const executor = vi.fn(async () => {});
    const handled = await runOnce(repoRoot, {
      acquireWorktree: fakeWorktree(),
      runVerify: async () => true,
      executor,
      mergeQueue: noopMergeQueue(),
    });
    expect(handled).toBe(1);
    expect(executor).toHaveBeenCalledOnce();
  });

  it("createRunCliAgentTaskExecutor 用 openai-codex 在 worktree 內派任務", async () => {
    await writeCard(
      "CODEX_TASK_codex.md",
      "id: codex\nstatus: pending\nlane: dev\nverify: echo ok",
    );
    const calls: Parameters<RunCliAgentFn>[0][] = [];
    const runCliAgent: RunCliAgentFn = vi.fn(async (params) => {
      calls.push(params);
      return { payloads: [], meta: {} } as Awaited<ReturnType<RunCliAgentFn>>;
    });
    const executor = createRunCliAgentTaskExecutor({
      runCliAgent,
      timeoutMs: 1234,
    });
    await executor({
      task: (await scanTaskCards(repoRoot))[0],
      worktreeDir: repoRoot,
      repoRoot,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      workspaceDir: repoRoot,
      trigger: "cron",
      timeoutMs: 1234,
      senderIsOwner: true,
    });
    expect(calls[0].prompt).toContain("approval:required");
  });

  it("createAutomationConfirmGateNotifyApproval 走 plugin approval 的 automation_confirm_gate", async () => {
    await writeCard(
      "CODEX_TASK_gate.md",
      "id: gate\nstatus: pending\napproval: required\nverify: echo",
    );
    const callGateway = vi.fn(async () => ({ status: "accepted" }));
    const notifyApproval = createAutomationConfirmGateNotifyApproval({ callGateway });
    await notifyApproval((await scanTaskCards(repoRoot))[0]);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugin.approval.request",
        expectFinal: false,
        params: expect.objectContaining({
          pluginId: "automation",
          toolName: "automation_confirm_gate",
          toolCallId: "dev-task:gate",
          twoPhase: true,
        }),
      }),
    );
  });

  it("FIFO merge queue 等前一個套用完成後才處理下一個", async () => {
    await writeCard("CODEX_TASK_merge.md", "id: merge\nstatus: pending\nlane: dev\nverify: echo");
    const baseTask = (await scanTaskCards(repoRoot))[0];
    const applyOrder: string[] = [];
    const applyArgs: string[][] = [];
    let firstCompleted = false;
    let secondSawFirstCompleted = false;
    const git = vi.fn(async (cwd: string, args: string[], input?: string) => {
      if (args[0] === "status") return { stdout: " M file.ts\n", stderr: "" };
      if (args[0] === "diff") {
        const marker = cwd.includes("first") ? "first" : "second";
        return { stdout: `patch-${marker}`, stderr: "" };
      }
      if (args[0] === "apply") {
        applyArgs.push(args);
        const marker = input?.includes("first") ? "first" : "second";
        applyOrder.push(marker);
        if (marker === "first") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          firstCompleted = true;
        } else {
          secondSawFirstCompleted = firstCompleted;
        }
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const queue = createFifoMergeQueue({ git });
    await Promise.all([
      queue({
        task: { ...baseTask, id: "first" },
        worktree: { dir: path.join(repoRoot, "first"), branch: "ai/codex/first", remove: vi.fn() },
        repoRoot,
        runVerify: async () => true,
        log: () => {},
      }),
      queue({
        task: { ...baseTask, id: "second" },
        worktree: {
          dir: path.join(repoRoot, "second"),
          branch: "ai/codex/second",
          remove: vi.fn(),
        },
        repoRoot,
        runVerify: async () => true,
        log: () => {},
      }),
    ]);
    expect(applyOrder).toEqual(["first", "second"]);
    expect(secondSawFirstCompleted).toBe(true);
    expect(applyArgs[0]).toContain("--3way");
  });
});
