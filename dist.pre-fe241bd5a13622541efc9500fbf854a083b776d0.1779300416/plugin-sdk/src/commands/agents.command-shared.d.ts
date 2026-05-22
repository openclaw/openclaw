import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
export declare function createQuietRuntime(runtime: RuntimeEnv): RuntimeEnv;
export declare function requireValidConfigFileSnapshot(runtime: RuntimeEnv): Promise<import("../config/types.openclaw.js").ConfigFileSnapshot | null>;
export declare function requireValidConfig(runtime: RuntimeEnv): Promise<OpenClawConfig | null>;
