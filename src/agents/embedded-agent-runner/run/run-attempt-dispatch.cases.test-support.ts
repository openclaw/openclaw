import type { AgentHarnessAttemptParamsV2 } from "../../harness/types.js";

type DispatchCase = {
  cyberAccessProgram?: AgentHarnessAttemptParamsV2["cyberAccessProgram"];
  agentId?: string;
  sandboxSessionKey?: string;
  remoteSkills?: boolean;
  skillCatalog?: "host" | "sandbox" | "none";
  oneShotCliRun?: boolean;
  managedWorkspace?: boolean;
  explicitCwd?: boolean;
  realManagedWorkspace?: boolean;
  hostMedia?: "allowed" | "outside";
  retirePlacement?: boolean;
  configuredContextEngine?: boolean;
  diffBaseline?: "settled" | "failed" | "revoked";
  retryCount?: number;
  legacyRetryCount?: number;
  legacyRetryDelayMs?: number;
  retryPreparation?: "omit" | "mutate" | "change-cwd";
  cancelTrajectory?: boolean;
  preparedAuth?: "explicit-header" | "no-auth";
};

export const dispatchCases: DispatchCase[] = [
  { agentId: "main", cyberAccessProgram: "standard" },
  { agentId: "main", cyberAccessProgram: "daybreak_blue" },
  ...(["explicit-header", "no-auth"] as const).map((preparedAuth) => ({
    agentId: "main",
    preparedAuth,
  })),
  { agentId: "main", cancelTrajectory: true },
  ...(["settled", "failed", "revoked"] as const).map((diffBaseline) => ({
    sandboxSessionKey: "global",
    diffBaseline,
  })),
  {
    agentId: "main",
    skillCatalog: "host" as const,
    configuredContextEngine: true,
    retryCount: 0,
    legacyRetryCount: 9,
  },
  ...([0, undefined] as const).map((retryCount) => ({
    agentId: "main",
    retryCount,
    legacyRetryCount: 3,
    retryPreparation: "mutate" as const,
  })),
  ...(["omit", "change-cwd"] as const).map((retryPreparation) => ({
    agentId: "main",
    retryCount: 0,
    legacyRetryCount: 3,
    retryPreparation,
  })),
  {
    agentId: "main",
    explicitCwd: true,
    retryCount: 0,
    legacyRetryCount: 9,
  },
  {
    sandboxSessionKey: "global",
    skillCatalog: "sandbox" as const,
    oneShotCliRun: true,
    retryCount: 1,
  },
  {
    sandboxSessionKey: "agent:main:policy",
    oneShotCliRun: false,
    legacyRetryCount: 3,
    legacyRetryDelayMs: 12,
  },
  {
    oneShotCliRun: false,
    managedWorkspace: true,
    retryCount: 0,
    legacyRetryCount: 9,
  },
  {
    oneShotCliRun: false,
    managedWorkspace: true,
    realManagedWorkspace: true,
  },
  {
    agentId: "main",
    remoteSkills: true,
    oneShotCliRun: false,
    retirePlacement: true,
  },
  ...(["allowed", "outside"] as const).map((hostMedia) => ({
    remoteSkills: true,
    oneShotCliRun: false,
    managedWorkspace: true,
    realManagedWorkspace: true,
    hostMedia,
  })),
];
