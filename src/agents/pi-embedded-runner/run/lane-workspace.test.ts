import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { CommandLane } from "../../../process/lanes.js";
import {
  buildEmbeddedRunQueuePlan,
  isEmbeddedProbeSession,
  logEmbeddedRunWorkspaceFallback,
  resolveEmbeddedRunToolResultFormat,
  resolveEmbeddedRunWorkspaceContext,
  throwIfEmbeddedRunAborted,
} from "./lane-workspace.js";

describe("lane-workspace orchestration helpers", () => {
  it("builds session and global queue lanes with the embedded run deadlock guard", async () => {
    const calls: string[] = [];
    const enqueueInLane = <T>(lane: string, task: () => Promise<T>) => {
      calls.push(lane);
      return task();
    };

    const plan = buildEmbeddedRunQueuePlan({
      sessionKey: " session-key ",
      sessionId: "session-id",
      lane: CommandLane.Cron,
      enqueueInLane,
    });

    expect(plan.sessionLane).toBe("session:session-key");
    expect(plan.globalLane).toBe(CommandLane.CronNested);
    await expect(plan.enqueueSession(async () => "session")).resolves.toBe("session");
    await expect(plan.enqueueGlobal(async () => "global")).resolves.toBe("global");
    expect(calls).toEqual(["session:session-key", CommandLane.CronNested]);
  });

  it("preserves caller-provided enqueue functions for both queue stages", async () => {
    let enqueueCalls = 0;
    let enqueueInLaneCalled = false;
    const enqueue = <T>(task: () => Promise<T>) => {
      enqueueCalls += 1;
      return task();
    };
    const enqueueInLane = <T>(_lane: string, task: () => Promise<T>) => {
      enqueueInLaneCalled = true;
      return task();
    };
    const plan = buildEmbeddedRunQueuePlan({
      sessionId: "session-id",
      enqueue,
      enqueueInLane,
    });

    await expect(plan.enqueueSession(async () => "session")).resolves.toBe("session");
    await expect(plan.enqueueGlobal(async () => "global")).resolves.toBe("global");
    expect(enqueueCalls).toBe(2);
    expect(enqueueInLaneCalled).toBe(false);
  });

  it("resolves tool-result format from explicit preference or channel capability", () => {
    expect(resolveEmbeddedRunToolResultFormat({ toolResultFormat: "plain" })).toBe("plain");
    expect(resolveEmbeddedRunToolResultFormat({ messageChannel: "tui" })).toBe("markdown");
    expect(resolveEmbeddedRunToolResultFormat({ messageProvider: "unknown-channel" })).toBe(
      "plain",
    );
    expect(resolveEmbeddedRunToolResultFormat({})).toBe("markdown");
  });

  it("exposes probe-session detection without keeping it inline in run.ts", () => {
    expect(isEmbeddedProbeSession("probe-auth")).toBe(true);
    expect(isEmbeddedProbeSession("user-session")).toBe(false);
    expect(isEmbeddedProbeSession()).toBe(false);
  });

  it("normalizes abort reasons the same way as the embedded run entrypoint", () => {
    const controller = new AbortController();
    controller.abort("sessions_yield");

    expect(() => throwIfEmbeddedRunAborted(controller.signal)).toThrow("Operation aborted");
    try {
      throwIfEmbeddedRunAborted(controller.signal);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("AbortError");
      expect((err as Error).cause).toBe("sessions_yield");
    }

    const errorController = new AbortController();
    const reason = new Error("boom");
    errorController.abort(reason);
    expect(() => throwIfEmbeddedRunAborted(errorController.signal)).toThrow(reason);
  });

  it("resolves workspace context and canonical-workspace status together", () => {
    const defaultWorkspace = path.join(process.cwd(), "tmp", "lane-workspace-main");
    const cfg = {
      agents: {
        defaults: { workspace: defaultWorkspace },
      },
    } satisfies OpenClawConfig;

    const context = resolveEmbeddedRunWorkspaceContext({
      workspaceDir: "  ",
      sessionKey: "agent:main:subagent:test",
      config: cfg,
    });

    expect(context.workspaceResolution.usedFallback).toBe(true);
    expect(context.workspaceResolution.fallbackReason).toBe("blank");
    expect(context.resolvedWorkspace).toBe(path.resolve(defaultWorkspace));
    expect(context.canonicalWorkspace).toBe(path.resolve(defaultWorkspace));
    expect(context.isCanonicalWorkspace).toBe(true);
  });

  it("logs workspace fallback with redacted identifiers only when fallback was used", () => {
    const warn = vi.fn();
    logEmbeddedRunWorkspaceFallback({
      workspaceResolution: {
        workspaceDir: "/tmp/workspace",
        usedFallback: false,
        agentId: "main",
        agentIdSource: "default",
      },
      resolvedWorkspace: "/tmp/workspace",
      runId: "run-123",
      sessionId: "session-secret",
      sessionKey: "agent:main:subagent:secret",
      warn,
    });
    expect(warn).not.toHaveBeenCalled();

    logEmbeddedRunWorkspaceFallback({
      workspaceResolution: {
        workspaceDir: "/tmp/workspace",
        usedFallback: true,
        fallbackReason: "missing",
        agentId: "main",
        agentIdSource: "default",
      },
      resolvedWorkspace: "/tmp/workspace",
      runId: "run-123",
      sessionId: "session-secret",
      sessionKey: "agent:main:subagent:secret",
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("[workspace-fallback]");
    expect(warn.mock.calls[0]?.[0]).toContain("reason=missing");
  });
});
