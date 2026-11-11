import type { RunCliAgentParams } from "../cli-runner/types.js";

type TrustedHandoff = NonNullable<RunCliAgentParams["trustedInternalHandoff"]>;
export type RestrictedCompletion = {
  name: string;
  providerName?: string;
  execHost?: "node";
  seedChildLineage?: boolean;
  forge?: (handoff: TrustedHandoff) => TrustedHandoff | undefined;
};

export const restrictedCompletionCases: RestrictedCompletion[] = [
  { name: "a non-Claude CLI runtime", providerName: "google-gemini-cli", execHost: undefined },
  { name: "a node-hosted Claude CLI requester", providerName: "claude-cli", execHost: "node" },
  { name: "a missing capability", seedChildLineage: true, forge: () => undefined },
  {
    name: "a capability without persisted child lineage",
    seedChildLineage: false,
    forge: (handoff) => handoff,
  },
];
