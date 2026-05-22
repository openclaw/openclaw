//#region src/shared/device-bootstrap-profile.d.ts
type DeviceBootstrapProfile = {
  roles: string[];
  scopes: string[];
};
type DeviceBootstrapProfileInput = {
  roles?: readonly string[];
  scopes?: readonly string[];
};
declare const PAIRING_SETUP_BOOTSTRAP_PROFILE: DeviceBootstrapProfile;
declare function normalizeDeviceBootstrapProfile(input: DeviceBootstrapProfileInput | undefined): DeviceBootstrapProfile;
//#endregion
//#region src/infra/device-pairing.d.ts
type DevicePairingPendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  silent?: boolean;
  isRepair?: boolean;
  ts: number;
};
type DeviceAuthToken = {
  token: string;
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};
type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  approvedScopes?: string[];
  remoteIp?: string;
  tokens?: Record<string, DeviceAuthToken>;
  createdAtMs: number;
  approvedAtMs: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};
type DevicePairingList = {
  pending: DevicePairingPendingRequest[];
  paired: PairedDevice[];
};
type DevicePairingForbiddenReason = "caller-scopes-required" | "caller-missing-scope" | "scope-outside-requested-roles" | "bootstrap-role-not-allowed" | "bootstrap-scope-not-allowed";
type DevicePairingForbiddenResult = {
  status: "forbidden";
  reason: DevicePairingForbiddenReason;
  scope?: string;
  role?: string;
};
type ApproveDevicePairingResult = {
  status: "approved";
  requestId: string;
  device: PairedDevice;
} | DevicePairingForbiddenResult | null;
declare function listDevicePairing(baseDir?: string): Promise<DevicePairingList>;
declare function approveDevicePairing(requestId: string, baseDir?: string): Promise<ApproveDevicePairingResult>;
declare function approveDevicePairing(requestId: string, options: {
  callerScopes?: readonly string[];
}, baseDir?: string): Promise<ApproveDevicePairingResult>;
//#endregion
//#region src/infra/device-bootstrap.d.ts
type DeviceBootstrapTokenRecord = {
  token: string;
  ts: number;
  deviceId?: string;
  publicKey?: string;
  profile?: DeviceBootstrapProfile;
  redeemedProfile?: DeviceBootstrapProfile;
  pendingProfile?: DeviceBootstrapProfile;
  roles?: string[];
  scopes?: string[];
  issuedAtMs: number;
  lastUsedAtMs?: number;
};
declare function issueDeviceBootstrapToken(params?: {
  baseDir?: string;
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
}): Promise<{
  token: string;
  expiresAtMs: number;
}>;
declare function clearDeviceBootstrapTokens(params?: {
  baseDir?: string;
}): Promise<{
  removed: number;
}>;
declare function revokeDeviceBootstrapToken(params: {
  token: string;
  baseDir?: string;
}): Promise<{
  removed: boolean;
  record?: DeviceBootstrapTokenRecord;
}>;
//#endregion
export { listDevicePairing as a, PAIRING_SETUP_BOOTSTRAP_PROFILE as c, approveDevicePairing as i, normalizeDeviceBootstrapProfile as l, issueDeviceBootstrapToken as n, DeviceBootstrapProfile as o, revokeDeviceBootstrapToken as r, DeviceBootstrapProfileInput as s, clearDeviceBootstrapTokens as t };