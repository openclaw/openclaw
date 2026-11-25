import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import type { ReplyToolAuthorityOverlay } from "../../sessions/session-controller.contracts.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "./tool-authority.runtime.js";

export const sessionId = "authority-session";
export const sessionKey = "agent:main:main";
export function createDirectReplyOperation() {
  return createReplyOperation({ sessionId, sessionKey, resetTriggered: false, turnKind: "direct" });
}

type EmbeddedRunHandle = ReturnType<typeof createEmbeddedRunHandle>;
type QueueMessage = EmbeddedRunHandle["queueMessage"];
type QueueMock = ReturnType<typeof vi.fn<QueueMessage>>;
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

export function expectOutcome(
  pending: PromiseLike<unknown>,
  ...expected: [status: "accepted" | "failed" | "answered"] | [status: "rejected", reason: string]
) {
  const [status, reason] = expected;
  return expect(pending).resolves.toMatchObject({
    status,
    ...(reason === undefined ? {} : { reason }),
  });
}

type AuthorityAttempt = Parameters<typeof withPreparedEmbeddedRunToolAuthority>[1];
function withAuthority<T>(
  admittedRunContext: AdmittedRunContext,
  run: Parameters<typeof withPreparedEmbeddedRunToolAuthority<T, AuthorityAttempt>>[3],
  params: AuthorityAttempt = attempt,
) {
  return withPreparedEmbeddedRunToolAuthority({ admittedRunContext }, params, undefined, run);
}

export async function admitted<T>(
  run: (context: { admittedRunContext: AdmittedRunContext; close: () => void }) => Promise<T>,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  options: {
    config?: OpenClawConfig;
    runId?: string;
    boundary?: string;
  } = {},
) {
  const runId = options.runId ?? attempt.runId;
  const boundary = options.boundary ?? "tool-authority-test";
  const admission = prepareAgentRunAdmission({
    cfg: options.config ?? {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    operatorAuthority,
    facts: {
      agentId: "main",
      runId,
      ingress: { kind: "system", state: "present", boundary },
    },
  });
  try {
    return await run({
      admittedRunContext: await admission.admit("embedded", options.boundary ?? "authority-test"),
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
  interceptMessages(handle, (text, options) => queueMessage(text, options));
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
  run: (owner: { handle: EmbeddedRunHandle; queue: QueueMock; close: () => void }) => Promise<T>,
  params: Partial<typeof attempt> &
    Pick<
      ReplyToolAuthorityOverlay,
      "toolsAllow" | "senderId" | "senderName" | "clientCaps" | "gatewayUiCommandTarget"
    > = {},
  operatorAuthority?: AdmittedRunOperatorAuthority,
  configureHandle?: (handle: EmbeddedRunHandle, queueMessage: QueueMessage) => void,
) {
  return admitted(
    async ({ admittedRunContext, close }) =>
      withAuthority(
        admittedRunContext,
        async (prepared) => {
          const queue = vi.fn<QueueMessage>(async () => {});
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
        { ...attempt, ...params },
      ),
    operatorAuthority,
  );
}
