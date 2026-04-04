import {
  refreshIntegrationsRuntime,
  repairOlderIntegrationsProfile,
} from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const result = repairOlderIntegrationsProfile();
  const refresh = result.changed
    ? await refreshIntegrationsRuntime()
    : {
      attempted: false,
      restarted: false,
      error: null,
      profile: "default",
    };

  return Response.json({
    changed: result.changed,
    repairs: result.repairs,
    repairedIds: result.repairedIds,
    refresh,
    ...result.state,
  });
}
