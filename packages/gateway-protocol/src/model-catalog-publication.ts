import type { ModelsListResult } from "./schema/agents-models-skills.js";

/** Published configured draft projection for one authenticated connection's initial agent. */
export type ModelsSnapshotEvent = {
  agentId: string;
  catalog: ModelsListResult;
};
