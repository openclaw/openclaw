import { describe, expect, it, vi } from "vitest";
import { claimAgentSessionWriter } from "../../../src/agents/embedded-agent-runner/run/session-bootstrap.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../../../src/agents/embedded-agent-runner/runs.test-support.js";
import { resolveDefaultSessionStorePath } from "../../../src/config/sessions/paths.js";
import * as sessions from "../../../src/config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../src/config/sessions/types.js";
import { installGatewayTestHooks, startServer } from "../../../src/gateway/test-helpers.js";
import { getAgentEventLifecycleGeneration } from "../../../src/infra/agent-events.js";
import * as runContexts from "../../../src/infra/agent-run-registry.js";
import { withTimeout } from "../../../src/infra/fs-safe.js";
import { GatewayClientTransport, OpenClaw } from "./index.js";

describe("SDK writer takeover through the Gateway", () => {
  installGatewayTestHooks({ scope: "test" });

  it("reports the superseded writer as cancelled in events and waits", async () => {
    const token = "sdk-writer-takeover-token";
    const started = await startServer(token, { controlUiEnabled: false });
    const oc = new OpenClaw({
      transport: new GatewayClientTransport({
        url: `ws://127.0.0.1:${started.port}`,
        token,
        deviceIdentity: null,
        requestTimeoutMs: 2_000,
      }),
    });
    const sessionId = "sdk-writer-session";
    const sessionKey = "agent:main:dashboard:sdk-writer-takeover";
    const runId = "sdk-prior-writer";
    const nextRunId = "sdk-next-writer";
    const target = {
      agentId: "main",
      sessionKey,
      storePath: resolveDefaultSessionStorePath("main"),
    };
    const cancellation = vi.fn(() => sessions.loadSessionEntry(target));
    const incumbent = {
      ...createEmbeddedRunHandle({ runId, abort: vi.fn() }),
      kind: "embedded" as const,
      cancel: cancellation,
    };

    try {
      await oc.connect();
      await sessions.replaceSessionEntry(target, {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: "sdk-writer-revision",
        activeWriterRunId: runId,
      } satisfies InternalSessionEntry);
      setActiveEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
      runContexts.registerAgentRunContext(runId, {
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionId,
        sessionKey,
      });
      const run = await oc.runs.get(runId);
      const terminalEvent = (async () => {
        for await (const event of run.events()) {
          if (
            ["run.completed", "run.failed", "run.cancelled", "run.timed_out"].includes(event.type)
          ) {
            return event.type;
          }
        }
      })().catch((error: unknown) => error);

      await claimAgentSessionWriter({
        agentId: "main",
        prompt: "next turn",
        runId: nextRunId,
        sessionId,
        sessionKey,
        sessionTarget: { ...target, sessionId },
        timeoutMs: 30_000,
        workspaceDir: process.cwd(),
      });
      const [eventType, wait] = await Promise.all([
        withTimeout(terminalEvent, 2_000, {
          message: "timed out waiting for the superseded writer SDK event",
        }),
        run.wait({ timeoutMs: 500 }),
      ]);

      expect(cancellation).toHaveBeenCalledWith("superseded");
      expect(cancellation).toHaveReturnedWith(
        expect.objectContaining({ activeWriterRunId: nextRunId }),
      );
      expect(sessions.loadSessionEntry(target)).toMatchObject({ activeWriterRunId: nextRunId });
      expect({ eventType, waitStatus: wait.status }).toEqual({
        eventType: "run.cancelled",
        waitStatus: "cancelled",
      });
    } finally {
      clearActiveEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
      runContexts.clearAgentRunContext(runId);
      await oc.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
