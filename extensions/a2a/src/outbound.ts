import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import { DEFAULT_ACCOUNT_ID, resolveA2aChannelAccount } from "./accounts.js";
import { a2aPeerScope, currentReceiptGeneration, recordAcceptedSend } from "./task-receipts.js";

const A2A_OUTBOUND_TIMEOUT_MS = 30_000;

const A2aOutboundResponseSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
  result: z.unknown().optional(),
});

const A2aSendResultSchema = z.object({
  task: z.object({ id: z.string().optional(), contextId: z.string().optional() }).optional(),
});

type A2aOutboundSendParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  assertDirectAdapterHandoff?: () => void;
  /**
   * Set by a caller that reconciles the task-read receipt store itself once the peer's
   * task ID is known (the task action does). Without it this surface revokes: it carries
   * no session identity, so it can never mint a source-bound receipt.
   */
  deferReceiptReconcile?: boolean;
};

export function resolveA2aOutboundPeer(
  params: Pick<A2aOutboundSendParams, "cfg" | "accountId" | "to">,
) {
  const account = resolveA2aChannelAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!account.enabled || account.accountId !== DEFAULT_ACCOUNT_ID) {
    throw new Error("A2A outbound tasks require the enabled default account");
  }
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

  return { accountId: account.accountId, peerName, peer: { ...peer, url: peer.url } };
}

export async function requestA2aPeer(
  params: Pick<A2aOutboundSendParams, "cfg" | "accountId" | "to"> & {
    method: "SendMessage" | "GetTask";
    rpcParams: unknown;
    assertCurrent?: () => void;
  },
): Promise<{ result: unknown; correlated: boolean }> {
  const { peerName, peer } = resolveA2aOutboundPeer(params);
  const requestId = randomUUID();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (peer.outboundToken) {
    headers.authorization = `Bearer ${peer.outboundToken}`;
  }

  const request: { jsonrpc: string; id: string; method: string; params: unknown } = {
    jsonrpc: "2.0",
    id: requestId,
    method: params.method,
    params: params.rpcParams,
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
      auditContext: params.method === "SendMessage" ? "a2a.outbound_send" : "a2a.outbound_read",
      // A redirected A2A task could be delivered to an unintended agent.
      maxRedirects: 0,
      beforeRequest: params.assertCurrent,
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
          ...(params.method === "GetTask" ? { maxBytes: 1024 * 1024 } : {}),
        }),
      );
      if (!parsed.success) {
        throw new Error(`peer ${peerName} returned an invalid A2A JSON-RPC response`);
      }

      const correlated = parsed.data.jsonrpc === "2.0" && parsed.data.id === requestId;
      if (params.method === "GetTask" && !correlated) {
        throw new Error(`peer ${peerName} returned an uncorrelated A2A JSON-RPC response`);
      }

      if (parsed.data.error) {
        if (attempt === 0 && parsed.data.error.code === -32601) {
          // A2A 0.3 peers expose slash-style compatibility methods.
          request.method = params.method === "SendMessage" ? "message/send" : "tasks/get";
          continue;
        }
        throw new Error(
          `outbound A2A request to peer ${peerName} failed: ${params.method === "GetTask" ? `JSON-RPC error ${parsed.data.error.code}` : parsed.data.error.message}`,
        );
      }

      if (!Object.hasOwn(parsed.data, "result")) {
        throw new Error(`peer ${peerName} returned an A2A response without a result`);
      }

      return { result: parsed.data.result, correlated };
    } finally {
      // Each attempt owns its guard lease, including before the compatibility retry.
      await release();
    }
  }

  throw new Error(`outbound A2A request to peer ${peerName} exhausted its compatibility retry`);
}

export async function sendA2aChannelText(params: A2aOutboundSendParams): Promise<{
  to: string;
  messageId: string;
  taskId?: string;
  contextId: string;
}> {
  const messageId = randomUUID();
  const { accountId, peerName, peer } = resolveA2aOutboundPeer(params);
  const contextId = `ctx-oc-${peerName}`;
  const response = await requestA2aPeer({
    ...params,
    method: "SendMessage",
    rpcParams: {
      message: { messageId, role: "ROLE_USER", contextId, parts: [{ text: params.text }] },
      configuration: { returnImmediately: true },
    },
    assertCurrent: params.assertDirectAdapterHandoff,
  });
  const result = A2aSendResultSchema.safeParse(response.result);
  if (!result.success) {
    throw new Error("peer returned an invalid A2A SendMessage result");
  }
  // Preserve legacy send receipts, but only a correlated response can grant task reads.
  const taskId = response.correlated ? result.data.task?.id : undefined;
  // This surface carries no agent/session identity, so it can never install a receipt. It
  // still has to reconcile the store: a peer that reports an ID already known from another
  // source must not leave that older session able to read this task. A caller that owns
  // receipt minting defers that reconcile so it can still see the collision.
  if (!params.deferReceiptReconcile) {
    recordAcceptedSend({
      peerScope: a2aPeerScope({
        accountId,
        peerName,
        url: peer.url,
        outboundToken: peer.outboundToken,
      }),
      taskId,
      source: undefined,
      contextId: result.data.task?.contextId ?? contextId,
      generation: currentReceiptGeneration(),
    });
  }
  return {
    to: params.to,
    messageId: result.data.task?.id ?? messageId,
    taskId,
    contextId: result.data.task?.contextId ?? contextId,
  };
}
