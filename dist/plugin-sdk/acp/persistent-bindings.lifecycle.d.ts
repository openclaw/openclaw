import type { OpenClawConfig } from "../config/config.js";
import { type ConfiguredAcpBindingSpec } from "./persistent-bindings.types.js";
export declare function ensureConfiguredAcpBindingSession(params: {
    cfg: OpenClawConfig;
    spec: ConfiguredAcpBindingSpec;
}): Promise<{
    ok: true;
    sessionKey: string;
} | {
    ok: false;
    sessionKey: string;
    error: string;
}>;
export declare function resetAcpSessionInPlace(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    reason: "new" | "reset";
}): Promise<{
    ok: true;
} | {
    ok: false;
    skipped?: boolean;
    error?: string;
}>;
