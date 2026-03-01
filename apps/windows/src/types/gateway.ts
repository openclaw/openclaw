export interface DiscoveredGateway {
  hostname: string;
  port: number;
  address: string;
  fullname: string;
  type: "local" | "wsl" | "remote" | "unknown";
}

export interface SSHConfig {
  user: string;
  key_path: string | null;
}

export interface GatewayStatus {
  connected: boolean;
  address: string;
  port: number;
  gatewayType: DiscoveredGateway["type"];
}
