export function normalizeDeviceMetadataForAuth(value?: string | null): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

type DeviceAuthPayloadParams = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
};

type DeviceAuthPayloadV3Params = DeviceAuthPayloadParams & {
  platform?: string | null;
  deviceFamily?: string | null;
};

export type PersonalIdentityConnectIntent =
  | {
      mode: "personal-identity";
      provider: "tailscale";
      phase: "bind";
      bindingId: string;
      issuedAtMs: number;
    }
  | {
      mode: "personal-identity";
      provider: "tailscale";
      phase: "use";
      bindingId: string;
      profileId: string;
      gatewayId: string;
      issuedAtMs: number;
    };

type DeviceAuthPayloadV4Params = DeviceAuthPayloadV3Params & {
  personalIdentity: PersonalIdentityConnectIntent;
};

export function buildDeviceAuthPayload(params: DeviceAuthPayloadParams): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  return [
    "v2",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
  ].join("|");
}

export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  // Device signatures are byte-for-byte compared by the gateway. Normalize
  // optional metadata before joining so case differences do not break auth.
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

export function buildDeviceAuthPayloadV4(params: DeviceAuthPayloadV4Params): string {
  const scopes = params.scopes;
  const intent = params.personalIdentity;
  return JSON.stringify([
    "openclaw-device-auth",
    "v4",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeDeviceMetadataForAuth(params.platform),
    normalizeDeviceMetadataForAuth(params.deviceFamily),
    intent.phase === "bind"
      ? [intent.mode, intent.provider, intent.phase, intent.bindingId, String(intent.issuedAtMs)]
      : [
          intent.mode,
          intent.provider,
          intent.phase,
          intent.bindingId,
          intent.profileId,
          intent.gatewayId,
          String(intent.issuedAtMs),
        ],
  ]);
}
