export type GatewaySnapshot = {
  configPath: string;
  connected: boolean;
  dashboardUrl: string;
  error: string | null;
  healthUrl: string;
  host: string;
  port: number;
  scheme: "ws" | "wss";
  statusLabel: string;
  tokenDetected: boolean;
  wsUrl: string;
};
