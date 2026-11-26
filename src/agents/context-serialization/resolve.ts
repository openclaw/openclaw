import type { ContextSerialization } from "../../config/context-serialization.js";
import type { ResolvedAgentProfile } from "../agent-profiles.js";

type ContextSerializationSource = "agent-profile" | "fallback";

export type ResolvedContextSerialization = {
  mode: ContextSerialization;
  source: ContextSerializationSource;
};

/** Resolves the context serialization mode from the turn's Agent Profile. */
export function resolveContextSerialization(params: {
  resolvedProfile: ResolvedAgentProfile;
}): ResolvedContextSerialization {
  const profileMode = params.resolvedProfile.profile.spec["openclaw.ai"]?.contextSerialization;
  if (profileMode !== undefined) {
    return { mode: profileMode, source: "agent-profile" };
  }

  return { mode: "default", source: "fallback" };
}
