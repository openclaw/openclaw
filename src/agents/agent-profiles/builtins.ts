import type { AgentProfileResource } from "agentprofiles";
import type { AgentProfileId } from "../../config/agent-profile-ids.js";

export type BuiltInAgentProfile = {
  id: AgentProfileId;
  resource: AgentProfileResource;
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
