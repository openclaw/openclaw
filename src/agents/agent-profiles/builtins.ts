import type { AgentProfileResource } from "agentprofiles";
import type { AgentProfileId } from "../../config/agent-profile-ids.js";
import type { ModelSizeClass } from "../../config/types.models.js";

export type BuiltInAgentProfile = {
  id: AgentProfileId;
  resource: AgentProfileResource;
};

export type BuiltInAgentProfileBinding = {
  selector: { modelSizeClass: ModelSizeClass };
  profileId: AgentProfileId;
};

// The built-ins are typed constants. The released portable validator checks them in
// builtins.test.ts, so loading this module does not compile a validator.
function defineBuiltInAgentProfile(
  id: AgentProfileId,
  resource: AgentProfileResource,
): BuiltInAgentProfile {
  const resourceId = `${resource.metadata.namespace}/${resource.metadata.name}`;
  if (resourceId !== id) {
    throw new Error(`Built-in Agent Profile id mismatch: expected ${id}, got ${resourceId}`);
  }
  return { id, resource };
}

export const BUILT_IN_AGENT_PROFILES: readonly BuiltInAgentProfile[] = [
  defineBuiltInAgentProfile("openclaw/base", {
    apiVersion: "agentprofiles.io/v1",
    kind: "AgentProfile",
    metadata: { namespace: "openclaw", name: "base" },
    spec: { common: {} },
  }),
  defineBuiltInAgentProfile("openclaw/small", {
    apiVersion: "agentprofiles.io/v1",
    kind: "AgentProfile",
    metadata: { namespace: "openclaw", name: "small" },
    extends: "openclaw/base",
    spec: {
      common: {},
      "openclaw.ai": {
        toolProfile: "compact",
        prompt: {
          workspaceContext: {
            totalMaxChars: 11_500,
            sections: {
              agents: { maxChars: 7_500 },
              soul: { maxChars: 2_000 },
              identity: { maxChars: 1_024 },
              user: { maxChars: 2_000 },
            },
          },
        },
      },
    },
  }),
];

// Medium and large models keep the base behavior: a separate built-in would be byte-identical.
export const BUILT_IN_AGENT_PROFILE_BINDINGS: readonly BuiltInAgentProfileBinding[] = [
  { selector: { modelSizeClass: "tiny" }, profileId: "openclaw/small" },
  { selector: { modelSizeClass: "small" }, profileId: "openclaw/small" },
  { selector: { modelSizeClass: "medium" }, profileId: "openclaw/base" },
  { selector: { modelSizeClass: "large" }, profileId: "openclaw/base" },
];
