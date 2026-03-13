import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// PATCH /api/user/apikey — save or clear the user's Anthropic API key
export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { apiKey } = await req.json() as { apiKey: string };

  // Accept empty string to clear the key
  const value = typeof apiKey === "string" ? apiKey.trim() : null;

  // Basic format check — Anthropic keys start with "sk-ant-"
  if (value && !value.startsWith("sk-ant-")) {
    return NextResponse.json(
      { error: "Invalid key format. Anthropic API keys start with sk-ant-" },
      { status: 400 },
    );
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { anthropicApiKey: value || null },
  });

  return NextResponse.json({ success: true });
}
