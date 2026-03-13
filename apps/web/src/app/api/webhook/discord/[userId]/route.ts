import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { replyWithClaude, NoApiKeyError } from "@/lib/claude";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function verifySignature(
  rawBody: string,
  signature: string,
  timestamp: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-ed25519") ?? "";
  const timestamp = req.headers.get("x-signature-timestamp") ?? "";

  // notes stores the application public key
  const ch = await prisma.userChannel.findUnique({
    where: { userId_channel: { userId, channel: "discord" } },
  });
  if (!ch?.token || !ch.notes || !ch.enabled) {
    return new NextResponse("Not configured", { status: 400 });
  }

  const valid = await verifySignature(rawBody, signature, timestamp, ch.notes);
  if (!valid) return new NextResponse("Invalid signature", { status: 401 });

  const body = JSON.parse(rawBody);

  // Discord PING
  if (body.type === 1) return NextResponse.json({ type: 1 });

  // Slash command
  if (body.type === 2) {
    const userMessage: string = body.data?.options?.[0]?.value ?? "";
    if (!userMessage) {
      return NextResponse.json({
        type: 4,
        data: { content: "Please provide a message, e.g. `/ask message:Hello`" },
      });
    }

    try {
      const reply = await replyWithClaude(userId, "discord", userMessage);
      return NextResponse.json({ type: 4, data: { content: reply } });
    } catch (err) {
      const content = err instanceof NoApiKeyError ? `⚠️ No ${(err as NoApiKeyError).message.split(":")[1] ?? "AI"} API key configured. Add it in Settings → AI Settings, or upgrade to a paid plan.` : "An error occurred. Please try again.";
      return NextResponse.json({ type: 4, data: { content } });
    }
  }

  return NextResponse.json({ type: 1 });
}
