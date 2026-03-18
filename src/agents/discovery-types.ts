import type { OpenClawConfig } from "../config/config.js";
import type { ModelInputType } from "./model-catalog.js";

export type DiscoveredModel = {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

export interface ModelDiscoverySource {
  discover(context: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  }): Promise<DiscoveredModel[]>;
}
