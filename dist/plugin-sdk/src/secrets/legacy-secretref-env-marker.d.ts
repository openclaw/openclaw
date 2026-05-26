import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type SecretRef } from "../config/types.secrets.js";
export type LegacySecretRefEnvMarkerCandidate = {
    path: string;
    pathSegments: string[];
    value: string;
    ref: SecretRef | null;
};
export declare function collectLegacySecretRefEnvMarkerCandidates(config: OpenClawConfig): LegacySecretRefEnvMarkerCandidate[];
export declare function migrateLegacySecretRefEnvMarkers(config: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
