import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  PluginGatewayAccessAuthority,
  PluginLogger,
  PluginRuntime,
  PluginStateKeyedStore,
} from "../api.js";
import type { ReadVisitorGatewayAccess } from "./access.js";
import { visitorTargetKey, type VisitorTarget, type VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";
import type {
  VisitorInviteDetails,
  VisitorListDetails,
  VisitorRevokeDetails,
} from "./tool-results.js";

export type VisitorGrant = ({ email: string } | { githubAccountId: number }) & {
  grantId?: string;
  githubLogin?: string;
  invitedVia?: string;
  createdAt: number;
  expiresAt: number | null;
};

function visitorGrantTarget(grant: VisitorGrant): VisitorTarget {
  return "email" in grant ? grant.email : grant.githubAccountId;
}

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((email) => email.toLowerCase());
const identityFields = {
  github: z
    .string()
    .trim()
    .min(1)
    .transform((login) => login.toLowerCase())
    .optional(),
  email: emailSchema.optional(),
};
const revokeSchema = z.strictObject({
  ...identityFields,
  profileId: z.string().trim().min(1).max(128).optional(),
  grantId: z.uuid().optional(),
});
const inviteSchema = z
  .strictObject({
    ...identityFields,
    days: z.number().int().min(1).max(3650).optional(),
    forever: z.boolean().optional(),
  })
  .refine((input) => (input.email !== undefined) !== (input.github !== undefined));
const grantIdSchema = z.uuid();
const DAY_MS = 86_400_000;
const LIST_MAX_CHARS = 12_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SIGN_IN_URL = "https://team.openclaw.ai";

type LiveVisitorGrant = {
  grant: VisitorGrant;
  controller: AbortController;
};

function parseVisitorInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new VisitorAccessError(
      "Invalid visitor input. Use a valid email or GitHub login, days from 1 to 3650, or forever: true.",
    );
  }
  return result.data;
}

function expiryText(expiresAt: number | null): string {
  return expiresAt === null ? "never (explicit forever grant)" : new Date(expiresAt).toISOString();
}

export class VisitorAccessService {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly grants = new Map<string, LiveVisitorGrant>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private initialized: Promise<void> | undefined;
  private ready = false;
  private closed = false;

  constructor(
    private readonly config: VisitorAccessConfig,
    private readonly store: PluginStateKeyedStore<VisitorGrant>,
    private readonly policy: VisitorPolicyClient,
    private readonly logger: PluginLogger,
    private readonly readAccess: ReadVisitorGatewayAccess,
    private readonly resolveGitHubAccount: PluginRuntime["gateway"]["resolveGitHubAccount"],
    private readonly signal?: AbortSignal,
  ) {}

  initialize(): Promise<void> {
    return (this.initialized ??= this.serialize(async () => {
      const entries = await this.store.entries();
      this.assertOpen();
      for (const { value } of entries) {
        if (
          grantIdSchema.safeParse(value.grantId).success ||
          (value.expiresAt !== null && value.expiresAt <= Date.now())
        ) {
          this.publishGrant(value);
        }
      }
      this.ready = true;
      this.scheduleExpiry();
    }));
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const { controller } of this.grants.values()) {
      controller.abort(new VisitorAccessError("Visitor access is stopping."));
    }
    this.grants.clear();
  }

  private assertOpen(): void {
    this.signal?.throwIfAborted();
    if (this.closed) {
      throw new VisitorAccessError("Visitor access is stopping; retry after the Gateway starts.");
    }
  }

  authorize(
    emails: readonly string[],
    githubAccountIds: readonly number[] = [],
  ): PluginGatewayAccessAuthority {
    const authority = this.readAuthority(emails, undefined, githubAccountIds);
    if (!authority) {
      throw new VisitorAccessError(
        "An active visitor invitation is required. Ask a maintainer to invite or renew access.",
      );
    }
    return authority;
  }

  /** Unlike admission, an unavailable grant map must leave durable requests pending. */
  resume(
    emails: readonly string[],
    grantId: string,
    githubAccountIds: readonly number[] = [],
  ): PluginGatewayAccessAuthority | undefined {
    return this.readAuthority(emails, grantId, githubAccountIds);
  }

  private readAuthority(
    emails: readonly string[],
    grantId?: string,
    githubAccountIds: readonly number[] = [],
  ): PluginGatewayAccessAuthority | undefined {
    this.assertOpen();
    if (!this.ready) {
      throw new VisitorAccessError("Visitor access is starting; retry shortly.");
    }
    const now = Date.now();
    const state = [
      ...emails.map((email) => email.trim().toLowerCase()),
      ...githubAccountIds.map(visitorTargetKey),
    ]
      .map((key) => this.grants.get(key))
      .find(
        (entry) =>
          entry &&
          grantIdSchema.safeParse(entry.grant.grantId).success &&
          (grantId === undefined || entry.grant.grantId === grantId) &&
          !entry.controller.signal.aborted &&
          (entry.grant.expiresAt === null || entry.grant.expiresAt > now),
      );
    if (!state) {
      return undefined;
    }
    const assertCurrent = () => {
      this.assertOpen();
      if (state.grant.expiresAt !== null && state.grant.expiresAt <= Date.now()) {
        state.controller.abort(new VisitorAccessError("Visitor access expired."));
      }
      if (
        this.grants.get(visitorTargetKey(visitorGrantTarget(state.grant))) !== state ||
        state.controller.signal.aborted
      ) {
        throw new VisitorAccessError("Visitor access ended. Ask a maintainer to renew access.");
      }
    };
    return Object.freeze({
      grantId: state.grant.grantId,
      assertCurrent,
      signal: this.signal
        ? AbortSignal.any([state.controller.signal, this.signal])
        : state.controller.signal,
    });
  }

  private publishGrant(grant: VisitorGrant): void {
    if (this.closed) {
      return;
    }
    const key = visitorTargetKey(visitorGrantTarget(grant));
    const previous = this.grants.get(key);
    if (previous && previous.grant.grantId !== grant.grantId) {
      previous.controller.abort(new VisitorAccessError("Visitor access was replaced."));
    }
    if (previous && previous.grant.expiresAt !== null && previous.grant.expiresAt <= Date.now()) {
      previous.controller.abort(new VisitorAccessError("Visitor access expired."));
    }
    const state =
      previous && !previous.controller.signal.aborted
        ? previous
        : { grant, controller: new AbortController() };
    state.grant = grant;
    this.grants.set(key, state);
    if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) {
      state.controller.abort(new VisitorAccessError("Visitor access ended."));
    }
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.closed) {
      return;
    }
    let next = Infinity;
    for (const { grant, controller } of this.grants.values()) {
      if (!controller.signal.aborted && grant.expiresAt !== null) {
        next = Math.min(next, grant.expiresAt);
      }
    }
    if (next === Infinity) {
      return;
    }
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = undefined;
        const now = Date.now();
        for (const { grant, controller } of this.grants.values()) {
          if (grant.expiresAt !== null && grant.expiresAt <= now) {
            controller.abort(new VisitorAccessError("Visitor access expired."));
          }
        }
        this.scheduleExpiry();
      },
      Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)),
    );
    this.expiryTimer.unref();
  }

  private async registerGrant(
    grant: VisitorGrant,
    store: PluginStateKeyedStore<VisitorGrant, 2>,
  ): Promise<void> {
    this.assertOpen();
    await store.register(visitorTargetKey(visitorGrantTarget(grant)), grant);
    this.publishGrant(grant);
    this.scheduleExpiry();
  }

  private async deleteGrant(
    email: string,
    store: PluginStateKeyedStore<VisitorGrant, 2>,
  ): Promise<void> {
    this.assertOpen();
    await store.delete(email);
    this.grants.get(email)?.controller.abort(new VisitorAccessError("Visitor access ended."));
    this.grants.delete(email);
    this.scheduleExpiry();
  }

  // One queue owns the policy read/modify/write and its corresponding durable record.
  // Cloudflare has no cross-store transaction; keep records until revocation succeeds.
  private serialize<T>(operation: () => Promise<T>, assertCurrent?: () => void): Promise<T> {
    const result = this.pending.then(() => {
      this.assertOpen();
      assertCurrent?.();
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  async waitForIdle(): Promise<void> {
    await this.pending;
  }

  private actionStore(assertCurrent?: () => void): PluginStateKeyedStore<VisitorGrant, 2> {
    if (!this.store.withCurrent) {
      throw new VisitorAccessError(
        "This Gateway cannot authorize visitor grant writes. Update OpenClaw before managing visitors.",
      );
    }
    return this.store.withCurrent({
      assertCurrent: () => {
        this.assertOpen();
        assertCurrent?.();
      },
    });
  }

  private async resolveTarget(input: {
    email?: string;
    github?: string;
  }): Promise<{ target: VisitorTarget; githubLogin?: string }> {
    if (input.email) {
      return { target: input.email };
    }
    if (!input.github) {
      throw new VisitorAccessError("Provide an email or GitHub login.");
    }
    if (!this.resolveGitHubAccount) {
      throw new VisitorAccessError(
        "This Gateway cannot resolve GitHub accounts. Update OpenClaw before managing GitHub visitors.",
      );
    }
    const result = await this.resolveGitHubAccount({ login: input.github, signal: this.signal });
    this.assertOpen();
    if (result.error) {
      const { statusCode, retryAtMs, credentialConfigured, message } = result.error;
      if (statusCode === 404) {
        throw new VisitorAccessError(
          `GitHub login ${input.github} was not found. Check the login and retry.`,
        );
      }
      if (statusCode === 429) {
        const retry =
          retryAtMs === undefined
            ? "retry later"
            : `retry after ${new Date(retryAtMs).toISOString()}`;
        const hint = credentialConfigured
          ? ""
          : " Configure gateway.controlUi.github.token to increase the GitHub API quota.";
        throw new VisitorAccessError(
          `GitHub rate limit reached while resolving ${input.github}; ${retry}.${hint}`,
        );
      }
      throw new VisitorAccessError(`GitHub account lookup failed (${message}). Retry later.`);
    }
    return { target: result.accountId, githubLogin: result.login };
  }

  invite(
    raw: unknown,
    { invitedVia, assertCurrent }: { invitedVia?: string; assertCurrent: () => void },
  ): Promise<{ text: string; details: VisitorInviteDetails }> {
    return this.serialize(async () => {
      const store = this.actionStore(assertCurrent);
      const input = parseVisitorInput(inviteSchema, raw);
      if (input.forever && input.days !== undefined) {
        throw new VisitorAccessError("Choose days or forever: true, not both.");
      }
      const days = input.days ?? this.config.defaultTtlDays;
      let expiresAt: number | null = null;
      if (!input.forever) {
        if (!days) {
          throw new VisitorAccessError(
            "No default duration is configured. Pass days or explicitly pass forever: true.",
          );
        }
        expiresAt = Date.now() + days * DAY_MS;
      }
      const { target, githubLogin: resolvedLogin } = await this.resolveTarget(input);
      if (typeof target === "number") {
        this.policy.assertGithubConfigured();
      }
      const key = visitorTargetKey(target);
      const previous = await store.lookup(key);
      const now = Date.now();
      const githubLogin = resolvedLogin ?? previous?.githubLogin;
      const provenance = invitedVia?.slice(0, 256) ?? previous?.invitedVia;
      const grant: VisitorGrant = {
        ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
        ...(githubLogin ? { githubLogin } : {}),
        ...(provenance ? { invitedVia: provenance } : {}),
        createdAt: previous?.createdAt ?? now,
        expiresAt,
      };
      let gatewayAccess = "";
      await this.policy.update(async (targets) => {
        const entries = await store.entries();
        const known = new Set([
          ...targets.map(visitorTargetKey),
          ...entries.map((entry) => entry.key),
        ]);
        if (!known.has(key) && known.size >= this.config.maxVisitors) {
          throw new VisitorAccessError(
            `Visitor limit (${this.config.maxVisitors}) reached. Revoke an existing visitor before inviting another.`,
          );
        }
        const access = await this.readAccess(typeof target === "number" ? [target] : []);
        access.assertInvitable(target);
        gatewayAccess = access.describe(target);
        // A lost provider response still needs cleanup, without granting access.
        // Existing grants keep their deadline until the provider confirms renewal.
        if (!previous) {
          await this.registerGrant({ ...grant, expiresAt: now }, store);
        }
        return [...new Set([...targets, target])];
      }, assertCurrent);
      const continuous =
        previous &&
        grantIdSchema.safeParse(previous.grantId).success &&
        (previous.expiresAt === null || previous.expiresAt > Date.now());
      const grantId = continuous ? grantIdSchema.parse(previous.grantId) : randomUUID();
      grant.grantId = grantId;
      await this.registerGrant(
        grant,
        continuous
          ? this.actionStore(() => {
              assertCurrent();
              if (previous.expiresAt !== null && previous.expiresAt <= Date.now()) {
                throw new VisitorAccessError(
                  "The previous visitor grant expired before renewal was recorded. Check the grant and invite again.",
                );
              }
            })
          : store,
      );
      const who =
        typeof target === "number"
          ? `@${grant.githubLogin} (GitHub account ${target})`
          : grant.githubLogin
            ? `@${grant.githubLogin} (${target})`
            : target;
      return {
        text: `${previous ? "Renewed" : "Invited"} ${who}. Invitation ID: ${grantId}. Visitor grant expires: ${expiryText(grant.expiresAt)}. ${gatewayAccess}. Sign in at ${SIGN_IN_URL} using Team's existing login with ${typeof target === "number" ? "this GitHub account" : "this email"}. The link itself does not grant access.`,
        details: {
          outcome: previous ? "renewed" : "invited",
          grantId,
          ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
          ...(grant.githubLogin ? { githubLogin: grant.githubLogin } : {}),
          expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
          gatewayAccess,
          signInUrl: SIGN_IN_URL,
        },
      };
    }, assertCurrent);
  }

  revoke(
    raw: unknown,
    assertCurrent: () => void,
  ): Promise<{ text: string; details: VisitorRevokeDetails }> {
    return this.serialize(async () => {
      const store = this.actionStore(assertCurrent);
      const input = parseVisitorInput(revokeSchema, raw);
      if (
        (input.profileId || input.grantId) &&
        Object.values(input).filter((value) => value !== undefined).length !== 1
      ) {
        throw new VisitorAccessError(
          "Choose profileId, grantId, or email/GitHub; do not combine selectors.",
        );
      }
      if (!input.email && !input.github && !input.profileId && !input.grantId) {
        throw new VisitorAccessError("Provide a profileId, grantId, email, or GitHub login.");
      }
      const entries = await store.entries();
      const directTarget =
        input.email ?? (input.github ? (await this.resolveTarget(input)).target : undefined);
      const recordedAccountIds = entries.flatMap(({ value }) =>
        "githubAccountId" in value ? [value.githubAccountId] : [],
      );
      const selection = input.profileId
        ? await this.readAccess(recordedAccountIds)
        : typeof directTarget === "number"
          ? await this.readAccess([directTarget])
          : undefined;
      const profileId =
        input.profileId ??
        (directTarget === undefined ? undefined : selection?.profileId(directTarget));
      const profile = profileId ? selection?.resolveProfile(profileId) : undefined;
      if (!input.email && input.github && typeof directTarget === "number") {
        selection?.assertGithubSelection(input.github, directTarget);
      }
      if (input.profileId && !profile) {
        throw new VisitorAccessError(
          "Profile not found. Use the current canonical profileId from visitor_list.",
        );
      }
      const access =
        profile && !input.profileId ? await this.readAccess(recordedAccountIds) : selection;
      assertCurrent();
      const selected = profile
        ? entries.filter(({ value }) => access?.profileId(visitorGrantTarget(value)) === profile.id)
        : input.grantId
          ? entries.filter(({ value }) => value.grantId === input.grantId)
          : entries.filter(
              ({ key }) => directTarget !== undefined && key === visitorTargetKey(directTarget),
            );
      if (input.grantId && selected.length > 1) {
        throw new VisitorAccessError(
          "Multiple invitations have that grantId. List visitors and cancel by an exact target.",
        );
      }
      const targets = new Map(selected.map(({ key, value }) => [key, visitorGrantTarget(value)]));
      if (directTarget !== undefined) {
        targets.set(visitorTargetKey(directTarget), directTarget);
      }
      const revokeSelected = async (
        assertProfileCurrent?: () => void,
      ): Promise<{ text: string; details: VisitorRevokeDetails }> => {
        const assertRevocationCurrent = () => {
          assertCurrent();
          assertProfileCurrent?.();
        };
        const currentStore = this.actionStore(assertRevocationCurrent);
        const now = Date.now();
        for (const { value } of selected) {
          if (value.expiresAt === null || value.expiresAt > now) {
            await this.registerGrant({ ...value, expiresAt: now }, currentStore);
          }
        }
        let removed = false;
        await this.policy.update((policyTargets) => {
          assertRevocationCurrent();
          removed =
            selected.length > 0 ||
            policyTargets.some((target) => targets.has(visitorTargetKey(target)));
          return policyTargets.filter((target) => !targets.has(visitorTargetKey(target)));
        }, assertRevocationCurrent);
        for (const key of targets.keys()) {
          await this.deleteGrant(key, currentStore);
        }
        const who = input.profileId
          ? `profile ${input.profileId}`
          : input.grantId
            ? `invitation ${input.grantId}`
            : !input.email && input.github
              ? `@${input.github} (GitHub account ${directTarget})`
              : [...targets.keys()].join(", ");
        const githubAccountIds = [...targets.values()]
          .filter((target) => typeof target === "number")
          .toSorted((left, right) => left - right);
        return {
          text: removed
            ? `Revoked visitor access for ${who}.`
            : `No visitor grant found for ${who}; nothing to revoke.`,
          details: {
            outcome: removed ? "revoked" : "not_found",
            emails: [...targets.values()].filter((target) => typeof target === "string").toSorted(),
            ...(githubAccountIds.length ? { githubAccountIds } : {}),
            ...(!input.email && input.github ? { githubLogin: input.github } : {}),
          },
        };
      };
      const withRecordedTargets = (assertSelectionCurrent?: () => void) =>
        profile && access
          ? access.withProfile(
              profile.id,
              selected.map(({ value }) => visitorGrantTarget(value)),
              (assertTargetsCurrent) =>
                revokeSelected(() => {
                  assertSelectionCurrent?.();
                  assertTargetsCurrent();
                }),
            )
          : revokeSelected(assertSelectionCurrent);
      return profile && selection && typeof directTarget === "number"
        ? await selection.withProfile(profile.id, [directTarget], withRecordedTargets)
        : await withRecordedTargets();
    }, assertCurrent);
  }

  list(assertCurrent: () => void): Promise<{ text: string; details: VisitorListDetails }> {
    return this.serialize(async () => {
      const policy = await this.policy.read(assertCurrent);
      const policyTargets = policy?.targets ?? [];
      const targetKeys = new Set(policyTargets.map(visitorTargetKey));
      const entries = await this.store.entries();
      assertCurrent();
      const managed = new Set(entries.map((entry) => entry.key));
      const unmanaged = policyTargets
        .filter((target) => !managed.has(visitorTargetKey(target)))
        .toSorted((left, right) => visitorTargetKey(left).localeCompare(visitorTargetKey(right)));
      const displayedTargets = [
        ...entries
          .toSorted((left, right) => left.key.localeCompare(right.key))
          .map(({ value }) => visitorGrantTarget(value)),
        ...unmanaged,
      ].slice(0, this.config.maxVisitors);
      const access = await this.readAccess([
        ...new Set(displayedTargets.filter((target) => typeof target === "number")),
      ]);
      assertCurrent();
      const missing = entries.filter((entry) => !targetKeys.has(entry.key)).length;
      const summary = `Visitors: ${entries.length} recorded; ${targetKeys.size} in policy. Drift: ${unmanaged.length} unmanaged, ${missing} missing from policy.`;
      const lines = [summary];
      const details: VisitorListDetails = {
        counts: {
          recorded: entries.length,
          inPolicy: targetKeys.size,
          unmanaged: unmanaged.length,
          missingFromPolicy: missing,
        },
        grants: [],
        unmanaged: [],
        omitted: 0,
      };
      const rows: Array<
        | { line: string; grant: VisitorListDetails["grants"][number] }
        | { line: string; unmanaged: VisitorListDetails["unmanaged"][number] }
      > = entries
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .map(({ value: grant }) => {
          const target = visitorGrantTarget(grant);
          const profileId = access.profileId(target);
          const missingFromPolicy = !targetKeys.has(visitorTargetKey(target));
          const expired = grant.expiresAt !== null && grant.expiresAt <= Date.now();
          const state = missingFromPolicy
            ? "MISSING FROM POLICY"
            : expired
              ? "EXPIRED; provider cleanup pending"
              : "managed";
          const gatewayAccess = access.describe(target);
          const githubLogin = access.githubLogin(target);
          const github = `Verified GitHub: ${githubLogin ? `@${githubLogin}` : "unavailable"}`;
          return {
            line: `${visitorTargetKey(target)} | ${github}${profileId ? ` | profileId ${profileId}` : ""}${grant.grantId ? ` | grantId ${grant.grantId}` : ""} | invited ${new Date(grant.createdAt).toISOString()} | grant expires ${expiryText(grant.expiresAt)} | ${state} | ${gatewayAccess}`,
            grant: {
              ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
              ...(grant.grantId ? { grantId: grant.grantId } : {}),
              ...(profileId ? { profileId } : {}),
              ...(githubLogin ? { githubLogin } : {}),
              invitedAt: new Date(grant.createdAt).toISOString(),
              expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
              state: missingFromPolicy ? "missing_from_policy" : expired ? "expired" : "managed",
              gatewayAccess,
            },
          };
        });
      rows.push(
        ...unmanaged.map((target) => {
          const gatewayAccess = access.describe(target);
          return {
            line: `${visitorTargetKey(target)} | UNMANAGED: no grant record; retained until explicit revoke. | ${gatewayAccess}`,
            unmanaged: {
              ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
              gatewayAccess,
            },
          };
        }),
      );
      let length = summary.length;
      let shown = 0;
      for (const row of rows.slice(0, this.config.maxVisitors)) {
        if (length + row.line.length + 1 > LIST_MAX_CHARS - 120) {
          break;
        }
        lines.push(row.line);
        if ("grant" in row) {
          details.grants.push(row.grant);
        } else {
          details.unmanaged.push(row.unmanaged);
        }
        length += row.line.length + 1;
        shown++;
      }
      if (shown < rows.length) {
        details.omitted = rows.length - shown;
        lines.push(
          `${rows.length - shown} entries omitted by output limits. Inspect the policy; revoke by profileId, grantId, email, or GitHub login.`,
        );
      }
      return { text: lines.join("\n"), details };
    }, assertCurrent);
  }

  sweep(): Promise<void> {
    return this.serialize(async () => {
      const store = this.actionStore();
      const entries = await store.entries();
      const expired = new Set(
        entries
          .filter(({ value }) => value.expiresAt !== null && value.expiresAt <= Date.now())
          .map((entry) => entry.key),
      );
      for (const { key, value } of entries) {
        if (expired.has(key)) {
          this.publishGrant(value);
        }
      }
      this.scheduleExpiry();
      const managed = new Set(entries.map((entry) => entry.key));
      await this.policy.update(async (targets) => {
        const keys = new Set(targets.map(visitorTargetKey));
        for (const target of targets) {
          const key = visitorTargetKey(target);
          if (!managed.has(key)) {
            this.logger.warn(
              `visitor-access: unmanaged policy ${typeof target === "string" ? "email" : "GitHub account"} ${target}; retained.`,
            );
          }
        }
        for (const { key, value } of entries) {
          if (value.grantId === undefined && !expired.has(key) && keys.has(key)) {
            // The existing provider read confirms this legacy grant before its identity is minted.
            await this.registerGrant({ ...value, grantId: randomUUID() }, store);
          }
          if (!keys.has(key) && !expired.has(key)) {
            this.logger.warn(
              `visitor-access: ${key} is recorded but missing from policy; invite again to restore access or revoke to remove the record.`,
            );
          }
        }
        return targets.filter((target) => !expired.has(visitorTargetKey(target)));
      });
      for (const email of expired) {
        await this.deleteGrant(email, store);
        this.logger.info(`visitor-access: expired grant removed for ${email}.`);
      }
    });
  }
}
