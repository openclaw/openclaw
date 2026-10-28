import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MANAGED_GITLAB_PROFILE_ID_PATTERN } from "../config/gitlab-identity-profile-id.js";
import { AgentGitLabToolIdentitySchema } from "../config/zod-schema.gitlab-identity.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  deleteHiddenGitLabSecretRecord,
  listHiddenGitLabSecretRecords,
  readHiddenGitLabSecretRecord,
  writeHiddenGitLabSecretRecord,
} from "../secrets/store/secret-store-hidden-managed-gitlab.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { GitLabAccount, GitLabOAuthTokens } from "./gitlab-oauth-client.js";

const time = z.number().int().nonnegative().safe();
const profileId = z.string().regex(MANAGED_GITLAB_PROFILE_ID_PATTERN);
const requestId = z.string().regex(/^gitlab-setup-[a-f0-9]{32}$/u);
const scope = z.enum(["system", "agent"]);
const agentId = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => normalizeAgentId(value) === value);
const issuer = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      url.pathname === "/" &&
      !url.hostname.endsWith(".")
    );
  } catch {
    return false;
  }
});
const identity = AgentGitLabToolIdentitySchema.unwrap().nullable();
const binding = z
  .strictObject({
    agentId,
    provenance: z
      .strictObject({
        agentId,
        createdVia: z.enum(["operator", "agent", "claw"]),
        creatorAgentId: agentId.nullable(),
        createdAtMs: time,
      })
      .nullable(),
  })
  .refine((value) => !value.provenance || value.provenance.agentId === value.agentId);
const setupSchema = z
  .strictObject({
    version: z.literal(1),
    requestId,
    scope,
    agentId,
    initiatorProfileId: z.string().min(1).max(256),
    issuer,
    configFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    expectedIdentity: identity,
    agentLifecycleBinding: binding.optional(),
    state: z.string().regex(/^gitlab-managed\.gitlab-setup-[a-f0-9]{32}\.[A-Za-z0-9_-]{43,128}$/u),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/u),
    createdAtMs: time,
    expiresAtMs: time,
  })
  .refine(
    (value) =>
      value.state.startsWith(`gitlab-managed.${value.requestId}.`) &&
      value.expiresAtMs > value.createdAtMs &&
      value.expiresAtMs <= value.createdAtMs + 10 * 60_000 &&
      (value.scope === "system"
        ? value.agentLifecycleBinding === undefined
        : value.agentLifecycleBinding?.agentId === value.agentId),
  );
const account = z.strictObject({
  accountId: z.number().int().positive().safe(),
  login: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  commitEmail: z.email().max(320),
  issuer,
});
const token = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim() === value && !/[\r\n\0]/u.test(value));
const tokens = z
  .strictObject({
    accessToken: token,
    refreshToken: token,
    expiresAtMs: time,
    scopes: z.array(z.string().regex(/^[a-z_]{1,64}$/u)).max(32),
  })
  .refine(
    (value) =>
      ["api", "write_repository"].every((required) => value.scopes.includes(required)) &&
      value.scopes.join("\0") === [...new Set(value.scopes)].toSorted().join("\0"),
  );
const pendingInitial = z.strictObject({
  requestId,
  expectedIdentity: identity,
  agentLifecycleBinding: binding.optional(),
});
const oauthSchema = z
  .strictObject({
    version: z.literal(1),
    profileId,
    scope,
    agentId,
    issuer,
    account,
    tokens,
    createdAtMs: time,
    pendingInitial: pendingInitial.optional(),
    refreshClaim: z.uuid().optional(),
    refreshFailure: z.enum(["failed", "expired"]).optional(),
  })
  .refine(
    (value) =>
      value.account.issuer === value.issuer &&
      value.tokens.expiresAtMs > value.createdAtMs &&
      (!value.pendingInitial ||
        value.scope === "system" ||
        value.pendingInitial.agentLifecycleBinding?.agentId === value.agentId) &&
      !(value.refreshClaim && value.refreshFailure),
  );

export type GitLabManagedSetupRecord = Readonly<z.infer<typeof setupSchema>>;
export type GitLabManagedOAuthRecord = Readonly<z.infer<typeof oauthSchema>>;
export type GitLabIdentityScope = z.infer<typeof scope>;

function redactSetup(record: GitLabManagedSetupRecord): void {
  registerSecretValueForRedaction(record.state);
  registerSecretValueForRedaction(record.verifier);
}
function redactOAuth(record: GitLabManagedOAuthRecord): void {
  registerSecretValueForRedaction(record.tokens.accessToken);
  registerSecretValueForRedaction(record.tokens.refreshToken);
}

export function createManagedGitLabProfileId(): string {
  return `glp_${randomBytes(16).toString("hex")}`;
}
export function createManagedGitLabSetupRequestId(): string {
  return `gitlab-setup-${randomBytes(16).toString("hex")}`;
}
export function gitLabManagedOAuthRecordName(id: string): string {
  profileId.parse(id);
  return `gitlab-oauth-${id.slice(4)}`;
}
function parse<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
      return undefined;
    }
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
export async function writeGitLabManagedSetupRecord(
  record: GitLabManagedSetupRecord,
): Promise<void> {
  const value = setupSchema.parse(record);
  await writeHiddenGitLabSecretRecord({
    name: value.requestId,
    value: JSON.stringify(value),
    expectedAbsent: true,
  });
  redactSetup(value);
}
export async function readGitLabManagedSetupRecord(
  id: string,
): Promise<GitLabManagedSetupRecord | undefined> {
  requestId.parse(id);
  const value = parse(await readHiddenGitLabSecretRecord({ name: id }), setupSchema);
  if (value?.requestId !== id || value.expiresAtMs <= Date.now()) {
    return undefined;
  }
  redactSetup(value);
  return value;
}
export async function deleteGitLabManagedSetupRecord(params: {
  requestId: string;
  initiatorProfileId: string;
}): Promise<boolean> {
  const record = await readGitLabManagedSetupRecord(params.requestId);
  if (!record || record.initiatorProfileId !== params.initiatorProfileId) {
    return false;
  }
  await deleteHiddenGitLabSecretRecord({ name: params.requestId });
  return true;
}
export async function listGitLabManagedSetupRecords(): Promise<GitLabManagedSetupRecord[]> {
  const rows = await listHiddenGitLabSecretRecords({ prefix: "gitlab-setup" });
  return rows.flatMap(({ name, value }) => {
    const record = parse(value, setupSchema);
    if (record?.requestId !== name || record.expiresAtMs <= Date.now()) {
      return [];
    }
    redactSetup(record);
    return [record];
  });
}
export async function consumeGitLabManagedSetupRecord(params: {
  requestId: string;
  state: string;
  initiatorProfileId: string;
}): Promise<GitLabManagedSetupRecord> {
  requestId.parse(params.requestId);
  setupSchema.shape.state.parse(params.state);
  const context = captureOpenClawStateWorkerContext();
  const raw = await runOpenClawStateWorkerOperation(context, (worker) =>
    worker.execute({
      type: "gitlabManagedSetup.consume",
      input: {
        name: params.requestId,
        state: params.state,
        initiatorProfileId: params.initiatorProfileId,
        now: Date.now(),
      },
    }),
  );
  if (raw !== undefined) {
    registerSecretValueForRedaction(raw);
  }
  const record = parse(raw, setupSchema);
  if (
    !record ||
    record.requestId !== params.requestId ||
    record.state !== params.state ||
    record.initiatorProfileId !== params.initiatorProfileId
  ) {
    throw new Error("Managed GitLab authorization changed or expired; start again.");
  }
  redactSetup(record);
  return record;
}
export async function writeGitLabManagedOAuthRecord(
  record: GitLabManagedOAuthRecord,
  expected?: GitLabManagedOAuthRecord,
): Promise<void> {
  const value = oauthSchema.parse(record);
  await writeHiddenGitLabSecretRecord({
    name: gitLabManagedOAuthRecordName(value.profileId),
    value: JSON.stringify(value),
    ...(expected
      ? { expectedValue: JSON.stringify(oauthSchema.parse(expected)) }
      : { expectedAbsent: true }),
  });
  redactOAuth(value);
}
export async function inspectGitLabManagedOAuthRecord(
  id: string,
): Promise<
  { state: "missing" } | { state: "invalid" } | { state: "valid"; record: GitLabManagedOAuthRecord }
> {
  const raw = await readHiddenGitLabSecretRecord({ name: gitLabManagedOAuthRecordName(id) });
  if (raw === undefined) {
    return { state: "missing" };
  }
  const record = parse(raw, oauthSchema);
  if (record?.profileId !== id) {
    return { state: "invalid" };
  }
  redactOAuth(record);
  return { state: "valid", record };
}
export async function listGitLabManagedOAuthRecords(): Promise<
  Array<{ profileId: string; record: GitLabManagedOAuthRecord | undefined }>
> {
  const rows = await listHiddenGitLabSecretRecords({ prefix: "gitlab-oauth" });
  return rows.flatMap(({ name, value }) => {
    const match = /^gitlab-oauth-([a-f0-9]{32})$/u.exec(name);
    if (!match) {
      return [];
    }
    const id = `glp_${match[1]}`;
    const record = parse(value, oauthSchema);
    if (record) {
      redactOAuth(record);
    }
    return [{ profileId: id, record }];
  });
}
export async function deleteGitLabManagedOAuthRecord(id: string): Promise<void> {
  await deleteHiddenGitLabSecretRecord({ name: gitLabManagedOAuthRecordName(id) });
}
export function createGitLabManagedOAuthRecord(params: {
  profileId: string;
  scope: GitLabIdentityScope;
  agentId: string;
  account: GitLabAccount;
  tokens: GitLabOAuthTokens;
  pendingInitial?: GitLabManagedOAuthRecord["pendingInitial"];
}): GitLabManagedOAuthRecord {
  const createdAtMs = Date.now();
  return oauthSchema.parse({
    version: 1,
    profileId: params.profileId,
    scope: params.scope,
    agentId: params.agentId,
    issuer: params.account.issuer,
    account: params.account,
    tokens: { ...params.tokens, scopes: [...new Set(params.tokens.scopes)].toSorted() },
    createdAtMs,
    ...(params.pendingInitial ? { pendingInitial: params.pendingInitial } : {}),
  });
}
