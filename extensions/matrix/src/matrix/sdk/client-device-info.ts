import type { MatrixClient as MatrixJsClient } from "matrix-js-sdk/lib/matrix.js";
import type {
  MatrixOwnCrossSigningPublicationStatus,
  MatrixOwnDeviceInfo,
} from "./client-support.js";

export async function resolveMatrixCrossSigningPublicationStatus(params: {
  userId: string | null;
  query: () => Promise<{
    master_keys?: Record<string, unknown>;
    self_signing_keys?: Record<string, unknown>;
    user_signing_keys?: Record<string, unknown>;
  }>;
}): Promise<MatrixOwnCrossSigningPublicationStatus> {
  let response: Awaited<ReturnType<typeof params.query>> | undefined;
  if (params.userId) {
    try {
      response = await params.query();
    } catch {
      // Failed diagnostics report unpublished keys.
    }
  }
  const userId = params.userId || null;
  const masterKeyPublished = Boolean(userId && response?.master_keys?.[userId]);
  const selfSigningKeyPublished = Boolean(userId && response?.self_signing_keys?.[userId]);
  const userSigningKeyPublished = Boolean(userId && response?.user_signing_keys?.[userId]);
  return {
    userId,
    masterKeyPublished,
    selfSigningKeyPublished,
    userSigningKeyPublished,
    published: masterKeyPublished && selfSigningKeyPublished && userSigningKeyPublished,
  };
}

export async function listMatrixOwnDevices(client: MatrixJsClient): Promise<MatrixOwnDeviceInfo[]> {
  const currentDeviceId = client.getDeviceId()?.trim() || null;
  const devices = await client.getDevices();
  const entries = Array.isArray(devices?.devices) ? devices.devices : [];
  return entries.map((device) => ({
    deviceId: device.device_id,
    displayName: device.display_name?.trim() || null,
    lastSeenIp: device.last_seen_ip?.trim() || null,
    lastSeenTs:
      typeof device.last_seen_ts === "number" && Number.isFinite(device.last_seen_ts)
        ? device.last_seen_ts
        : null,
    current: currentDeviceId !== null && device.device_id === currentDeviceId,
  }));
}
