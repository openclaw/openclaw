import type { WASocket } from "baileys";
import { vi } from "vitest";
import { DEFAULT_WHATSAPP_SOCKET_TIMING } from "../socket-timing.js";
import { createWebSendApi } from "./send-api.js";
import { createWhatsAppAttachedSocketSession } from "./socket-session.js";
import type { ActiveWebListener } from "./types.js";

export async function createAttachedTestListener(params: {
  accountId: string;
  authDir: string;
  sendMessage: WASocket["sendMessage"];
  fetchAccountReachoutTimelock: () => Promise<{ isActive: boolean }>;
}): Promise<ActiveWebListener> {
  const session = await createWhatsAppAttachedSocketSession({
    sock: {
      sendMessage: params.sendMessage,
      sendPresenceUpdate: vi.fn(async () => undefined),
      fetchAccountReachoutTimelock: params.fetchAccountReachoutTimelock,
      authState: { creds: { accountSyncCounter: 0 } },
      user: { id: "15555550199:1@s.whatsapp.net" },
    } as unknown as WASocket,
    accountId: params.accountId,
    authDir: params.authDir,
    socketTiming: DEFAULT_WHATSAPP_SOCKET_TIMING,
    logVerbose: () => {},
    logConnectionError: () => {},
  });
  return {
    ...createWebSendApi({ sock: session.socketOperations, defaultAccountId: params.accountId }),
    assertSendReady: session.assertSendReady,
  };
}
