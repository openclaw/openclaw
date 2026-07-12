// QA Lab static-SSH worker provider for cloud-worker feature development.
import type {
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
} from "openclaw/plugin-sdk/plugin-entry";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef, isValidSecretRef } from "openclaw/plugin-sdk/secret-input";

export const STATIC_SSH_WORKER_PROVIDER_ID = "static-ssh";

const STATIC_SSH_LEASE_PREFIX = `${STATIC_SSH_WORKER_PROVIDER_ID}:`;
const DEFAULT_SSH_PORT = 22;

function readRequiredString(profile: WorkerProfile, key: "host" | "user"): string {
  const value = profile[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkerProviderError(`static-ssh profile ${key} must be a non-empty string`);
  }
  return value.trim();
}

function parseStaticSshWorkerSettings(profile: WorkerProfile): WorkerSshEndpoint {
  const port = profile.port ?? DEFAULT_SSH_PORT;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WorkerProviderError(
      "static-ssh profile port must be an integer from 1 through 65535",
    );
  }
  const keyRef = profile.keyRef;
  if (!isSecretRef(keyRef) || !isValidSecretRef(keyRef)) {
    throw new WorkerProviderError("static-ssh profile keyRef must be a SecretRef");
  }
  return {
    host: readRequiredString(profile, "host"),
    port,
    user: readRequiredString(profile, "user"),
    keyRef,
  };
}

export function createStaticSshWorkerProvider(): WorkerProvider {
  return {
    id: STATIC_SSH_WORKER_PROVIDER_ID,
    async provision(profile, opId) {
      if (!opId.trim()) {
        throw new Error("static-ssh provision operation id must be non-empty");
      }
      return {
        leaseId: `${STATIC_SSH_LEASE_PREFIX}${opId}`,
        ssh: parseStaticSshWorkerSettings(profile),
      };
    },
    async inspect({ leaseId }) {
      const active =
        leaseId.startsWith(STATIC_SSH_LEASE_PREFIX) &&
        leaseId.length > STATIC_SSH_LEASE_PREFIX.length;
      return { status: active ? "active" : "unknown" };
    },
    // Development-only: a static worker is a shared host, not an isolation boundary.
    // Destroy releases the logical lease; it does not stop or clean the host.
    async destroy(_lease) {},
  };
}
