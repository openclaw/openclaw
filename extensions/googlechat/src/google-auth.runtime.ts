import fs from "node:fs/promises";
import {
  buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type GoogleAuthModule = typeof import("google-auth-library");
type GaxiosModule = typeof import("gaxios");
type GoogleAuthRuntime = {
  Gaxios: GaxiosModule["Gaxios"];
  GoogleAuth: GoogleAuthModule["GoogleAuth"];
  OAuth2Client: GoogleAuthModule["OAuth2Client"];
};
type GoogleAuthTransport = InstanceType<GaxiosModule["Gaxios"]>;
type GuardedGoogleAuthRequestInit = RequestInit & {
  agent?: unknown;
  cert?: unknown;
  fetchImplementation?: unknown;
  key?: unknown;
  noProxy?: unknown;
  proxy?: unknown;
};
type GoogleChatServiceAccountCredentials = Record<string, unknown> & {
  auth_provider_x509_cert_url?: string;
  auth_uri?: string;
  client_email: string;
  client_x509_cert_url?: string;
  private_key: string;
  token_uri?: string;
  type?: string;
  universe_domain?: string;
};

const GOOGLE_AUTH_ALLOWED_HOST_SUFFIXES = ["accounts.google.com", "googleapis.com"];
const GOOGLE_AUTH_POLICY = buildHostnameAllowlistPolicyFromSuffixAllowlist(
  GOOGLE_AUTH_ALLOWED_HOST_SUFFIXES,
);
const GOOGLE_AUTH_AUDIT_CONTEXT = "googlechat.auth.google-auth";
const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
const GOOGLE_AUTH_PROVIDER_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const GOOGLE_AUTH_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_UNIVERSE_DOMAIN = "googleapis.com";
const GOOGLE_CLIENT_CERTS_URL_PREFIX = "https://www.googleapis.com/robot/v1/metadata/x509/";
const MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES = 64 * 1024;

let googleAuthRuntimePromise: Promise<GoogleAuthRuntime> | null = null;
let googleAuthTransportPromise: Promise<GoogleAuthTransport> | null = null;

function readOptionalTrimmedString(
  record: Record<string, unknown>,
  fieldName: string,
): string | undefined {
  const value = record[fieldName];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Google Chat service account field "${fieldName}" must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Google Chat service account field "${fieldName}" cannot be empty`);
  }
  return trimmed;
}

function readRequiredTrimmedString(record: Record<string, unknown>, fieldName: string): string {
  return (
    readOptionalTrimmedString(record, fieldName) ??
    (() => {
      throw new Error(`Google Chat service account is missing "${fieldName}"`);
    })()
  );
}

function assertExactUrlField(
  record: Record<string, unknown>,
  fieldName: string,
  expectedUrl: string,
): void {
  const value = readOptionalTrimmedString(record, fieldName);
  if (!value) {
    return;
  }
  if (value !== expectedUrl) {
    throw new Error(
      `Google Chat service account field "${fieldName}" must be ${expectedUrl}, got ${value}`,
    );
  }
}

function assertUrlPrefixField(
  record: Record<string, unknown>,
  fieldName: string,
  expectedPrefix: string,
): void {
  const value = readOptionalTrimmedString(record, fieldName);
  if (!value) {
    return;
  }
  if (!value.startsWith(expectedPrefix)) {
    throw new Error(
      `Google Chat service account field "${fieldName}" must start with ${expectedPrefix}, got ${value}`,
    );
  }
}

function validateGoogleChatServiceAccountCredentials(
  credentials: Record<string, unknown>,
): GoogleChatServiceAccountCredentials {
  const type = readOptionalTrimmedString(credentials, "type");
  if (type && type !== "service_account") {
    throw new Error(`Google Chat credentials must use service_account auth, got "${type}" instead`);
  }

  readRequiredTrimmedString(credentials, "client_email");
  readRequiredTrimmedString(credentials, "private_key");

  const universeDomain = readOptionalTrimmedString(credentials, "universe_domain");
  if (universeDomain && universeDomain !== GOOGLE_AUTH_UNIVERSE_DOMAIN) {
    throw new Error(
      `Google Chat service account field "universe_domain" must be ${GOOGLE_AUTH_UNIVERSE_DOMAIN}, got ${universeDomain}`,
    );
  }

  assertExactUrlField(credentials, "auth_uri", GOOGLE_AUTH_URI);
  assertExactUrlField(credentials, "auth_provider_x509_cert_url", GOOGLE_AUTH_PROVIDER_CERTS_URL);
  assertExactUrlField(credentials, "token_uri", GOOGLE_AUTH_TOKEN_URI);
  assertUrlPrefixField(credentials, "client_x509_cert_url", GOOGLE_CLIENT_CERTS_URL_PREFIX);

  return credentials as GoogleChatServiceAccountCredentials;
}

async function readCredentialsFile(filePath: string): Promise<Record<string, unknown>> {
  const resolvedPath = resolveUserPath(filePath);
  if (!resolvedPath) {
    throw new Error("Google Chat service account file path is empty");
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(resolvedPath);
  } catch (error) {
    throw new Error("Failed to load Google Chat service account file.", { cause: error });
  }

  if (stat.isSymbolicLink()) {
    throw new Error("Google Chat service account file must not be a symlink.");
  }
  if (!stat.isFile()) {
    throw new Error("Google Chat service account file must be a regular file.");
  }
  if (stat.size > MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES) {
    throw new Error(
      `Google Chat service account file exceeds ${MAX_GOOGLE_CHAT_SERVICE_ACCOUNT_FILE_BYTES} bytes.`,
    );
  }

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    throw new Error("Failed to load Google Chat service account file.", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid Google Chat service account JSON.", { cause: error });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google Chat service account file must contain a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function sanitizeGoogleAuthInit(init?: RequestInit): RequestInit | undefined {
  if (!init) {
    return undefined;
  }
  const nextInit = { ...(init as GuardedGoogleAuthRequestInit) };
  delete nextInit.agent;
  delete nextInit.cert;
  delete nextInit.fetchImplementation;
  delete nextInit.key;
  delete nextInit.noProxy;
  delete nextInit.proxy;
  return nextInit;
}

async function releaseGuardedResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  release: () => Promise<void>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Ignore cancel failures; the guarded dispatcher still needs cleanup.
  }
  await release();
}

function wrapGuardedResponse(response: Response, release: () => Promise<void>): Response {
  let released = false;
  const releaseOnce = async () => {
    if (released) {
      return;
    }
    released = true;
    await release();
  };

  if (!response.body) {
    void releaseOnce();
    return new Response(null, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await releaseOnce();
      }
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await releaseOnce();
          return;
        }
        if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        await releaseGuardedResponseBody(reader, releaseOnce);
      }
    },
  });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createGoogleAuthFetch(
  baseFetch: FetchLike = globalThis.fetch.bind(globalThis),
): FetchLike {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const { response, release } = await fetchWithSsrFGuard({
      auditContext: GOOGLE_AUTH_AUDIT_CONTEXT,
      fetchImpl: baseFetch,
      init: sanitizeGoogleAuthInit(init),
      policy: GOOGLE_AUTH_POLICY,
      url,
    });
    return wrapGuardedResponse(response, release);
  };
}

export async function loadGoogleAuthRuntime(): Promise<GoogleAuthRuntime> {
  if (!googleAuthRuntimePromise) {
    googleAuthRuntimePromise = (async () => {
      try {
        const [googleAuthModule, gaxiosModule] = await Promise.all([
          import("google-auth-library"),
          import("gaxios"),
        ]);
        return {
          Gaxios: gaxiosModule.Gaxios,
          GoogleAuth: googleAuthModule.GoogleAuth,
          OAuth2Client: googleAuthModule.OAuth2Client,
        };
      } catch (error) {
        googleAuthRuntimePromise = null;
        throw error;
      }
    })();
  }
  return await googleAuthRuntimePromise;
}

export async function getGoogleAuthTransport(): Promise<GoogleAuthTransport> {
  if (!googleAuthTransportPromise) {
    googleAuthTransportPromise = (async () => {
      try {
        const { Gaxios } = await loadGoogleAuthRuntime();
        return new Gaxios({
          fetchImplementation: createGoogleAuthFetch(),
        });
      } catch (error) {
        googleAuthTransportPromise = null;
        throw error;
      }
    })();
  }
  return await googleAuthTransportPromise;
}

export async function resolveValidatedGoogleChatCredentials(
  account: ResolvedGoogleChatAccount,
): Promise<GoogleChatServiceAccountCredentials | null> {
  if (account.credentials) {
    return validateGoogleChatServiceAccountCredentials(account.credentials);
  }
  if (account.credentialsFile) {
    const fileCredentials = await readCredentialsFile(account.credentialsFile);
    return validateGoogleChatServiceAccountCredentials(fileCredentials);
  }
  return null;
}

export const __testing = {
  resetGoogleAuthRuntimeForTests(): void {
    googleAuthRuntimePromise = null;
    googleAuthTransportPromise = null;
  },
  validateGoogleChatServiceAccountCredentials,
};
