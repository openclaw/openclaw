import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import type { AnyAgentTool } from "./tools/common.js";

vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
afterEach(resetDiagnosticEventsForTest);

function asAgentTool(tool: Pick<AnyAgentTool, "name" | "execute">): AnyAgentTool {
  return {
    ...tool,
    label: tool.name,
    description: "Test tool",
    parameters: { type: "object", properties: {} },
  };
}

describe("before_tool_call tool content private-data capture", () => {
  type TrustedToolEvent = {
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  async function withTrustedToolEvents(
    run: (emitted: TrustedToolEvent[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: TrustedToolEvent[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("tool.execution.")) {
        emitted.push({ event, privateData });
      }
    });
    const flush = waitForDiagnosticEventsDrained;
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  function configWithToolContent(): OpenClawConfig {
    return {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          traces: true,
          captureContent: true,
        },
      },
    };
  }

  it.each(["session-key", "agent:main:dashboard:incognito-tool"])(
    "captures opted-in tool content only outside Incognito: %s",
    async (sessionKey) => {
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file body" }] });
      const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
        agentId: "main",
        sessionKey,
        runId: "run-1",
        loopDetection: { enabled: false },
        config: configWithToolContent(),
      });

      await withTrustedToolEvents(async (emitted, flush) => {
        await expect(
          tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined),
        ).resolves.toEqual({ content: [{ type: "text", text: "file body" }] });
        await flush();

        const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
        expect(completed).toBeDefined();
        if (sessionKey.includes("incognito-")) {
          expect(completed?.privateData.toolContent).toBeUndefined();
        } else {
          expect(completed?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
          expect(completed?.privateData.toolContent?.toolOutput).toEqual({
            content: [{ type: "text", text: "file body" }],
          });
        }
        // Public event payload must never carry raw params/results.
        expect(JSON.stringify(completed?.event)).not.toContain("/etc/secret");
        expect(JSON.stringify(completed?.event)).not.toContain("file body");
      });
    },
  );

  it("omits tool content from private data when capture is not configured", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed).toBeDefined();
      expect(completed?.privateData.toolContent).toBeUndefined();
    });
  });

  it("clones captured content away from live params", async () => {
    const liveParams = { path: "/etc/secret" };
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "out" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", liveParams, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(completed?.privateData.toolContent?.toolOutput).toEqual({
        content: [{ type: "text", text: "out" }],
      });
      // Captured snapshot is a clone, not the live params object.
      expect(completed?.privateData.toolContent?.toolInput).not.toBe(liveParams);
    });
  });

  it("attaches tool input but not output on execution errors", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await expect(
        tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined),
      ).rejects.toThrow("boom");
      await flush();

      const errored = emitted.find((e) => e.event.type === "tool.execution.error");
      expect(errored?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(errored?.privateData.toolContent?.toolOutput).toBeUndefined();
    });
  });
});
