import type { ChannelPlugin, PluginRuntime } from "openclaw/plugin-sdk";
import { startEmail, stopEmail, sendEmail } from "./runtime.js";

let runtime: PluginRuntime | null = null;

interface EmailAccount {
  accountId?: string;
  enabled?: boolean;
  imap: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
  };
  checkInterval?: number;
  allowedSenders?: string[];
}

// Store email context for outbound messaging
const emailContexts = new Map<string, { fromEmail: string; subject: string; messageId: string }>();

export function setEmailRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getEmailRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Email runtime not initialized - plugin not registered");
  }
  return runtime;
}

export function getEmailContext(sessionKey: string) {
  return emailContexts.get(sessionKey);
}

const emailPlugin: ChannelPlugin<EmailAccount> = {
  id: "email",
  meta: {
    id: "email",
    label: "Email",
    selectionLabel: "Email (IMAP/SMTP)",
    docsPath: "/channels/email",
    blurb: "Send and receive email via IMAP/SMTP servers.",
    aliases: ["mail", "smtp"],
  },
  capabilities: {
    chatTypes: ["direct"],
  },
  config: {
    listAccountIds: (cfg) => {
      const accounts = cfg.channels?.email?.accounts;
      return accounts ? Object.keys(accounts) : [];
    },
    resolveAccount: (cfg, accountId) => {
      const accounts = cfg.channels?.email?.accounts;
      const account = accounts?.[accountId || "default"] || accounts?.default || {};
      return {
        accountId: accountId || "default",
        enabled: account.enabled ?? true,
        ...account,
      } as EmailAccount;
    },
    isConfigured: (account) => {
      return Boolean(
        account.imap?.host &&
        account.imap?.port &&
        account.imap?.user &&
        account.imap?.password &&
        account.smtp?.host &&
        account.smtp?.port &&
        account.smtp?.user &&
        account.smtp?.password,
      );
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as EmailAccount;

      if (!account || !account.enabled) {
        ctx.log?.info?.(`[${account.accountId}] Email account disabled`);
        return;
      }

      if (
        !account.imap?.host ||
        !account.imap?.port ||
        !account.imap?.user ||
        !account.imap?.password
      ) {
        ctx.log?.error?.(`[${account.accountId}] Email IMAP configuration incomplete`);
        return;
      }

      if (
        !account.smtp?.host ||
        !account.smtp?.port ||
        !account.smtp?.user ||
        !account.smtp?.password
      ) {
        ctx.log?.error?.(`[${account.accountId}] Email SMTP configuration incomplete`);
        return;
      }

      ctx.log?.info?.(`[${account.accountId}] Starting email channel`);

      // Log allowed senders configuration
      if (account.allowedSenders && account.allowedSenders.length > 0) {
        ctx.log?.info?.(
          `[${account.accountId}] Only accepting emails from: ${account.allowedSenders.join(", ")}`,
        );
      } else {
        ctx.log?.info?.(`[${account.accountId}] Accepting emails from all senders`);
      }

      startEmail(
        account.accountId || "default",
        account,
        async (from, fromEmail, subject, body, messageId, uid) => {
          // Build formatted message envelope
          const message = `From: ${from}\nSubject: ${subject}\n\n${body}`;

          // Use fromEmail as sessionKey so all emails from the same sender are in one conversation
          const sessionKey = `email:${fromEmail}`;

          // Create a readable title for the session in Dashboard
          const title = `📧 ${fromEmail}${subject ? ` - ${subject}` : ""}`;

          ctx.log?.info?.(
            `[${account.accountId}] Processing email from ${fromEmail}: "${subject}" (UID: ${uid})`,
          );

          try {
            // Store email context for outbound messaging
            emailContexts.set(sessionKey, { fromEmail, subject, messageId });

            // Check if channelRuntime is available (Plugin SDK 2026.2.19+)
            // Gracefully handle older SDK versions with a warning instead of throwing
            if (!ctx.channelRuntime) {
              ctx.log?.warn?.(
                `[${account.accountId}] channelRuntime not available - requires Plugin SDK 2026.2.19+. Skipping AI response.`,
              );
              return;
            }

            // Use channelRuntime to dispatch the message
            const core = ctx.channelRuntime;

            // Use the dispatch function to process the message
            const result = await core.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: {
                Body: message,
                RawBody: body,
                CommandBody: body,
                From: `email:${fromEmail}`,
                To: `${account.accountId || "default"}:${fromEmail}|${subject}|${messageId}`, // Format: "accountId:email|subject|messageId"
                SessionKey: sessionKey,
                AccountId: account.accountId,
                ChatType: "direct" as const,
                ConversationLabel: from,
                SenderName: from,
                SenderId: fromEmail,
                Provider: "email",
                Surface: "email",
                MessageSid: messageId,
                Timestamp: Date.now(),
              },
              cfg: ctx.cfg,
              dispatcherOptions: {
                responsePrefix: undefined,
                humanDelay: core.reply.resolveHumanDelayConfig(ctx.cfg, "default"),
                deliver: async (payload, info) => {
                  // Send the reply via email
                  const replyText = payload.text || "";
                  ctx.log?.info?.(`[${account.accountId}] Sending reply to ${fromEmail}`);
                  await sendEmail(
                    account.accountId || "default",
                    fromEmail,
                    subject,
                    replyText,
                    messageId,
                  );
                },
                onError: (err, info) => {
                  ctx.log?.error?.(`[${account.accountId}] Email reply failed: ${String(err)}`);
                },
              },
              replyOptions: {
                disableBlockStreaming: true, // Email doesn't support streaming
              },
            });

            ctx.log?.info?.(`[${account.accountId}] Email processed successfully`);
          } catch (error: any) {
            // Log detailed error information
            const errorMsg = error?.message || String(error);
            const errorStack = error?.stack || "";
            const errorDetails = error?.toString() || String(error);

            ctx.log?.error?.(`[${account.accountId}] Error processing email from ${fromEmail}:`);
            ctx.log?.error?.(
              `[${account.accountId}] Error type: ${error?.constructor?.name || "Unknown"}`,
            );
            ctx.log?.error?.(`[${account.accountId}] Error message: ${errorMsg}`);
            if (errorStack) {
              ctx.log?.error?.(
                `[${account.accountId}] Stack trace: ${errorStack.split("\n").slice(0, 5).join(" | ")}`,
              );
            }
            ctx.log?.error?.(`[${account.accountId}] Full error: ${errorDetails}`);

            // Send error notification to sender only if not a sending error
            if (!errorMsg.includes("send") && !errorMsg.includes("SMTP")) {
              try {
                const errorMessage =
                  "Sorry, there was an error processing your request. Please try again later.";
                await sendEmail(
                  account.accountId || "default",
                  fromEmail,
                  subject,
                  errorMessage,
                  messageId,
                );
              } catch (sendError) {
                ctx.log?.error?.(
                  `[${account.accountId}] Failed to send error notification: ${String(sendError)}`,
                );
              }
            }
          }
        },
      );

      // Return a cleanup function
      return () => {
        ctx.log?.info?.(`[${account.accountId}] Stopping email channel`);
        stopEmail(account.accountId || "default");
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text, to }) => {
      // Parse the target: format is "accountId:recipientEmail|subject|messageId"
      const match = to.match(/^([^:]+):([^|]+)\|([^|]+)\|(.+)$/);
      if (!match) {
        return {
          ok: false,
          error: "Invalid email target format",
          channel: "email" as const,
          messageId: `error-${Date.now()}`,
        };
      }

      const [, accountId, recipientEmail, subject, messageId] = match;

      const success = await sendEmail(accountId, recipientEmail, subject, text, messageId);
      return {
        ok: success,
        channel: "email" as const,
        messageId: success ? messageId : `failed-${Date.now()}`,
      };
    },
  },
  messaging: {
    normalizeTarget: (raw: string) => {
      // Convert email address to target format: "email|subject|messageId"
      // We store the context in dispatch, so we can retrieve it here
      // For now, return the email as-is (it will be formatted in dispatch)
      return raw;
    },
  },
};

export { emailPlugin };
