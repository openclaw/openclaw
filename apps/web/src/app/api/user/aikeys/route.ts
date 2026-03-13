import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MODELS, PROVIDER_KEY_PREFIXES, type Provider } from "@/lib/models";

type Body =
  | { action: "setKey";   provider: Provider; apiKey: string }
  | { action: "setModel"; model: string };

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: Body = await req.json();

  if (body.action === "setModel") {
    const valid = MODELS.some((m) => m.id === body.model);
    if (!valid) {
      return NextResponse.json({ error: "Unknown model" }, { status: 400 });
    }
    await prisma.user.update({
      where: { id: session.user.id },
      data: { preferredModel: body.model },
    });
    return NextResponse.json({ success: true });
  }

  // setKey
  const { provider, apiKey } = body;
  const value = typeof apiKey === "string" ? apiKey.trim() : null;

  const validProviders: Provider[] = ["anthropic", "openai", "google"];
  if (!validProviders.includes(provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  if (value) {
    const prefix = PROVIDER_KEY_PREFIXES[provider];
    if (!value.startsWith(prefix)) {
      return NextResponse.json(
        { error: `Invalid key format. ${provider} keys start with "${prefix}"` },
        { status: 400 },
      );
    }
  }

  const field =
    provider === "anthropic" ? "anthropicApiKey"
    : provider === "openai"  ? "openaiApiKey"
    : "geminiApiKey";

  await prisma.user.update({
    where: { id: session.user.id },
    data: { [field]: value || null },
  });

  return NextResponse.json({ success: true });
}
