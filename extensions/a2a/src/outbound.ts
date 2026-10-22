import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import { A2A_PROTOCOL_VERSION, A2A_VERSION_HEADER } from "./a2a-model.js";
import { resolveA2aChannelAccount } from "./accounts.js";

const A2A_OUTBOUND_TIMEOUT_MS = 30_000;

/**
 * `SendMessage` succeeds with either a `Message` or a `Task` (§7.1 oneof).
 *
 * The two are not interchangeable: a peer that answers directly creates no task
 * at all, so the correlation handle has to come from whichever branch it chose.
 */
const A2aOutboundMessageSchema = z.object({
  messageId: z.string().optional(),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
});

const A2aOutboundTaskSchema = z.object({
  id: z.string().optional(),
  contextId: z.string().optional(),
  status: z
    .object({
      state: z.string().optional(),
    })
    .optional(),
});

const A2aOutboundErrorInfoSchema = z.object({
  "@type": z.string().optional(),
  reason: z.string().optional(),
});

const A2aOutboundResponseSchema = z.object({
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.array(A2aOutboundErrorInfoSchema).optional(),
    })
    .optional(),
  result: z
    .object({
      task: A2aOutboundTaskSchema.optional(),
      message: A2aOutboundMessageSchema.optional(),
    })
    .passthrough()
    .optional(),
});

type A2aOutboundSendParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  assertDirectAdapterHandoff?: () => void;
};

export type A2aOutboundSendResult = {
  to: string;
  /** Correlation handle: the peer's task id when it made one, else its message id. */
  messageId: string;
  taskId?: string;
  contextId?: string;
  /**
   * Task state the peer reported. `input-required` and `auth-required` mean the
   * turn was accepted but is NOT finished (§6.3), which matters because a
   * fire-and-forget send would otherwise look identical to a completed one.
   */
  state?: string;
};

export async function sendA2aChannelText(
  params: A2aOutboundSendParams,
): Promise<A2aOutboundSendResult> {
  const account = resolveA2aChannelAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const peerName = params.to.replace(/^a2a:/i, "").trim();
  const peer = account.config.peers?.[peerName];
  if (!peer?.url) {
    throw new Error(`peer ${peerName} has no url configured for outbound A2A`);
  }
  if (account.unresolvedOutboundPeers.includes(peerName)) {
    // Fail before any I/O: sending without the authored credential would deliver the
    // message anonymously to a peer that was configured to require authentication.
    throw new Error(
      `peer ${peerName} outboundToken reference did not resolve; set the variable and reload before sending`,
    );
  }

  const messageId = randomUUID();
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // Declare the protocol version so a 1.0 peer does not fall back to 0.3.
    [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION,
  };
  if (peer.outboundToken) {
    headers.authorization = `Bearer ${peer.outboundToken}`;
  }

  const request = {
    jsonrpc: "2.0",
    id: requestId,
    method: "SendMessage",
    params: {
      message: {
        messageId,
        role: "ROLE_USER",
        contextId: `ctx-oc-${peerName}`,
        parts: [{ text: params.text }],
      },
      configuration: { returnImmediately: true },
    },
  };
  const signal = AbortSignal.timeout(A2A_OUTBOUND_TIMEOUT_MS);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Peer URLs are operator config, but they still leave the Gateway: the shared
    // guard keeps that egress on the same SSRF policy as every other plugin call.
    const { response, release } = await fetchWithSsrFGuard({
      url: peer.url,
      timeoutMs: A2A_OUTBOUND_TIMEOUT_MS,
      signal,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(peer.url),
      auditContext: "a2a.outbound_send",
      // A redirected A2A task could be delivered to an unintended agent.
      maxRedirects: 0,
      beforeRequest: params.assertDirectAdapterHandoff,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      },
    });
    try {
      if (!response.ok) {
        throw new Error(
          `outbound A2A request to peer ${peerName} failed (HTTP ${response.status})`,
        );
      }

      const parsed = A2aOutboundResponseSchema.safeParse(
        await readProviderJsonResponse(response, `peer ${peerName} A2A response`, {
          requestHeaders: headers,
        }),
      );
      if (!parsed.success) {
        throw new Error(`peer ${peerName} returned an invalid A2A JSON-RPC response`);
      }

      if (parsed.data.error) {
        if (attempt === 0 && parsed.data.error.code === -32601) {
          // Hermes-generation A2A 0.3 peers only expose the shipped dotted method.
          request.method = "message/send";
          continue;
        }
        // Prefer the stable ErrorInfo reason over the human-readable message so
        // callers can branch on e.g. TASK_NOT_CANCELABLE without string matching.
        const reason = parsed.data.error.data?.find((entry) => entry.reason)?.reason;
        throw new Error(
          `outbound A2A request to peer ${peerName} failed: ${parsed.data.error.message}` +
            (reason ? ` [${reason}]` : ""),
        );
      }

      if (!parsed.data.result) {
        throw new Error(`peer ${peerName} returned an A2A response without a result`);
      }

      const task = parsed.data.result.task;
      const message = parsed.data.result.message;

      return {
        to: params.to,
        // A compliant peer returns one branch of the oneof, but a success with no
        // handle still means the message was accepted. Falling back to the id we
        // generated beats throwing, which would misreport a delivered message as
        // failed and invite a duplicate send. A wholly absent `result` is the
        // genuine failure, and that is rejected above.
        messageId: task?.id ?? message?.messageId ?? messageId,
        ...(task?.id ? { taskId: task.id } : {}),
        ...((task?.contextId ?? message?.contextId)
          ? { contextId: task?.contextId ?? message?.contextId }
          : {}),
        ...(task?.status?.state ? { state: task.status.state } : {}),
      };
    } finally {
      // Each attempt owns its guard lease, including before the compatibility retry.
      await release();
    }
  }

  throw new Error(`outbound A2A request to peer ${peerName} exhausted its compatibility retry`);
}
