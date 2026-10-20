import type { GrokBotRecipe } from "./recipe.js";

type GrokSourceKind = "local" | "snapshot" | "recipe" | "url" | "live";

export type GrokSourceSection<T> = {
  status: "complete" | "partial" | "unavailable";
  value: T;
  reason?: string;
};

export type GrokSourceIssue = { code: string; message: string; agentId?: string };

/** Metadata for setup reminders only; credential values are never resolved or copied. */
export type GrokCredentialSelector = {
  id: string;
  name: string;
  kind: "local-user-secret" | "snapshot-secret" | "mcp-secret";
  sourcePath?: string;
  accountScope?: string;
  path?: string[];
};

type GrokSourceAutomation = {
  id: string;
  name: string;
  record: Record<string, unknown>;
};

export type GrokSourceAgent = {
  id: string;
  name: string;
  instructions: string;
  title?: string;
  gettingStarted?: { skill: string };
  avatar?: {
    shape?: string;
    color?: string;
    url?: string;
    image?: { bytes: Uint8Array; extension: "png" | "jpg" | "gif" | "webp" };
  };
  memory: GrokSourceSection<GrokBotRecipe["memory"]>;
  skills: GrokSourceSection<GrokBotRecipe["skills"]>;
  automations: GrokSourceSection<GrokSourceAutomation[]>;
  plugins: GrokSourceSection<GrokBotRecipe["plugins"]>;
};

export type GrokMcpServer = {
  name: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  instructions?: string;
  disabledTools?: string[];
  credentialSelectors: GrokCredentialSelector[];
};

export type GrokSourceInventory = {
  source: string;
  kind: GrokSourceKind;
  mainAgentId?: string;
  settings: GrokSourceSection<Record<string, unknown>>;
  agents: GrokSourceSection<GrokSourceAgent[]>;
  mcpServers: GrokSourceSection<GrokMcpServer[]>;
  credentials: GrokCredentialSelector[];
  issues: GrokSourceIssue[];
};

export type GrokSourceOptions = {
  source?: string;
  homeDir?: string;
  resolveAccessToken?: () => Promise<string>;
};

export type GrokSourceDetection = {
  detected: boolean;
  source: string;
  kind: GrokSourceKind;
  notes: string[];
};
