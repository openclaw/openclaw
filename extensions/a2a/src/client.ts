/**
 * A2A Client — call remote A2A agents.
 *
 * Uses @a2a-js/sdk/client for Agent Card discovery and message sending.
 */

import type { AgentCard, Message, Task } from "@a2a-js/sdk";
import type { A2APeer } from "./config.js";

// ── Agent Card fetching ────────────────────────────────────────────

/** Fetch an Agent Card from a remote URL. */
export async function fetchAgentCard(
  agentCardUrl: string,
  auth?: { type: "bearer"; token: string },
): Promise<AgentCard> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (auth?.type === "bearer" && auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  const res = await fetch(agentCardUrl, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch Agent Card from ${agentCardUrl}: ${res.status} ${res.statusText}`,
    );
  }
  return (await res.json()) as AgentCard;
}

// ── Message sending ────────────────────────────────────────────────

export type SendMessageResult = {
  taskId?: string;
  status: string;
  reply?: string;
  error?: string;
};

/**
 * Send a message to a remote A2A agent via JSON-RPC.
 * Uses direct fetch (no SDK client dependency) for simplicity.
 */
export async function sendMessageToPeer(params: {
  peer: A2APeer;
  message: string;
  agentId?: string;
  blocking?: boolean;
  timeoutMs?: number;
}): Promise<SendMessageResult> {
  const { peer, message, agentId, blocking = true, timeoutMs = 300_000 } = params;

  // Resolve JSON-RPC endpoint from Agent Card
  const card = await fetchAgentCard(peer.agentCardUrl, peer.auth);
  const jsonRpcUrl = card.url;
  if (!jsonRpcUrl) {
    throw new Error(`Agent Card for "${peer.name}" has no url field`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (peer.auth?.type === "bearer" && peer.auth.token) {
    headers.Authorization = `Bearer ${peer.auth.token}`;
  }

  // Build A2A message (v0.3.0 requires kind + messageId)
  const a2aMessage = {
    kind: "message" as const,
    messageId: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ kind: "text" as const, text: message }],
    ...(agentId ? { metadata: { "openclaw.agentId": agentId } } : {}),
  };

  const rpcRequest = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: a2aMessage,
      configuration: { blocking },
    },
  };

  const res = await fetch(jsonRpcUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(rpcRequest),
    signal: AbortSignal.timeout(blocking ? timeoutMs : 30_000),
  });

  if (!res.ok) {
    throw new Error(`A2A JSON-RPC failed: ${res.status} ${res.statusText}`);
  }

  const rpcResponse = (await res.json()) as {
    result?: Task;
    error?: { code: number; message: string };
  };

  if (rpcResponse.error) {
    return {
      status: "error",
      error: `${rpcResponse.error.code}: ${rpcResponse.error.message}`,
    };
  }

  const task = rpcResponse.result;
  if (!task) {
    return { status: "error", error: "No task in response" };
  }

  // If blocking, the reply should be in the final status
  const replyText = extractReplyFromTask(task);

  // If non-blocking and not yet done, poll
  if (!blocking && task.status?.state === "working") {
    return pollUntilDone({ jsonRpcUrl, headers, taskId: task.id, timeoutMs });
  }

  return {
    taskId: task.id,
    status: task.status?.state ?? "unknown",
    reply: replyText,
  };
}

// ── Polling for async tasks ────────────────────────────────────────

async function pollUntilDone(params: {
  jsonRpcUrl: string;
  headers: Record<string, string>;
  taskId: string;
  timeoutMs: number;
}): Promise<SendMessageResult> {
  const { jsonRpcUrl, headers, taskId, timeoutMs } = params;
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2000;
  const terminalStates = new Set(["completed", "failed", "canceled"]);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const rpcRequest = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tasks/get",
      params: { id: taskId },
    };

    const res = await fetch(jsonRpcUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(rpcRequest),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) continue;

    const rpcResponse = (await res.json()) as { result?: Task };
    const task = rpcResponse.result;
    if (!task?.status) continue;

    if (terminalStates.has(task.status.state)) {
      return {
        taskId: task.id,
        status: task.status.state,
        reply: extractReplyFromTask(task),
      };
    }
  }

  return { taskId, status: "timeout", error: "Polling timed out" };
}

// ── Peer health check ─────────────────────────────────────────────

export type PeerHealthResult = {
  name: string;
  reachable: boolean;
  agentName?: string;
  protocolVersion?: string;
  skills?: string[];
  streaming?: boolean;
  latencyMs: number;
  error?: string;
};

/**
 * Check if a remote peer is reachable by fetching its Agent Card.
 * Returns health information including latency and capabilities.
 */
export async function checkPeerHealth(peer: A2APeer): Promise<PeerHealthResult> {
  const start = Date.now();
  try {
    const card = await fetchAgentCard(peer.agentCardUrl, peer.auth);
    const latencyMs = Date.now() - start;
    return {
      name: peer.name,
      reachable: true,
      agentName: card.name,
      protocolVersion: card.protocolVersion,
      skills: card.skills?.map((s) => s.name),
      streaming: card.capabilities?.streaming ?? false,
      latencyMs,
    };
  } catch (err) {
    return {
      name: peer.name,
      reachable: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Reply extraction ───────────────────────────────────────────────

function extractReplyFromTask(task: Task): string | undefined {
  // Try status message first
  const statusMsg = task.status?.message;
  if (statusMsg?.parts) {
    const texts = statusMsg.parts
      .filter((p) => p.kind === "text")
      .map((p) => ("text" in p ? (p as { text: string }).text : ""));
    if (texts.length > 0) return texts.join("\n").trim();
  }

  // Fall back to artifacts
  if (task.artifacts && task.artifacts.length > 0) {
    const parts = task.artifacts.flatMap((a) => a.parts ?? []);
    const texts = parts
      .filter((p) => p.kind === "text")
      .map((p) => ("text" in p ? (p as { text: string }).text : ""));
    if (texts.length > 0) return texts.join("\n").trim();
  }

  return undefined;
}
