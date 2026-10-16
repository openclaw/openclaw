import { createPrivateKey, createSign } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
import { readResponseWithLimit } from "../infra/http-response-body.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { GitHubAppSelection } from "./github-credential-reader.js";
import { GitHubIdentityError } from "./github-read-identity.js";
import type { GitHubToolAccount } from "./github-tool-account.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const permissions = z.record(z.string(), z.enum(["read", "write", "admin"]));
const repository = z.object({ id, full_name: z.string().max(256) });
const appSchema = z.object({ id, slug: z.string().regex(/^[A-Za-z0-9-]{1,39}$/u), permissions });
const installationSchema = z.object({
  id,
  app_id: id,
  account: z.object({ id }),
  suspended_at: z.string().nullable(),
  permissions,
});
const tokenSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[^\s\p{Cc}]+$/u),
  expires_at: z.string().datetime({ offset: true }),
  permissions,
});
const botSchema = z.object({
  id,
  login: z.string(),
  type: z.literal("Bot"),
  avatar_url: z.string().nullable(),
});
const repositoriesSchema = z.object({
  total_count: id,
  repositories: z.array(repository).max(100),
});

type PreparedAppCredential = {
  token: string;
  account: GitHubToolAccount;
  expiresAtMs: number;
  verifiedUntil: number;
  facts: {
    appId: number;
    installationId: number;
    accountId: number;
    repositories: { id: number; fullName: string }[];
    permissions: Record<string, "read" | "write">;
    suspended: false;
  };
};
type AppMetadata = Pick<PreparedAppCredential, "account" | "expiresAtMs" | "verifiedUntil">;
const metadata = new WeakMap<
  GitHubAppSelection,
  { snapshot: GitHubAppSelection; host: string; apiBaseUrl: string; value: AppMetadata }
>();
/** Display consumers reuse verified issuer facts without retaining or minting an execution token. */
export function readGitHubAppInstallationMetadata(
  selection: GitHubAppSelection,
  host: string,
  apiBaseUrl: string,
): AppMetadata | undefined {
  const record = metadata.get(selection);
  return record &&
    record.host === host &&
    record.apiBaseUrl === apiBaseUrl &&
    record.value.verifiedUntil > Date.now() &&
    isDeepStrictEqual(selection, record.snapshot)
    ? record.value
    : undefined;
}

function failure(): GitHubIdentityError {
  return new GitHubIdentityError("unverified");
}
function permits(actual: Record<string, string>, requested: Record<string, string>): boolean {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return Object.entries(requested).every(
    ([key, value]) => (rank[actual[key] ?? ""] ?? 0) >= (rank[value] ?? 0),
  );
}
function jwt(appId: number, key: string): string {
  const seconds = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: String(appId), iat: seconds - 60, exp: seconds + 540 })}`;
  const privateKey = createPrivateKey(key);
  if (privateKey.asymmetricKeyType !== "rsa") {
    throw failure();
  }
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

/** Each execution retains its own bounded installation token and revocation owner. */
export async function prepareGitHubAppInstallation(params: {
  selection: GitHubAppSelection;
  /** A caller-admitted subset; the original selection still owns display metadata and currency. */
  repositories?: GitHubAppSelection["app"]["repositories"];
  host: string;
  apiBaseUrl: string;
  assertCurrent: () => void;
}): Promise<
  PreparedAppCredential & { readToken: () => Promise<string>; revoke: () => Promise<void> }
> {
  const snapshot = structuredClone(params.selection);
  let closed = false;
  let revocation: Promise<void> | undefined;
  const assertCurrent = () => {
    params.assertCurrent();
    if (closed || !isDeepStrictEqual(params.selection, snapshot)) {
      throw new GitHubIdentityError("changed");
    }
  };
  const issued = await issueGitHubAppInstallation({
    ...params,
    snapshot,
    verificationStartedAt: Date.now(),
    assertCurrent,
  });
  const revoke = () => {
    closed = true;
    revocation ??= fetch(`${params.apiBaseUrl}/installation/token`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${issued.value.token}` },
    }).then(async (response) => {
      await response.body?.cancel().catch(() => {});
      // An expired or already-revoked installation token has no remaining custody.
      if (!response.ok && response.status !== 401 && issued.value.expiresAtMs > Date.now()) {
        throw new Error("GitHub App token revocation failed");
      }
    });
    return revocation;
  };
  const readToken = async () => {
    assertCurrent();
    if (issued.value.expiresAtMs <= Date.now()) {
      throw new GitHubIdentityError("changed");
    }
    return issued.value.token;
  };
  try {
    await readToken();
  } catch (error) {
    await revoke().catch(() => {});
    throw error;
  }
  return { ...issued.value, readToken, revoke };
}

async function issueGitHubAppInstallation(params: {
  selection: GitHubAppSelection;
  repositories?: GitHubAppSelection["app"]["repositories"];
  host: string;
  apiBaseUrl: string;
  snapshot: GitHubAppSelection;
  verificationStartedAt: number;
  assertCurrent: () => void;
}): Promise<{ value: PreparedAppCredential }> {
  const { selection, apiBaseUrl, snapshot, verificationStartedAt } = params;
  const repositories = params.repositories ?? selection.app.repositories;
  const requestedPermissions = { metadata: "read" as const, ...selection.app.permissions };
  const assertCurrent = () => {
    params.assertCurrent();
    if (!isDeepStrictEqual(selection, snapshot)) {
      throw new GitHubIdentityError("changed");
    }
  };
  const key = normalizeResolvedSecretInputString({
    value: selection.app.privateKey,
    path: "tools.github.app.privateKey",
  });
  if (!key) {
    throw new GitHubIdentityError("unavailable");
  }
  registerSecretValueForRedaction(key);
  let issuedToken: string | undefined;
  const signal = AbortSignal.timeout(10_000);
  const request = async <T>(
    endpoint: string,
    bearer: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> => {
    assertCurrent();
    const response = await fetch(`${apiBaseUrl}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw failure();
    }
    const bytes = await readResponseWithLimit(response, 256 * 1024, { signal });
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    if (body !== undefined) {
      const token = z.object({ token: tokenSchema.shape.token }).safeParse(raw);
      if (token.success) {
        issuedToken = token.data.token;
        registerSecretValueForRedaction(issuedToken);
      }
    }
    assertCurrent();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw failure();
    }
    return parsed.data;
  };
  try {
    const bearer = jwt(selection.app.appId, key);
    registerSecretValueForRedaction(bearer);
    const app = await request("/app", bearer, appSchema);
    if (app.id !== selection.app.appId || !permits(app.permissions, requestedPermissions)) {
      throw failure();
    }
    const installation = await request(
      `/app/installations/${selection.app.installationId}`,
      bearer,
      installationSchema,
    );
    if (
      installation.id !== selection.app.installationId ||
      installation.app_id !== app.id ||
      installation.account.id !== selection.app.accountId ||
      installation.suspended_at !== null ||
      !permits(installation.permissions, requestedPermissions)
    ) {
      throw failure();
    }
    const botLogin = `${app.slug}[bot]`;
    const minted = await request(
      `/app/installations/${installation.id}/access_tokens`,
      bearer,
      tokenSchema,
      {
        repository_ids: repositories.map((value) => value.id),
        permissions: requestedPermissions,
      },
    );
    issuedToken = minted.token;
    registerSecretValueForRedaction(issuedToken);
    const expiresAtMs = Date.parse(minted.expires_at);
    if (
      expiresAtMs <= Date.now() ||
      expiresAtMs > Date.now() + 65 * 60_000 ||
      !isDeepStrictEqual(minted.permissions, requestedPermissions)
    ) {
      throw failure();
    }
    const bot = await request(`/users/${encodeURIComponent(botLogin)}`, minted.token, botSchema);
    if (bot.login !== botLogin) {
      throw failure();
    }
    const repos = await request(
      "/installation/repositories?per_page=100",
      minted.token,
      repositoriesSchema,
    );
    if (
      repos.total_count !== repositories.length ||
      repos.repositories.length !== repos.total_count ||
      !repositories.every((expected) =>
        repos.repositories.some(
          (actual) =>
            actual.id === expected.id &&
            actual.full_name.toLowerCase() === expected.fullName.toLowerCase(),
        ),
      )
    ) {
      throw failure();
    }
    assertCurrent();
    const value: PreparedAppCredential = {
      token: minted.token,
      expiresAtMs,
      verifiedUntil: Math.min(verificationStartedAt + 300_000, expiresAtMs),
      account: { accountId: bot.id, login: bot.login, avatarUrl: bot.avatar_url },
      facts: {
        appId: app.id,
        installationId: installation.id,
        accountId: installation.account.id,
        repositories: snapshot.app.repositories.filter((repo) =>
          repositories.some((requested) => requested.id === repo.id),
        ),
        permissions: requestedPermissions,
        suspended: false,
      },
    };
    metadata.set(selection, {
      snapshot,
      host: params.host,
      apiBaseUrl,
      value: {
        account: value.account,
        expiresAtMs,
        verifiedUntil: value.verifiedUntil,
      },
    });
    return { value };
  } catch (error) {
    // A failed grant never escapes. Cleanup is bounded and cannot re-authorize work.
    if (issuedToken) {
      await fetch(`${apiBaseUrl}/installation/token`, {
        method: "DELETE",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${issuedToken}` },
      }).then(
        (response) => {
          void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
    }
    assertCurrent();
    throw error instanceof GitHubIdentityError ? error : failure();
  }
}
