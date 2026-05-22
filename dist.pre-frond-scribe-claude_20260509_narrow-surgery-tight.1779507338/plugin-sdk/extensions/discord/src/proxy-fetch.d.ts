import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedDiscordAccount } from "./accounts.js";
export declare function resolveDiscordProxyFetchForAccount(account: Pick<ResolvedDiscordAccount, "config">, cfg: OpenClawConfig, runtime?: Pick<RuntimeEnv, "error">): typeof fetch | undefined;
export declare function withValidatedDiscordProxy<T>(proxyUrl: string | undefined, runtime: Pick<RuntimeEnv, "error"> | undefined, createValue: (proxyUrl: string) => T): T | undefined;
export declare function validateDiscordProxyUrl(proxyUrl: string): string;
