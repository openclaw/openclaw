/** Fleet configuration types — matches config/fleet.json schema. */

export interface FleetNodeConfig {
  name: string;
  tailscaleIp: string;
  sshUser: string;
  roles: string[];
  capabilities: string[];
  hardware?: {
    gpuVram?: number; // GB
    cpuCores?: number;
    ramGb?: number;
  };
  scheduling?: {
    availableHours?: number[]; // 0-23 in CST
    timezone?: string;
  };
  services?: Record<string, FleetServiceConfig>;
  active?: boolean;
}

export interface FleetServiceConfig {
  port: number;
  healthEndpoint?: string;
  healthProtocol?: "http" | "tcp" | "container";
  healthCmd?: string;
  lifecycle?: {
    startCmd: string;
    stopCmd: string;
    startTimeoutMs?: number;
  };
}

export interface FleetConfig {
  nodes: Record<string, FleetNodeConfig>;
  routing: Record<string, { primary: string; fallback?: string[] }>;
}

export interface HealthResult {
  node: string;
  reachable: boolean;
  services: Record<string, { healthy: boolean; latencyMs: number; error?: string }>;
  timestamp: number;
}

export interface RoutingRecommendation {
  node: string;
  confidence: "preferred" | "fallback" | "last_resort";
  reason: string;
  waitSeconds: number | null;
}
