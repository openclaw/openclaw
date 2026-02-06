export type GatewayStateVersion = {
  presence: number;
  health: number;
};

export type PresenceEntry = {
  instanceId?: string | null;
  host?: string | null;
  ip?: string | null;
  version?: string | null;
  platform?: string | null;
  deviceFamily?: string | null;
  modelIdentifier?: string | null;
  roles?: string[] | null;
  scopes?: string[] | null;
  mode?: string | null;
  lastInputSeconds?: number | null;
  reason?: string | null;
  text?: string | null;
  ts?: number | null;
  deviceId?: string | null;
  tags?: string[] | null;
};

export type HealthSnapshot = Record<string, unknown>;

export type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

export type GatewaySnapshot = {
  presence?: PresenceEntry[];
  health?: HealthSnapshot;
  sessionDefaults?: SessionDefaultsSnapshot;
  stateVersion?: GatewayStateVersion;
};
