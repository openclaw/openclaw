import type { AgentProfileId } from "../../config/agent-profile-ids.js";
import type { AgentProfileResource } from "./spec-types.js";

export type BuiltInAgentProfile = {
  id: AgentProfileId;
  resource: AgentProfileResource;
};

// The built-ins are typed constants. builtins.test.ts checks their structure, so loading
// this module does not compile a validator.
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
  // openclaw/small is the exact migration of experimental.localModelLean: the Lean tool
  // profile and nothing else. Stricter or smaller choices belong in a separate profile.
  defineBuiltInAgentProfile("openclaw/small", {
    apiVersion: "agentprofiles.io/v1",
    kind: "AgentProfile",
    metadata: { namespace: "openclaw", name: "small" },
    extends: "openclaw/base",
    spec: {
      common: {},
      "openclaw.ai": { toolProfile: "lean" },
    },
  }),
  // openclaw/compact is an opt-in step past Lean: bounded workspace context, and the
  // scheduler stays so a small model does not fake reminders through a shell command.
  defineBuiltInAgentProfile("openclaw/compact", {
    apiVersion: "agentprofiles.io/v1",
    kind: "AgentProfile",
    metadata: { namespace: "openclaw", name: "compact" },
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

/** Indexes profiles by id and rejects a duplicate id instead of letting a later one win. */
export function indexBuiltInAgentProfiles(
  profiles: readonly BuiltInAgentProfile[],
): Map<string, BuiltInAgentProfile> {
  const byId = new Map<string, BuiltInAgentProfile>();
  for (const profile of profiles) {
    if (byId.has(profile.id)) {
      throw new Error(`Duplicate built-in Agent Profile id: ${profile.id}`);
    }
    byId.set(profile.id, profile);
  }
  return byId;
}
