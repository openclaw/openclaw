export type ThreatLevel = "none" | "low" | "medium" | "high" | "critical";

export interface ScanPattern {
  name: string;
  regex: RegExp;
  threat: ThreatLevel;
  description?: string;
}

export interface ScanFinding {
  pattern: string;
  threat: ThreatLevel;
  match: string;
  position: number;
  context: string;
}

export interface ScanResult {
  clean: boolean;
  findings: ScanFinding[];
  highestThreat: ThreatLevel;
}

export interface SecurityConfig {
  securityEnabled?: boolean;
  injectionScanning?: {
    enabled?: boolean;
    scanMemoryWrites?: boolean;
    scanToolInputs?: boolean;
    scanExternalContent?: boolean;
    blockOnDetection?: boolean;
  };
  toolGuard?: {
    enabled?: boolean;
    dangerousTools?: string[];
    autoApproveForRoles?: string[];
    approvalTimeoutSeconds?: number;
  };
  ssrf?: {
    enabled?: boolean;
    blockedCidrs?: string[];
    allowedDomains?: string[];
  };
}
