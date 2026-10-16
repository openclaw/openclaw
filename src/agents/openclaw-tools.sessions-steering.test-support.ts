import { afterEach, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
  type EmbeddedAgentQueueMessageOptions,
} from "./embedded-agent-runner/runs.js";
import { withPreparedEmbeddedRunToolAuthority } from "./harness/tool-authority.runtime.js";
import { captureRequesterOrigin } from "./requester-origin.js";

export function createSessionsSendTestCaller(sessionKey = "agent:re-portal:main") {
  const requesterOrigin = captureRequesterOrigin({
    sessionKey,
    messageProvider: "telegram",
    senderId: "sessions-requester",
  });
  if (!requesterOrigin) {
    throw new Error("sessions-send fixture requires a requester session");
  }
  return {
    agentId: parseAgentSessionKey(sessionKey)?.agentId ?? "main",
    sessionKey,
    requesterOrigin,
  };
}

const activeOwners: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(activeOwners.splice(0).map((close) => close()));
});

/** Publish through the same admitted attempt owner as the runtime under test. */
export async function setSessionsSendTestActiveRun(
  sessionId: string,
  handle: EmbeddedAgentQueueHandle,
  sessionKey: string,
  requesterSessionKey: string | undefined,
  config: OpenClawConfig,
) {
  const caller = createSessionsSendTestCaller(requesterSessionKey);
  const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? "main";
  const runId = handle.runId ?? `sessions-target:${sessionId}`;
  const sessionFile = `/tmp/${sessionId}.jsonl`;
  const admission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      agentId,
      runId,
      ingress: { kind: "system", state: "present", boundary: "sessions-send-test" },
    },
  });
  const ready = createDeferred();
  const closed = createDeferred();
  const completion = (async () => {
    try {
      await withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext: await admission.admit("embedded", "sessions-send-test") },
        {
          sessionId,
          sessionKey,
          runId,
          agentId,
          sessionFile,
          workspaceDir: "/tmp/sessions-send-test",
          config,
          provider: "openai",
          modelId: "gpt-test",
          requesterOrigin: caller.requesterOrigin,
        },
        undefined,
        async (prepared) => {
          handle.runId = runId;
          handle.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
          setActiveEmbeddedRun(sessionId, handle, sessionKey, sessionFile);
          ready.resolve();
          await closed.promise;
        },
      );
    } catch (error) {
      ready.reject(error);
      throw error;
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
      admission.close();
    }
  })();
  // The owner stays open through the test; cleanup joins any late failure.
  void completion.catch(() => {});
  activeOwners.push(async () => {
    closed.resolve();
    await completion;
  });
  await ready.promise;
}

export async function activeRun(
  sessionKey: string,
  options: {
    config: OpenClawConfig;
    sessionId?: string;
    requesterSessionKey?: string;
    streaming?: boolean;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    rejects?: boolean;
  },
) {
  const queueMessage = vi.fn(async (_text: string, _options?: EmbeddedAgentQueueMessageOptions) => {
    if (options.rejects) {
      throw new Error("active session ended before queued steering message was committed");
    }
  });
  await setSessionsSendTestActiveRun(
    options.sessionId ?? "caller-active-session",
    {
      queueMessage,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => options.streaming ?? true,
        queueMessage: async (text, queueOptions, assertCurrent) => {
          assertCurrent();
          await queueMessage(text, queueOptions);
          queueOptions?.onQueueAccepted?.(true);
        },
      },
      isStreaming: () => options.streaming ?? true,
      isCompacting: () => false,
      supportsTranscriptCommitWait: true,
      sourceReplyDeliveryMode: options.sourceReplyDeliveryMode ?? "message_tool_only",
      abort: () => {},
    },
    sessionKey,
    options.requesterSessionKey,
    options.config,
  );
  return queueMessage;
}
