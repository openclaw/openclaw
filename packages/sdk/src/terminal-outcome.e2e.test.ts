import { expect, it, vi } from "vitest";
import { claimAgentSessionWriter } from "../../../src/agents/embedded-agent-runner/run/session-bootstrap.js";
import * as embeddedRuns from "../../../src/agents/embedded-agent-runner/runs.test-support.js";
import { resolveDefaultSessionStorePath } from "../../../src/config/sessions/paths.js";
import * as sessions from "../../../src/config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../src/config/sessions/types.js";
import { installGatewayTestHooks, startServer } from "../../../src/gateway/test-helpers.js";
import { getAgentEventLifecycleGeneration } from "../../../src/infra/agent-events.js";
import * as runContexts from "../../../src/infra/agent-run-registry.js";
import { withTimeout } from "../../../src/infra/fs-safe.js";
import { GatewayClientTransport, OpenClaw } from "./index.js";

installGatewayTestHooks({ scope: "test" });
const terminalTypes = new Set(["run.completed", "run.failed", "run.cancelled", "run.timed_out"]);

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
  const nextId = "sdk-next-writer";
  const storePath = resolveDefaultSessionStorePath("main");
  const target = { agentId: "main", sessionKey, storePath };
  const cancellation = vi.fn(() => sessions.loadSessionEntry(target));
  const incumbent = {
    ...embeddedRuns.createEmbeddedRunHandle({ runId, abort: vi.fn() }),
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
    embeddedRuns.registerTestEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
    runContexts.registerAgentRunContext(runId, {
      agentId: "main",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      sessionId,
      sessionKey,
    });
    const run = await oc.runs.get(runId);
    const terminalEvent = (async () => {
      for await (const { type } of run.events((event) => terminalTypes.has(event.type))) {
        return type;
      }
      return undefined;
    })().catch((error: unknown) => error);

    await claimAgentSessionWriter({
      agentId: "main",
      prompt: "next turn",
      runId: nextId,
      sessionId,
      sessionKey,
      sessionTarget: { ...target, sessionId },
      timeoutMs: 30_000,
      workspaceDir: process.cwd(),
    });
    const [eventType, wait] = await Promise.all([
      withTimeout(terminalEvent, 2_000, { message: "missing superseded writer SDK event" }),
      run.wait({ timeoutMs: 500 }),
    ]);

    expect(cancellation).toHaveBeenCalledWith("superseded");
    expect(cancellation).toHaveReturnedWith(expect.objectContaining({ activeWriterRunId: nextId }));
    expect(sessions.loadSessionEntry(target)).toMatchObject({ activeWriterRunId: nextId });
    expect([eventType, wait.status]).toEqual(["run.cancelled", "cancelled"]);
  } finally {
    embeddedRuns.clearTestEmbeddedRun(sessionId, incumbent, sessionKey, sessionKey);
    runContexts.clearAgentRunContext(runId);
    await oc.close();
    await started.server.close();
    started.envSnapshot.restore();
  }
});
