export type GatewaySnapshot = {
  configPath: string;
  connected: boolean;
  dashboardUrl: string;
  error: string | null;
  host: string;
  port: number;
  scheme: "ws" | "wss";
  statusLabel: string;
  tokenDetected: boolean;
  wsUrl: string;
};
