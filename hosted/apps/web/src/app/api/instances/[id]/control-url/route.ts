import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

// GET /api/instances/[id]/control-url - Get tokenized Control UI URL
export async function GET(
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
    .select("public_url, gateway_token_encrypted")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  if (!instance.public_url) {
    return NextResponse.json({ error: "Instance not ready" }, { status: 400 });
  }

  // Build tokenized URL
  const baseUrl = instance.public_url.startsWith("http")
    ? instance.public_url
    : `https://${instance.public_url}`;

  const tokenizedUrl = `${baseUrl}/?token=${encodeURIComponent(instance.gateway_token_encrypted)}`;

  return NextResponse.json({ url: tokenizedUrl });
}
