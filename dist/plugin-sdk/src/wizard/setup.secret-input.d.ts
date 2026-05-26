import type { OpenClawConfig } from "../config/types.openclaw.js";
type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];
export declare function resolveSetupSecretInputString(params: {
    config: OpenClawConfig;
    value: unknown;
    path: string;
    defaults?: SecretDefaults;
    env?: NodeJS.ProcessEnv;
}): Promise<string | undefined>;
export {};
