import { createAgentMailClient } from "./client.js";
import type { ResolvedAgentMailAccount } from "./types.js";

export type AgentMailProbe = {
  ok: boolean;
  inboxId: string;
  ingressMode: "webhook" | "websocket";
  error?: string;
};

export async function probeAgentMailAccount(params: {
  account: ResolvedAgentMailAccount;
}): Promise<AgentMailProbe> {
  try {
    await createAgentMailClient(params.account).inboxes.get(params.account.inboxId);
    return {
      ok: true,
      inboxId: params.account.inboxId,
      ingressMode: params.account.webhookSecret ? "webhook" : "websocket",
    };
  } catch (error) {
    return {
      ok: false,
      inboxId: params.account.inboxId,
      ingressMode: params.account.webhookSecret ? "webhook" : "websocket",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
