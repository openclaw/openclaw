import type { SecretProviderPlugin } from "openclaw/plugin-sdk/secret-provider";

const GCP_MODULE = "@google-cloud/secret-manager";

const SOURCE_ID = "gcp";

// GCP project id grammar:
// https://cloud.google.com/resource-manager/docs/creating-managing-projects#identifying_projects
// Permitted chars: lowercase letters, digits, dashes; must start with a letter; 6–30 chars total.
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

// Secret resource id grammar:
// https://cloud.google.com/secret-manager/docs/reference/rest/v1/projects.secrets/create#path-parameters
// Permitted chars: A-Z, a-z, 0-9, underscore, hyphen; 1–255 chars.
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

// Version suffix: "latest" or a positive integer.
const VERSION_PATTERN = /^(latest|[1-9][0-9]*)$/;

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
  source: typeof SOURCE_ID;
  project: string;
  versionSuffix?: string;
};

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
    id: SOURCE_ID,
    label: "Google Cloud Secret Manager",
    validateConfig(cfg) {
      if (typeof cfg !== "object" || cfg === null) {
        throw new Error(`GCP secret provider config must be an object with source "${SOURCE_ID}".`);
      }
      const c = cfg as Partial<GcpSecretProviderConfig>;
      if (c.source !== SOURCE_ID) {
        throw new Error(`GCP secret provider: config.source must be "${SOURCE_ID}".`);
      }
      if (typeof c.project !== "string" || !PROJECT_PATTERN.test(c.project)) {
        throw new Error(
          `GCP secret provider: config.project must match ${PROJECT_PATTERN.source} (GCP project id grammar).`,
        );
      }
      if (c.versionSuffix !== undefined) {
        if (typeof c.versionSuffix !== "string" || !VERSION_PATTERN.test(c.versionSuffix)) {
          throw new Error(
            `GCP secret provider: config.versionSuffix must match ${VERSION_PATTERN.source} (e.g. "latest" or "3").`,
          );
        }
      }
    },
    async resolve(ctx) {
      const cfg = ctx.providerConfig as GcpSecretProviderConfig;
      // resolve() is the runtime guard for ref ids — validateConfig only sees the static config.
      for (const ref of ctx.refs) {
        if (!SECRET_ID_PATTERN.test(ref.id)) {
          throw new Error(
            `GCP secret provider: ref id "${ref.id}" must match ${SECRET_ID_PATTERN.source}.`,
          );
        }
      }
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
