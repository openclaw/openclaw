import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { replyWithClaude, NoApiKeyError } from "@/lib/claude";

function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
  twilioSignature: string,
): boolean {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
  const expected = createHmac("sha1", authToken)
    .update(url + sorted)
    .digest("base64");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(twilioSignature));
  } catch {
    return false;
  }
}

async function sendTwilioMessage(
  accountSid: string,
  authToken: string,
  from: string,
  to: string,
  body: string,
) {
  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      body: new URLSearchParams({ From: from, To: to, Body: body }).toString(),
    },
  );
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const rawBody = await req.text();
  const twilioSig = req.headers.get("x-twilio-signature") ?? "";

  const formParams: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    formParams[k] = v;
  });

  // token = Twilio Account SID, notes = Twilio Auth Token
  const ch = await prisma.userChannel.findUnique({
    where: { userId_channel: { userId, channel: "whatsapp" } },
  });
  if (!ch?.token || !ch.notes || !ch.enabled) {
    return new NextResponse("Not configured", { status: 400 });
  }

  if (!verifyTwilioSignature(req.url, formParams, ch.notes, twilioSig)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  const from = formParams.From ?? "";
  const to = formParams.To ?? "";
  const messageBody = formParams.Body ?? "";

  if (!messageBody || !from) return new NextResponse("", { status: 200 });

  try {
    const reply = await replyWithClaude(userId, "whatsapp", messageBody);
    await sendTwilioMessage(ch.token, ch.notes, to, from, reply);
  } catch (err) {
    const msg = err instanceof NoApiKeyError ? `⚠️ No ${(err as NoApiKeyError).message.split(":")[1] ?? "AI"} API key configured. Add it in Settings → AI Settings, or upgrade to a paid plan.` : "An error occurred. Please try again.";
    await sendTwilioMessage(ch.token, ch.notes, to, from, msg);
  }

  return new NextResponse("", { status: 200 });
}
