import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

const DO_API_BASE = "https://api.digitalocean.com/v2";

// GET /api/instances/[id]/deploy-status - Get live deployment status from DO
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

  if (!instance.do_app_id) {
    return NextResponse.json({
      phase: "PENDING",
      logs: ["Waiting for app creation..."],
    });
  }

  // Fetch deployment status from DigitalOcean
  try {
    const doToken = process.env.DO_API_TOKEN;
    if (!doToken) {
      throw new Error("DO_API_TOKEN not configured");
    }

    const response = await fetch(
      `${DO_API_BASE}/apps/${instance.do_app_id}/deployments`,
      {
        headers: {
          Authorization: `Bearer ${doToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`DO API error: ${response.status}`);
    }

    const data = await response.json();
    const deployment = data.deployments?.[0];

    if (!deployment) {
      return NextResponse.json({
        phase: "PENDING",
        logs: ["No deployment found"],
      });
    }

    // Build terminal-style logs from the deployment progress
    const logs: string[] = [];
    const timestamp = (ts: string) => {
      const d = new Date(ts);
      return d.toLocaleTimeString("en-US", { hour12: false });
    };

    logs.push(`$ Deployment ${deployment.id.slice(0, 8)}`);
    logs.push(`Phase: ${deployment.phase}`);
    logs.push("");

    // Process build steps
    const buildStep = deployment.progress?.steps?.find((s: any) => s.name === "build");
    if (buildStep) {
      if (buildStep.started_at) {
        logs.push(`[${timestamp(buildStep.started_at)}] === BUILD ===`);
      }
      for (const step of buildStep.steps || []) {
        const status = step.status === "SUCCESS" ? "✓" : step.status === "ERROR" ? "✗" : "→";
        if (step.name === "components" && step.steps) {
          for (const comp of step.steps) {
            logs.push(`[${timestamp(comp.started_at || buildStep.started_at)}] ${status} ${comp.message_base || comp.name}: ${comp.component_name}`);
            if (comp.reason?.message) {
              logs.push(`   ${comp.reason.message}`);
            }
          }
        } else {
          logs.push(`[${timestamp(step.started_at || buildStep.started_at)}] ${status} ${step.name}`);
        }
      }
      if (buildStep.ended_at) {
        const duration = (new Date(buildStep.ended_at).getTime() - new Date(buildStep.started_at).getTime()) / 1000;
        logs.push(`[${timestamp(buildStep.ended_at)}] Build completed in ${duration.toFixed(1)}s`);
      }
    }

    // Process deploy steps
    const deployStep = deployment.progress?.steps?.find((s: any) => s.name === "deploy");
    if (deployStep) {
      logs.push("");
      if (deployStep.started_at) {
        logs.push(`[${timestamp(deployStep.started_at)}] === DEPLOY ===`);
      }
      for (const step of deployStep.steps || []) {
        if (step.name === "components" && step.steps) {
          for (const comp of step.steps) {
            for (const subStep of comp.steps || []) {
              const status = subStep.status === "SUCCESS" ? "✓" : subStep.status === "ERROR" ? "✗" : subStep.status === "RUNNING" ? "⟳" : "→";
              const ts = subStep.started_at || deployStep.started_at;
              logs.push(`[${timestamp(ts)}] ${status} ${subStep.message_base || subStep.name}`);
              if (subStep.reason?.message) {
                logs.push(`   ERROR: ${subStep.reason.message}`);
              }
            }
          }
        } else if (step.name === "initialize") {
          const status = step.status === "SUCCESS" ? "✓" : step.status === "ERROR" ? "✗" : "→";
          logs.push(`[${timestamp(step.started_at || deployStep.started_at)}] ${status} Initializing deployment`);
        }
      }
      if (deployStep.reason?.message) {
        logs.push("");
        logs.push(`ERROR: ${deployStep.reason.message}`);
      }
      if (deployStep.ended_at && deployStep.status === "SUCCESS") {
        const duration = (new Date(deployStep.ended_at).getTime() - new Date(deployStep.started_at).getTime()) / 1000;
        logs.push(`[${timestamp(deployStep.ended_at)}] Deploy completed in ${duration.toFixed(1)}s`);
      }
    }

    // Add final status
    logs.push("");
    if (deployment.phase === "ACTIVE") {
      logs.push("✓ Deployment successful!");
    } else if (deployment.phase === "ERROR") {
      logs.push("✗ Deployment failed");
    } else {
      logs.push(`Status: ${deployment.phase}...`);
    }

    // Update instance status if deployment completed or failed
    if (deployment.phase === "ACTIVE" && instance.status !== "running") {
      const appResponse = await fetch(
        `${DO_API_BASE}/apps/${instance.do_app_id}`,
        {
          headers: { Authorization: `Bearer ${doToken}` },
        }
      );
      const appData = await appResponse.json();

      await supabase
        .from("instances")
        .update({
          status: "running",
          public_url: appData.app?.live_url || instance.public_url,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    } else if (deployment.phase === "ERROR" && instance.status !== "error") {
      const errorMsg = deployment.progress?.summary_steps?.[0]?.reason?.message || "Deployment failed";
      await supabase
        .from("instances")
        .update({
          status: "error",
          error_message: errorMsg,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    }

    return NextResponse.json({
      phase: deployment.phase,
      logs,
    });
  } catch (error) {
    console.error("[deploy-status] Error:", error);
    return NextResponse.json({
      phase: "UNKNOWN",
      logs: [`Error: ${error instanceof Error ? error.message : "Failed to fetch status"}`],
    });
  }
}
