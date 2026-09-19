// Zalo type declarations define plugin contracts.
import type { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import type { z } from "zod";
import type { ZaloAccountSchema, ZaloConfigSchema } from "./config-schema.js";

export type ZaloAccountConfig = z.input<typeof ZaloAccountSchema>;
export type ZaloConfig = z.input<typeof ZaloConfigSchema>;

type ZaloTokenSource = "env" | "config" | "configFile" | "none";
export type ZaloTokenStatus = "available" | "configured_unavailable" | "missing";

export type ResolvedZaloAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: ZaloTokenSource;
  tokenStatus?: ZaloTokenStatus;
  credentialDiagnostics?: Extract<
    ReturnType<typeof tryReadSecretFileSync>,
    { status: "configured_unavailable" }
  >["diagnostic"][];
  config: ZaloAccountConfig;
};
