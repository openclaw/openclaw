import type { SecretProviderPlugin } from "openclaw/plugin-sdk/secret-provider";

const GCP_MODULE = "@google-cloud/secret-manager";

interface GcpSecretManagerClient {
  accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: unknown } }]>;
}

type GcpModule = {
  SecretManagerServiceClient?: new () => GcpSecretManagerClient;
  default?: { SecretManagerServiceClient?: new () => GcpSecretManagerClient };
};

let gcpClient: GcpSecretManagerClient | null = null;

async function getGcpClient(): Promise<GcpSecretManagerClient> {
  if (gcpClient) {
    return gcpClient;
  }
  const mod = (await import(GCP_MODULE)) as GcpModule;
  const Ctor = mod.SecretManagerServiceClient ?? mod.default?.SecretManagerServiceClient;
  if (!Ctor) {
    throw new Error(`${GCP_MODULE}: SecretManagerServiceClient export not found.`);
  }
  gcpClient = new Ctor();
  return gcpClient;
}

type GcpSecretProviderConfig = {
  source: "gcp";
  project: string;
  versionSuffix?: string;
};

function isGcpConfig(value: unknown): value is GcpSecretProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const cfg = value as { source?: unknown; project?: unknown };
  return cfg.source === "gcp" && typeof cfg.project === "string" && cfg.project.trim().length > 0;
}

function decodePayload(payload: unknown, refId: string): string {
  if (payload === undefined || payload === null) {
    throw new Error(`GCP secret "${refId}" has no payload data.`);
  }
  if (typeof payload === "string") {
    return payload;
  }
  if (payload instanceof Uint8Array || Buffer.isBuffer(payload)) {
    return Buffer.from(payload).toString("utf-8");
  }
  throw new Error(`GCP secret "${refId}" has unexpected payload type.`);
}

export function createGcpSecretProvider(): SecretProviderPlugin {
  return {
    id: "gcp",
    label: "Google Cloud Secret Manager",
    validateConfig(cfg) {
      if (!isGcpConfig(cfg)) {
        throw new Error(
          'GCP secret provider config requires a non-empty "project" string and source "gcp".',
        );
      }
    },
    async resolve(ctx) {
      const cfg = ctx.providerConfig as GcpSecretProviderConfig;
      const client = await getGcpClient();
      const out = new Map<string, unknown>();
      const version = cfg.versionSuffix ?? "latest";
      for (const ref of ctx.refs) {
        const name = `projects/${cfg.project}/secrets/${ref.id}/versions/${version}`;
        const [response] = await client.accessSecretVersion({ name });
        out.set(ref.id, decodePayload(response.payload?.data, ref.id));
      }
      return out;
    },
  };
}
