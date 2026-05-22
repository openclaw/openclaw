import type { PluginDiagnostic } from "./manifest-types.js";
export declare function pushPluginValidationDiagnostic(params: {
    level: PluginDiagnostic["level"];
    pluginId: string;
    source: string;
    message: string;
    pushDiagnostic: (diag: PluginDiagnostic) => void;
}): void;
