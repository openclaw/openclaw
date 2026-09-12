import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { createOperationalRunInstanceRef, prepareAgentRunAdmission } from "../admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle, testing } from "../embedded-agent-runner/runs.test-support.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

/**
 * Authority-chain proof for the retired-operation fallback (#139847).
 *
 * The regression test in `tool-authority.runtime.test.ts` proves the wrapper
 * survives a retired captured reply operation. These tests prove the fallback
 * authority is a real, working authority chain end to end on a real admitted
 * turn: it steers the run (continuation), it does not amplify authority
 * (weaker caller), it dies with the admission (cancellation), and it cannot
 * be borrowed by a superseding run (replaced ownership).
 */

const sessionId = "authority-chain-session";
const sessionKey = "agent:main:main";
const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
};
const attempt = {
  sessionId,
  sessionKey,
  runId: "authority-chain-run",
  agentId: "main",
  config: {},
  sessionFile: "/tmp/authority-chain-session.jsonl",
  workspaceDir: "/tmp/authority-chain-workspace",
  provider: "openai",
  modelId: "gpt-test",
  sandboxSessionKey: sessionKey,
  senderIsOwner: true,
  messageProvider: "webchat",
  traceAuthorized: false,
};

async function admitted<T>(
  run: (context: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    close: () => void;
  }) => Promise<T>,
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    facts: {
      agentId: "main",
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "tool-authority-chain-test" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "authority-chain-test"),
      close: admission.close,
    });
  } finally {
    admission.close();
  }
}

function publishPreparedHandle(
  toolAuthorityFingerprint: string | undefined,
  queueMessage: ReturnType<typeof createEmbeddedRunHandle>["queueMessage"],
) {
  const handle = createEmbeddedRunHandle({
    runId: attempt.runId,
    toolAuthorityFingerprint,
    queueMessage,
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
  return handle;
}

function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  });
}

/**
 * Runs the wrapper against a real admitted turn whose captured reply operation
 * has been retired (the exact #139847 sequence: a message sent while an earlier
 * reply run was active retires that operation before this attempt binds its
 * route). The wrapper must fall back to the direct prepared authority; the
 * assertions below exercise what happens downstream of that fallback.
 */
async function retiredFallback<T>(
  run: (owner: {
    handle: ReturnType<typeof createEmbeddedRunHandle>;
    queue: ReturnType<typeof vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>>;
    prepared: { toolAuthorityFingerprint?: string };
  }) => Promise<T>,
  params: Partial<typeof attempt> = {},
) {
  const retired = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  retired.complete();
  return admitted(async ({ admittedRunContext }) =>
    withPreparedEmbeddedRunToolAuthority(
      { admittedRunContext, replyOperation: retired },
      { ...attempt, toolAuthorityFingerprint: "stale-fingerprint", ...params },
      undefined,
      async (prepared) => {
        const queue = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
          async () => {},
        );
        const handle = publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
        try {
          return await run({ handle, queue, prepared });
        } finally {
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      },
    ),
  );
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
  vi.restoreAllMocks();
});

describe("authority chain after the retired-operation fallback (#139847)", () => {
  it("lets the admitted turn continue end-to-end: the fallback authority steers the run", async () => {
    await retiredFallback(async ({ handle, queue, prepared }) => {
      // The stale captured fingerprint was NOT used; the fallback bound a fresh
      // direct-prepared fingerprint.
      expect(prepared.toolAuthorityFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(prepared.toolAuthorityFingerprint).not.toBe("stale-fingerprint");
      // Steering I/O flows through the fallback authority on the real admitted turn.
      await expect(steer(own, handle.toolAuthorityFingerprint)).resolves.toMatchObject({
        queued: true,
      });
      expect(queue).toHaveBeenCalledOnce();
    });
  });

  it("still rejects a weaker caller: the fallback does not amplify authority", async () => {
    await retiredFallback(
      async ({ handle, queue }) => {
        // Same fallback authority, but a caller that the configured policy ranks
        // below the owner must not ride it. The policy fixture matches the
        // production guard's own weaker-sender test (toolsBySender allow: []).
        await expect(
          steer({ ...own, senderIsOwner: false }, handle.toolAuthorityFingerprint),
        ).resolves.toMatchObject({ queued: false, reason: "tool_authority_mismatch" });
        expect(queue).not.toHaveBeenCalled();
      },
      { config: { tools: { toolsBySender: { "*": { allow: [] } } } } },
    );
  });

  it("cancels the fallback authority when the admission closes mid-turn", async () => {
    const retired = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    retired.complete();
    await admitted(async ({ admittedRunContext, close }) => {
      let retained: ReturnType<typeof getGatewayToolCallerIdentity>;
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext, replyOperation: retired },
        { ...attempt, toolAuthorityFingerprint: "stale-fingerprint" },
        undefined,
        async (prepared) => {
          const queue = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
            async () => {},
          );
          const handle = publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
          retained = getGatewayToolCallerIdentity();
          // Real cancellation path: the reply operation's admission is closed
          // while the fallback authority is live.
          close();
          expect((await steer(own)).queued).toBe(false);
          // The closed claim cannot even (re)publish a run handle.
          await expect(
            withGatewayToolCallerIdentity(retained, () =>
              setActiveEmbeddedRun(
                sessionId,
                createEmbeddedRunHandle({ runId: attempt.runId }),
                sessionKey,
                attempt.sessionFile,
              ),
            ),
          ).rejects.toThrow("no longer active");
          expect(queue).not.toHaveBeenCalled();
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        },
      );
    });
  });

  it("does not let a superseding run borrow the fallback authority mid-projection", async () => {
    await retiredFallback(async ({ handle, queue }) => {
      const successorQueue = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
        async () => {},
      );
      const overlay = {
        ...own,
        get permissionMode() {
          // A new run takes over the session while the fallback authority
          // projects; neither handle may receive the message.
          withoutGatewayToolCallerIdentity(() =>
            setActiveEmbeddedRun(
              sessionId,
              createEmbeddedRunHandle({ runId: "superseding-run", queueMessage: successorQueue }),
              sessionKey,
            ),
          );
          return undefined;
        },
      };
      expect((await steer(overlay, handle.toolAuthorityFingerprint)).queued).toBe(false);
      expect(queue).not.toHaveBeenCalled();
      expect(successorQueue).not.toHaveBeenCalled();
      void handle;
    });
  });
});
