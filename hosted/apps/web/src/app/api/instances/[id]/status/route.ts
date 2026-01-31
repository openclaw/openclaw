import { createClient } from "@/lib/supabase/server";
import { getDigitalOceanClient } from "@/lib/digitalocean/client";
import { NextResponse } from "next/server";

// GET /api/instances/[id]/status - Get detailed instance status from DO
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
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !instance) {
    return NextResponse.json({ error: "Instance not found" }, { status: 404 });
  }

  // If no DO app ID, return current status
  if (!instance.do_app_id) {
    return NextResponse.json({
      status: instance.status,
      message: "Waiting for app creation...",
      do_status: null,
    });
  }

  // Get status from DigitalOcean
  try {
    const doClient = getDigitalOceanClient();
    const doApp = await doClient.getApp(instance.do_app_id);

    // Map DO status to our status
    let newStatus = instance.status;
    let message = "";

    switch (doApp.status) {
      case "running":
        newStatus = "running";
        message = "Your bot is running!";
        break;
      case "deploying":
        newStatus = "provisioning";
        message = "Container is being deployed...";
        break;
      case "error":
        newStatus = "error";
        message = "Deployment failed";
        break;
      default:
        newStatus = "provisioning";
        message = "Starting up...";
    }

    // Update database if status changed
    if (newStatus !== instance.status) {
      await supabase
        .from("instances")
        .update({
          status: newStatus,
          public_url: doApp.url,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    }

    return NextResponse.json({
      status: newStatus,
      message,
      do_status: doApp.status,
      url: doApp.url,
    });
  } catch (error) {
    console.error("[status] Error fetching DO app status:", error);
    return NextResponse.json({
      status: instance.status,
      message: "Checking status...",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
