import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "../../gateway/mcp-grant-store.js";
import type { CliBackendLiveSessionHandle } from "../../plugins/cli-backend.types.js";
import { getAdmittedRunDelegatedAuthority } from "../admitted-run-context.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
  waitUntilAborted,
} from "./execute-plugin.test-support.js";
import { createCliToolTracking } from "./execute-tool-tracking.js";

vi.mock("../tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const activeSessions = new Set<CliBackendLiveSessionHandle>();

afterEach(() => {
  for (const session of activeSessions) {
    session.close("restart");
  }
  activeSessions.clear();
  closePluginTestAdmissions();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CLI MCP capture authority", () => {
  it.each([
    { name: "one-shot timeout", liveSession: false },
    { name: "live backend cancellation", liveSession: true },
  ])("revokes MCP authority before iterator cleanup after $name", async ({ liveSession }) => {
    vi.useFakeTimers();
    const source = new AbortController();
    const { context } = await createExecution({ abortSignal: source.signal, timeoutMs: 100 });
    const operation = createReplyOperation({
      sessionKey: context.params.sessionKey!,
      sessionId: context.params.sessionId,
      resetTriggered: false,
    });
    context.params.replyOperation = operation;
    const runtimeOwnerToken = `runtime-${context.params.runId}`;
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: context.params.sessionKey!, senderIsOwner: false },
      runtimeOwnerToken,
      admittedRunContext: context.params.admittedRunContext,
      abortSignal: source.signal,
    });
    context.preparedBackend.mcpClientGrantCapture = {
      transportToken: grant.token,
      adoptProcessToken: (targetToken) => {
        transferMcpLoopbackClientGrant({
          sourceToken: grant.token,
          targetToken,
          runtimeOwnerToken,
        });
      },
      revokeProcessToken: () => {
        revokeMcpLoopbackClientGrant(grant.token);
      },
      activate: (captureKey, assertCurrent) => {
        activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken,
          captureKey,
          assertCurrent,
        });
      },
      deactivate: (captureKey) => {
        deactivateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken,
          captureKey,
        });
      },
    };
    const tracking = createCliToolTracking(context);
    const captureKey = `capture-${context.params.runId}`;
    const capture = { token: grant.token, runtimeOwnerToken, captureKey };
    const streamStarted = createDeferred();
    const streamClosing = createDeferred();
    const releaseCleanup = createDeferred();
    const run = runPlugin(
      context,
      async function* (execution) {
        if (liveSession) {
          const capability = execution.liveSession;
          if (!capability) {
            throw new Error("expected live CLI session capability");
          }
          const handle: CliBackendLiveSessionHandle = {
            generation: context.params.runId,
            fingerprint: capability.fingerprint,
            isIdle: () => true,
            close: () => capability.remove(handle),
            waitForExit: async () => {},
          };
          capability.register(handle);
          activeSessions.add(handle);
          capability.activate(handle);
        }
        const aborted = waitUntilAborted(execution);
        streamStarted.resolve();
        try {
          await aborted;
          yield SUCCESS_RESULT;
        } finally {
          streamClosing.resolve();
          await releaseCleanup.promise;
        }
      },
      { liveSession, mcpCapture: { captureKey, beginCapture: tracking.beginGatewayCapture } },
    );
    const observedRun = run.catch((error: unknown) => error);
    try {
      await streamStarted.promise;
      const retained = resolveMcpLoopbackClientGrant(capture);
      expect(retained?.isCurrent()).toBe(true);

      if (liveSession) {
        expect(operation.abortByUser()).toBe(true);
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
      await streamClosing.promise;

      expect(source.signal.aborted).toBe(false);
      expect(getAdmittedRunDelegatedAuthority(context.params.admittedRunContext)).toBeDefined();
      expect(retained?.isCurrent()).toBe(false);
      expect(resolveMcpLoopbackClientGrant(capture)).toBeUndefined();
    } finally {
      releaseCleanup.resolve();
      await observedRun;
      tracking.finalizeCapture(() => {});
      revokeMcpLoopbackClientGrant(grant.token);
      operation.complete();
    }
    expect(await observedRun).toMatchObject(
      liveSession ? { name: "AbortError" } : { reason: "overall-timeout", timedOut: true },
    );
  });
});
