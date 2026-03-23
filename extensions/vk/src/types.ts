import type { SecretInput } from "openclaw/plugin-sdk/setup";

export type VkAccountConfig = {
  name?: string;
  enabled?: boolean;
  botToken?: SecretInput;
  tokenFile?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: string[];
  responsePrefix?: string;
};

export type VkConfig = VkAccountConfig & {
  accounts?: Record<string, Partial<VkAccountConfig>>;
  defaultAccount?: string;
};

export type ResolvedVkAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "configFile" | "none";
  config: VkAccountConfig;
};

export type VkProbeResult =
  | {
      ok: true;
      group: {
        id: number;
        name?: string;
        screenName?: string;
      };
    }
  | {
      ok: false;
      error: string;
    };
