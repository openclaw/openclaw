import type { SessionBindingCapabilities } from "../infra/outbound/session-binding-service.js";
import type { SpawnOrigin } from "./acp-spawn-origin.js";

export function resolveAcpPlacement(
  origin: SpawnOrigin,
  capabilities: SessionBindingCapabilities,
): { ok: true; placement: "current" | "child" } | { ok: false; error: string } {
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${origin.channel}.`,
    };
  }

  if (origin.originKind === "direct" || origin.originKind === "thread") {
    if (!capabilities.placements.includes("current")) {
      return {
        ok: false,
        error: `Thread bindings do not support current placement for ${origin.channel}.`,
      };
    }
    return { ok: true, placement: "current" };
  }

  if (capabilities.placements.includes("child")) {
    return { ok: true, placement: "child" };
  }
  if (capabilities.placements.includes("current") && origin.currentBindingEligible) {
    return { ok: true, placement: "current" };
  }
  return {
    ok: false,
    error:
      `${origin.channel} does not support child thread creation, and ` +
      "the current surface is not eligible for in-place ACP binding.",
  };
}
