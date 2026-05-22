import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { n as PollInput } from "./polls-Bs8s7Yj_.js";
import { AgentToolResult } from "@mariozechner/pi-agent-core";

//#region extensions/whatsapp/src/action-runtime-target-auth.d.ts
declare function resolveAuthorizedWhatsAppOutboundTarget(params: {
  cfg: OpenClawConfig;
  chatJid: string;
  accountId?: string;
  actionLabel: string;
}): {
  to: string;
  accountId: string;
};
//#endregion
//#region extensions/whatsapp/src/send.d.ts
declare function sendMessageWhatsApp(to: string, body: string, options: {
  verbose: boolean;
  cfg: OpenClawConfig;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  gifPlayback?: boolean;
  audioAsVoice?: boolean;
  accountId?: string;
  quotedMessageKey?: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
    messageText?: string;
  };
  preserveLeadingWhitespace?: boolean;
}): Promise<{
  messageId: string;
  toJid: string;
}>;
declare function sendTypingWhatsApp(to: string, options: {
  cfg: OpenClawConfig;
  accountId?: string;
}): Promise<void>;
declare function sendReactionWhatsApp(chatJid: string, messageId: string, emoji: string, options: {
  verbose: boolean;
  fromMe?: boolean;
  participant?: string;
  accountId?: string;
  cfg: OpenClawConfig;
}): Promise<void>;
declare function sendPollWhatsApp(to: string, poll: PollInput, options: {
  verbose: boolean;
  accountId?: string;
  cfg: OpenClawConfig;
}): Promise<{
  messageId: string;
  toJid: string;
}>;
//#endregion
//#region extensions/whatsapp/src/action-runtime.d.ts
declare const whatsAppActionRuntime: {
  resolveAuthorizedWhatsAppOutboundTarget: typeof resolveAuthorizedWhatsAppOutboundTarget;
  sendReactionWhatsApp: typeof sendReactionWhatsApp;
};
declare function handleWhatsAppAction(params: Record<string, unknown>, cfg: OpenClawConfig): Promise<AgentToolResult<unknown>>;
//#endregion
export { sendReactionWhatsApp as a, sendPollWhatsApp as i, whatsAppActionRuntime as n, sendTypingWhatsApp as o, sendMessageWhatsApp as r, handleWhatsAppAction as t };