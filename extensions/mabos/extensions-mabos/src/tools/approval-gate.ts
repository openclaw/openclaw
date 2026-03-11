/**
 * Telegram Approval Gate — sends approval requests to the owner's
 * Telegram DM with inline keyboard buttons. Blocks until approved/rejected
 * or times out after a configurable period.
 */

const TG_API = "https://api.telegram.org/bot";

function tgUrl(method: string): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return `${TG_API}${token}/${method}`;
}

function ownerChatId(): string {
  const id = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!id) throw new Error("TELEGRAM_OWNER_CHAT_ID not set");
  return id;
}

export type ApprovalRequest = {
  type: "post" | "campaign" | "ad_set";
  summary: string;
  details: string;
  preview_url?: string;
};

export type ApprovalResult = {
  approved: boolean;
  decided_by: string;
  decided_at: string;
  message_id?: number;
};

export async function requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
  const chatId = ownerChatId();
  const callbackId = `approval_${Date.now().toString(36)}`;

  const text = [
    `🔔 *Approval Required: ${req.type.toUpperCase()}*\n`,
    req.summary,
    `\n---\n${req.details}`,
  ].join("\n");

  const body: any = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `${callbackId}:approve` },
          { text: "❌ Reject", callback_data: `${callbackId}:reject` },
        ],
      ],
    },
  };

  if (req.preview_url) {
    await fetch(tgUrl("sendPhoto"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        photo: req.preview_url,
        caption: `Preview: ${req.type}`,
      }),
    });
  }

  const sendResp = await fetch(tgUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const sendData = (await sendResp.json()) as any;
  const messageId = sendData.result?.message_id;

  const timeoutMs = 5 * 60 * 1000;
  const pollIntervalMs = 3000;
  const deadline = Date.now() + timeoutMs;
  let lastUpdateId = 0;

  while (Date.now() < deadline) {
    const updatesResp = await fetch(tgUrl("getUpdates"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: lastUpdateId + 1,
        timeout: 10,
        allowed_updates: ["callback_query"],
      }),
    });
    const updatesData = (await updatesResp.json()) as any;

    for (const update of updatesData.result || []) {
      lastUpdateId = update.update_id;
      const cb = update.callback_query;
      if (cb?.data?.startsWith(callbackId)) {
        const action = cb.data.split(":")[1];
        await fetch(tgUrl("answerCallbackQuery"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            callback_query_id: cb.id,
            text: action === "approve" ? "Approved!" : "Rejected.",
          }),
        });
        await fetch(tgUrl("editMessageText"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `${text}\n\n${action === "approve" ? "✅ APPROVED" : "❌ REJECTED"} by owner at ${new Date().toISOString()}`,
            parse_mode: "Markdown",
          }),
        });
        return {
          approved: action === "approve",
          decided_by: `${cb.from?.first_name || "Owner"} (Telegram)`,
          decided_at: new Date().toISOString(),
          message_id: messageId,
        };
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  await fetch(tgUrl("editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: `${text}\n\n⏰ TIMED OUT — no response within 5 minutes.`,
      parse_mode: "Markdown",
    }),
  });

  return {
    approved: false,
    decided_by: "system (timeout)",
    decided_at: new Date().toISOString(),
    message_id: messageId,
  };
}

export async function notifyOwner(message: string): Promise<void> {
  await fetch(tgUrl("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: ownerChatId(),
      text: message,
      parse_mode: "Markdown",
    }),
  });
}
