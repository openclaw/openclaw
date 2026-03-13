import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { replyWithClaude, NoApiKeyError } from "@/lib/claude";

interface TelegramUpdate {
  message?: { chat: { id: number }; text?: string; from?: { is_bot?: boolean } };
  channel_post?: { chat: { id: number }; text?: string };
}

async function sendTelegramMessage(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const body: TelegramUpdate = await req.json();

  const msg = body.message ?? body.channel_post;
  if (!msg?.text || body.message?.from?.is_bot) {
    return NextResponse.json({ ok: true });
  }

  const ch = await prisma.userChannel.findUnique({
    where: { userId_channel: { userId, channel: "telegram" } },
  });
  if (!ch?.token || !ch.enabled) return NextResponse.json({ ok: true });

  // Verify the secret token set via Telegram's setWebhook secret_token param
  // (stored in ch.notes). Reject requests without a valid token.
  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!ch.notes) {
    return new NextResponse("Webhook not configured", { status: 403 });
  }
  try {
    if (!timingSafeEqual(Buffer.from(incomingSecret), Buffer.from(ch.notes))) {
      return new NextResponse("Invalid secret", { status: 401 });
    }
  } catch {
    return new NextResponse("Invalid secret", { status: 401 });
  }

  const chatId = msg.chat.id;

  try {
    const reply = await replyWithClaude(userId, "telegram", msg.text);
    await sendTelegramMessage(ch.token, chatId, reply);
  } catch (err) {
    const text = err instanceof NoApiKeyError ? `⚠️ No ${(err as NoApiKeyError).message.split(":")[1] ?? "AI"} API key configured. Add it in Settings → AI Settings, or upgrade to a paid plan.` : "An error occurred. Please try again.";
    await sendTelegramMessage(ch.token, chatId, text);
  }

  return NextResponse.json({ ok: true });
}
