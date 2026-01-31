import { createClient } from "@/lib/supabase/server";
import { getDigitalOceanClient } from "@/lib/digitalocean/client";
import { NextResponse } from "next/server";
import crypto from "crypto";

// GET /api/instances - List user's instances
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: instances, error } = await supabase
    .from("instances")
    .select(
      `
      id,
      name,
      status,
      public_url,
      created_at,
      updated_at,
      last_health_at,
      channels (
        id,
        channel_type,
        status,
        linked_identity
      )
    `
    )
    .eq("user_id", user.id);

  if (error) {
    console.error("Error fetching instances:", error);
    return NextResponse.json(
      { error: "Failed to fetch instances" },
      { status: 500 }
    );
  }

  return NextResponse.json({ instances: instances || [] });
}

// POST /api/instances - Create a new instance
export async function POST() {
  console.log("[instances] POST - Starting instance creation...");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    console.log("[instances] POST - Unauthorized: No user");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.log("[instances] POST - User:", user.email);

  // Check if user already has an instance (MVP: one per user)
  const { count } = await supabase
    .from("instances")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id);

  console.log("[instances] POST - Existing instances:", count);
  if (count && count >= 1) {
    return NextResponse.json(
      { error: "Instance limit reached. Free tier allows 1 instance." },
      { status: 400 }
    );
  }

  // Generate a secure gateway token
  const gatewayToken = crypto.randomBytes(32).toString("hex");
  console.log("[instances] POST - Generated gateway token");

  // Create instance record first (status: pending)
  console.log("[instances] POST - Creating Supabase record...");
  const { data: instance, error: insertError } = await supabase
    .from("instances")
    .insert({
      user_id: user.id,
      name: "default",
      status: "provisioning",
      gateway_token_encrypted: gatewayToken, // TODO: encrypt in production
    })
    .select()
    .single();

  if (insertError) {
    console.error("[instances] POST - Supabase insert error:", insertError);
    return NextResponse.json(
      { error: "Failed to create instance: " + insertError.message },
      { status: 500 }
    );
  }
  console.log("[instances] POST - Supabase record created:", instance.id);

  // Provision container on DigitalOcean App Platform
  try {
    console.log("[instances] POST - Getting DO client...");
    const doClient = getDigitalOceanClient();

    // Get the platform Anthropic API key (we provide Claude access)
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY not configured");
    }
    console.log("[instances] POST - Anthropic key found");

    console.log("[instances] POST - Calling DO App Platform API...");
    const { appId, url } = await doClient.createApp({
      userId: user.id,
      instanceId: instance.id,
      gatewayToken,
      anthropicApiKey,
    });
    console.log("[instances] POST - DO App created:", { appId, url });

    // Update instance with DO app details
    console.log("[instances] POST - Updating Supabase with DO details...");
    await supabase
      .from("instances")
      .update({
        do_app_id: appId,
        public_url: url,
        status: "provisioning",
      })
      .eq("id", instance.id);

    console.log("[instances] POST - Success! Instance provisioning started.");
    return NextResponse.json({
      id: instance.id,
      status: "provisioning",
      message: "Instance is being created. This may take 2-3 minutes.",
    });
  } catch (error) {
    console.error("[instances] POST - DO provisioning error:", error);

    // Update instance status to error
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    await supabase
      .from("instances")
      .update({
        status: "error",
        error_message: errorMsg,
      })
      .eq("id", instance.id);

    return NextResponse.json(
      { error: "Failed to provision container: " + errorMsg },
      { status: 500 }
    );
  }
}
