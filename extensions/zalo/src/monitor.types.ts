export type ZaloRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type ZaloStatusSink = (patch: {
  connected?: boolean;
  lifecycle?: "ready" | "recovering";
  terminalDisconnect?: boolean;
  lastConnectedAt?: number;
  lastError?: string | null;
  lastInboundAt?: number;
  lastOutboundAt?: number;
}) => void;
