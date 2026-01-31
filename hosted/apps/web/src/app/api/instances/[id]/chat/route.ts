import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// POST /api/instances/[id]/chat - Proxy chat messages to the user's gateway
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get instance from database
  const { data: instance, error } = await supabase
    .from("instances")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (!instance.public_url) {
    return NextResponse.json({ error: "Instance not ready" }, { status: 400 });
  }

  // Get message from request body
  const body = await request.json();
  const { message } = body;

  if (!message) {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  // Forward to the gateway
  const gatewayUrl = instance.public_url.startsWith("http")
    ? instance.public_url
    : `https://${instance.public_url}`;

  try {
    // The gateway uses WebSocket for chat, but we can use the HTTP hooks API
    // For now, let's try the OpenAI-compatible endpoint if available
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${instance.gateway_token_encrypted}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[chat] Gateway error:", response.status, errorText);
      return NextResponse.json(
        { error: "Gateway error", details: errorText },
        { status: response.status }
      );
    }

    const data = await response.json();
    const assistantMessage = data.choices?.[0]?.message?.content || "No response";

    return NextResponse.json({ response: assistantMessage });
  } catch (error) {
    console.error("[chat] Error:", error);
    return NextResponse.json(
      { error: "Failed to reach gateway", details: String(error) },
      { status: 500 }
    );
  }
}
