import { vi } from "vitest";
import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  setActiveEmbeddedRun,
} from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

export const sessionId = "authority-session";
export const sessionKey = "agent:main:main";
export const own: ReplyToolAuthorityOverlay = {
  senderIsOwner: true,
  disableTools: false,
  traceAuthorized: false,
  messageProvider: "webchat",
  senderId: "authority-requester",
};
export const attempt = {
  sessionId,
  sessionKey,
  runId: "authority-run",
  agentId: "main",
  config: {},
  sessionFile: "/tmp/authority-session.jsonl",
  workspaceDir: "/tmp/authority-workspace",
  provider: "openai",
  modelId: "gpt-test",
  sandboxSessionKey: sessionKey,
  senderIsOwner: true,
  messageProvider: "webchat",
  senderId: "authority-requester",
  traceAuthorized: false,
};

export async function admitted<T>(
  run: (context: {
    admittedRunContext: Awaited<ReturnType<ReturnType<typeof prepareAgentRunAdmission>["admit"]>>;
    close: () => void;
  }) => Promise<T>,
  operatorAuthority?: Parameters<typeof prepareAgentRunAdmission>[0]["operatorAuthority"],
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(attempt.runId),
    operatorAuthority,
    facts: {
      agentId: "main",
      runId: attempt.runId,
      ingress: { kind: "system", state: "present", boundary: "tool-authority-test" },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", "authority-test"),
      close: admission.close,
    });
  } finally {
    admission.close();
  }
}

export function publishPreparedHandle(
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

export async function published<T>(
  run: (owner: {
    handle: ReturnType<typeof createEmbeddedRunHandle>;
    queue: ReturnType<typeof vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>>;
    close: () => void;
  }) => Promise<T>,
  params: Partial<typeof attempt> &
    Pick<
      ReplyToolAuthorityOverlay,
      "toolsAllow" | "senderId" | "senderName" | "clientCaps" | "gatewayUiCommandTarget"
    > = {},
  operatorAuthority?: Parameters<typeof prepareAgentRunAdmission>[0]["operatorAuthority"],
) {
  return admitted(
    async ({ admittedRunContext, close }) =>
      withPreparedEmbeddedRunToolAuthority(
        { admittedRunContext },
        { ...attempt, ...params },
        undefined,
        async (prepared) => {
          const queue = vi.fn<ReturnType<typeof createEmbeddedRunHandle>["queueMessage"]>(
            async () => {},
          );
          const handle = publishPreparedHandle(prepared.toolAuthorityFingerprint, queue);
          try {
            return await run({ handle, queue, close });
          } finally {
            clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          }
        },
      ),
    operatorAuthority,
  );
}

export function steer(overlay: ReplyToolAuthorityOverlay, hash?: string) {
  return queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, "Use the release branch", {
    isInboundUserMessage: true,
    toolAuthorityOverlay: overlay,
    toolAuthorityFingerprint: hash,
    taskSuggestionDeliveryMode: undefined,
  });
}
