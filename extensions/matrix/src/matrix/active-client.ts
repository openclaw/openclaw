import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { normalizeAccountId } from "openclaw/plugin-sdk";

// Support multiple active clients for multi-account
const activeClients = new Map<string, MatrixClient>();

export function setActiveMatrixClient(
  client: MatrixClient | null,
  accountId?: string | null,
): void {
  const key = normalizeAccountId(accountId);
  if (client) {
    activeClients.set(key, client);
  } else {
    activeClients.delete(key);
  }
}

export function getActiveMatrixClient(accountId?: string | null): MatrixClient | null {
  const key = normalizeAccountId(accountId);
  return activeClients.get(key) ?? null;
}

export function getAnyActiveMatrixClient(): MatrixClient | null {
  // Return any available client (for backward compatibility)
  const first = activeClients.values().next();
  return first.done ? null : first.value;
}

export function clearAllActiveMatrixClients(): void {
  activeClients.clear();
}
