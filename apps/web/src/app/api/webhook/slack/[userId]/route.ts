import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { replyWithClaude, NoApiKeyError } from "@/lib/claude";

function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): boolean {
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function postSlackMessage(token: string, channel: string, text: string) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, text }),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  // notes stores the Slack signing secret
  const ch = await prisma.userChannel.findUnique({
    where: { userId_channel: { userId, channel: "slack" } },
  });
  if (!ch?.token || !ch.notes || !ch.enabled) {
    return new NextResponse("Not configured", { status: 400 });
  }

  if (!verifySlackSignature(rawBody, timestamp, signature, ch.notes)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const body = JSON.parse(rawBody);

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (body.type === "event_callback") {
    const event = body.event;
    if (!event?.text || event.bot_id || event.subtype === "bot_message") {
      return NextResponse.json({ ok: true });
    }

    if (event.type === "message" || event.type === "app_mention") {
      const text: string = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();
      if (!text) return NextResponse.json({ ok: true });

      try {
        const reply = await replyWithClaude(userId, "slack", text);
        await postSlackMessage(ch.token, event.channel, reply);
      } catch (err) {
        const msg = err instanceof NoApiKeyError ? `⚠️ No ${(err as NoApiKeyError).message.split(":")[1] ?? "AI"} API key configured. Add it in Settings → AI Settings, or upgrade to a paid plan.` : "An error occurred. Please try again.";
        await postSlackMessage(ch.token, event.channel, msg);
      }
    }
  }

  return NextResponse.json({ ok: true });
}
