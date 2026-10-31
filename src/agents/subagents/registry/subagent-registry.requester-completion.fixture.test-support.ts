import type { registerSubagentRun } from "./subagent-registry.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type Registration = Parameters<typeof registerSubagentRun>[0];

export type RegistryRegistrationFixture = {
  registration: (runId: string, overrides?: Partial<Registration>) => Registration;
  updateRun: (runId: string, update: (draft: SubagentRunRecord) => void) => Promise<void>;
};
