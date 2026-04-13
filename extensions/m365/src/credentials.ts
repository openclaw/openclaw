import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readJsonFileWithFallback,
  resolveOAuthDir,
  resolveStateDir,
  writeJsonFileAtomically,
} from "../runtime-api.js";

export const M365_CREDENTIAL_STORE_VERSION = 1;

export type M365DelegatedCredentials = {
  version: 1;
  identityId: string;
  tenantId: string;
  clientId: string;
  tokenType: "Bearer";
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  createdAt: string;
  updatedAt: string;
};

export type M365CredentialStore = {
  load: (identityId: string) => Promise<M365DelegatedCredentials | null>;
  save: (credentials: M365DelegatedCredentials) => Promise<void>;
  delete: (identityId: string) => Promise<void>;
  pathForIdentity: (identityId: string) => string;
};

export function sanitizeM365IdentityId(identityId: string): string {
  const trimmed = identityId.trim().toLowerCase();
  const safe = trimmed
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
  if (safe) {
    return safe;
  }
  return crypto.createHash("sha256").update(identityId).digest("hex").slice(0, 16);
}

export function resolveM365CredentialsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const stateDir = resolveStateDir(env, homedir);
  return path.join(resolveOAuthDir(env, stateDir), "m365");
}

export function resolveM365IdentityCredentialsPath(params: {
  identityId: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): string {
  const dir = resolveM365CredentialsDir(params.env, params.homedir);
  return path.join(dir, `identity-${sanitizeM365IdentityId(params.identityId)}.json`);
}

function isCredentialRecord(value: unknown): value is M365DelegatedCredentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<M365DelegatedCredentials>;
  return (
    record.version === M365_CREDENTIAL_STORE_VERSION &&
    typeof record.identityId === "string" &&
    typeof record.tenantId === "string" &&
    typeof record.clientId === "string" &&
    record.tokenType === "Bearer" &&
    typeof record.accessToken === "string" &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

export function createM365CredentialStore(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): M365CredentialStore {
  const env = params?.env ?? process.env;
  const homedir = params?.homedir ?? os.homedir;
  return {
    pathForIdentity(identityId: string) {
      return resolveM365IdentityCredentialsPath({ identityId, env, homedir });
    },
    async load(identityId: string) {
      const filePath = resolveM365IdentityCredentialsPath({ identityId, env, homedir });
      const { value } = await readJsonFileWithFallback<unknown>(filePath, null);
      if (!isCredentialRecord(value)) {
        return null;
      }
      return value;
    },
    async save(credentials: M365DelegatedCredentials) {
      const filePath = resolveM365IdentityCredentialsPath({
        identityId: credentials.identityId,
        env,
        homedir,
      });
      await writeJsonFileAtomically(filePath, credentials);
    },
    async delete(identityId: string) {
      const filePath = resolveM365IdentityCredentialsPath({ identityId, env, homedir });
      try {
        await fs.unlink(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw err;
      }
    },
  };
}

export function buildM365DelegatedCredentials(params: {
  identityId: string;
  tenantId: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes?: string[];
  existing?: M365DelegatedCredentials | null;
  now?: Date;
}): M365DelegatedCredentials {
  const now = (params.now ?? new Date()).toISOString();
  return {
    version: M365_CREDENTIAL_STORE_VERSION,
    identityId: params.identityId,
    tenantId: params.tenantId,
    clientId: params.clientId,
    tokenType: "Bearer",
    accessToken: params.accessToken,
    refreshToken: params.refreshToken ?? params.existing?.refreshToken,
    expiresAt: params.expiresAt,
    scopes: params.scopes ?? params.existing?.scopes,
    createdAt: params.existing?.createdAt ?? now,
    updatedAt: now,
  };
}
