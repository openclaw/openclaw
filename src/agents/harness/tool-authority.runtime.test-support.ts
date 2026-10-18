import { vi } from "vitest";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

export const sessionId = "authority-session";
export const sessionKey = "agent:main:main";
type EmbeddedRunHandle = ReturnType<typeof createEmbeddedRunHandle>;
type QueueMessage = EmbeddedRunHandle["queueMessage"];
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
  queueMessage: QueueMessage,
  configure?: (handle: EmbeddedRunHandle, queueMessage: QueueMessage) => void,
) {
  const handle = createEmbeddedRunHandle({
    runId: attempt.runId,
    toolAuthorityFingerprint,
    queueMessage,
    supportsTranscriptCommitWait: true,
  });
  handle.kind = "embedded";
  handle.cancel = (reason) => handle.abort(reason === "restart" ? reason : undefined);
  // Host-prepared tool authority binds every steer to final dispatch, as real runtimes do.
  handle.messageInjectionV2 = {
    version: 2,
    isAvailable: () => true,
    queueMessage: async (text, options, assertCurrent) => {
      assertCurrent();
      return queueMessage(text, options);
    },
  };
  configure?.(handle, queueMessage);
  setActiveEmbeddedRun(sessionId, handle, sessionKey, attempt.sessionFile);
  return handle;
}

export function interceptMessages(
  handle: EmbeddedRunHandle,
  receive: NonNullable<EmbeddedRunHandle["messageInjectionV2"]>["queueMessage"],
) {
  handle.messageInjectionV2 = {
    version: 2,
    isAvailable: () => true,
    queueMessage: async (text, options, assertCurrent, authorityKind) => {
      assertCurrent();
      return receive(text, options, assertCurrent, authorityKind);
    },
  };
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
  configureHandle?: (handle: EmbeddedRunHandle, queueMessage: QueueMessage) => void,
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
          const handle = publishPreparedHandle(
            prepared.toolAuthorityFingerprint,
            queue,
            configureHandle,
          );
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
