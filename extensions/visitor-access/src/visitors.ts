import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginGatewayAccessAuthority, PluginLogger, PluginStateKeyedStore } from "../api.js";
import type { ReadVisitorGatewayAccess } from "./access.js";
import type { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";
import type {
  VisitorInviteDetails,
  VisitorListDetails,
  VisitorRevokeDetails,
} from "./tool-results.js";

export type VisitorGrant = {
  grantId?: string;
  email: string;
  githubLogin?: string;
  invitedVia?: string;
  createdAt: number;
  expiresAt: number | null;
};

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
    .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/)
    .transform((login) => login.toLowerCase())
    .optional(),
  email: emailSchema.optional(),
};
const revokeSchema = z.strictObject({
  ...identityFields,
  profileId: z.string().trim().min(1).max(128).optional(),
  grantId: z.uuid().optional(),
});
const inviteSchema = z.strictObject({
  ...identityFields,
  days: z.number().int().min(1).max(3650).optional(),
  forever: z.boolean().optional(),
});
const githubSchema = z.object({ email: z.string().nullable() });
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
      "Invalid visitor input. Use a valid email or GitHub login, a profileId or UUID grantId for revocation, days from 1 to 3650, or forever: true.",
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
    private readonly fetcher: typeof fetch = fetch,
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

  /** The canonical profile's email aliases select an active grant, never a GitHub display login. */
  authorize(emails: readonly string[]): PluginGatewayAccessAuthority {
    const authority = this.readAuthority(emails);
    if (!authority) {
      throw new VisitorAccessError(
        "An active visitor invitation is required. Ask a maintainer to invite or renew access.",
      );
    }
    return authority;
  }

  /** Unlike admission, an unavailable grant map must leave durable requests pending. */
  resume(emails: readonly string[], grantId: string): PluginGatewayAccessAuthority | undefined {
    return this.readAuthority(emails, grantId);
  }

  private readAuthority(
    emails: readonly string[],
    grantId?: string,
  ): PluginGatewayAccessAuthority | undefined {
    this.assertOpen();
    if (!this.ready) {
      throw new VisitorAccessError("Visitor access is starting; retry shortly.");
    }
    const now = Date.now();
    const state = emails
      .map((email) => this.grants.get(email.trim().toLowerCase()))
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
      if (this.grants.get(state.grant.email) !== state || state.controller.signal.aborted) {
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
    const previous = this.grants.get(grant.email);
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
    this.grants.set(grant.email, state);
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
    await store.register(grant.email, grant);
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

  private async resolveEmail(input: { email?: string; github?: string }): Promise<string> {
    if (input.email) {
      return input.email;
    }
    if (!input.github) {
      throw new VisitorAccessError("Provide an email or GitHub login.");
    }
    let response: Response;
    let body: unknown;
    try {
      response = await this.fetcher(
        `https://api.github.com/users/${encodeURIComponent(input.github)}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "OpenClaw-visitor-access",
          },
          redirect: "error",
          signal: this.signal
            ? AbortSignal.any([this.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        throw new Error("GitHub lookup failed");
      }
      body = await response.json();
    } catch {
      throw new VisitorAccessError(
        "GitHub email lookup failed. Check the login and retry, or pass email explicitly.",
      );
    }
    const result = githubSchema.safeParse(body);
    if (!result.success || result.data.email === null) {
      throw new VisitorAccessError(
        "No public GitHub email is available. Ask the visitor for their Team sign-in email and pass email explicitly.",
      );
    }
    return parseVisitorInput(emailSchema, result.data.email);
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
      const email = await this.resolveEmail(input);
      const previous = await store.lookup(email);
      const now = Date.now();
      const githubLogin = input.github ?? previous?.githubLogin;
      const provenance = invitedVia?.slice(0, 256) ?? previous?.invitedVia;
      const grant: VisitorGrant = {
        email,
        ...(githubLogin ? { githubLogin } : {}),
        ...(provenance ? { invitedVia: provenance } : {}),
        createdAt: previous?.createdAt ?? now,
        expiresAt,
      };
      let gatewayAccess = "";
      await this.policy.update(async (emails) => {
        const entries = await store.entries();
        const known = new Set([...emails, ...entries.map((entry) => entry.key)]);
        if (!known.has(email) && known.size >= this.config.maxVisitors) {
          throw new VisitorAccessError(
            `Visitor limit (${this.config.maxVisitors}) reached. Revoke an existing visitor before inviting another.`,
          );
        }
        const access = await this.readAccess();
        access.assertInvitable(email);
        gatewayAccess = access.describe(email);
        // A lost provider response still needs cleanup, without granting access.
        // Existing grants keep their deadline until the provider confirms renewal.
        if (!previous) {
          await this.registerGrant({ ...grant, expiresAt: now }, store);
        }
        return [...new Set([...emails, email])];
      }, assertCurrent);
      const continuous =
        previous &&
        grantIdSchema.safeParse(previous.grantId).success &&
        (previous.expiresAt === null || previous.expiresAt > Date.now());
      const grantId = continuous && previous.grantId ? previous.grantId : randomUUID();
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
      const who = grant.githubLogin ? `@${grant.githubLogin} (${email})` : email;
      return {
        text: `${previous ? "Renewed" : "Invited"} ${who}. Invitation ID: ${grant.grantId}. Visitor grant expires: ${expiryText(grant.expiresAt)}. ${gatewayAccess}. Sign in at ${SIGN_IN_URL} using Team's existing login with this email. The link itself does not grant access.`,
        details: {
          outcome: previous ? "renewed" : "invited",
          email,
          grantId,
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
      const access = input.profileId ? await this.readAccess() : undefined;
      const profile = input.profileId ? access?.resolveProfile(input.profileId) : undefined;
      if (input.profileId && !profile) {
        throw new VisitorAccessError(
          "Profile not found. Use the current canonical profileId from visitor_list.",
        );
      }
      const matching = profile
        ? entries.filter(({ key }) => profile.emails.includes(key)).map(({ key }) => key)
        : input.grantId
          ? entries.filter(({ value }) => value.grantId === input.grantId).map(({ key }) => key)
          : input.email
            ? [input.email]
            : entries
                .filter((entry) => entry.value.githubLogin === input.github)
                .map((entry) => entry.key);
      const targets = new Set(
        matching.length || input.profileId || input.grantId
          ? matching
          : [await this.resolveEmail(input)],
      );
      if (input.grantId && targets.size > 1) {
        throw new VisitorAccessError(
          "Multiple invitations have that grantId. List visitors and cancel by exact email.",
        );
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
        for (const { key, value } of entries) {
          if (targets.has(key) && (value.expiresAt === null || value.expiresAt > now)) {
            await this.registerGrant({ ...value, expiresAt: now }, currentStore);
          }
        }
        let removed = false;
        await this.policy.update((emails) => {
          assertRevocationCurrent();
          removed =
            emails.some((email) => targets.has(email)) ||
            entries.some((entry) => targets.has(entry.key));
          return emails.filter((email) => !targets.has(email));
        }, assertRevocationCurrent);
        for (const email of targets) {
          await this.deleteGrant(email, currentStore);
        }
        const who = input.profileId
          ? `profile ${input.profileId} (${targets.size} recorded emails)`
          : input.grantId
            ? `invitation ${input.grantId}`
            : targets.size > 1
              ? `@${input.github} (${targets.size} recorded emails)`
              : [...targets].join(", ");
        return {
          text: removed
            ? `Revoked visitor access for ${who}.`
            : `No visitor grant found for ${who}; nothing to revoke.`,
          details: {
            outcome: removed ? "revoked" : "not_found",
            emails: [...targets].toSorted(),
            ...(!input.email && input.github ? { githubLogin: input.github } : {}),
          },
        };
      };
      return profile && access
        ? await access.withProfile(profile.id, [...targets], revokeSelected)
        : await revokeSelected();
    }, assertCurrent);
  }

  list(assertCurrent: () => void): Promise<{ text: string; details: VisitorListDetails }> {
    return this.serialize(async () => {
      const policy = await this.policy.read(assertCurrent);
      const emails = new Set(policy?.emails ?? []);
      const entries = await this.store.entries();
      const access = await this.readAccess();
      assertCurrent();
      const managed = new Set(entries.map((entry) => entry.key));
      const unmanaged = [...emails].filter((email) => !managed.has(email)).toSorted();
      const missing = entries.filter((entry) => !emails.has(entry.key)).length;
      const summary = `Visitors: ${entries.length} recorded; ${emails.size} in policy. Drift: ${unmanaged.length} unmanaged, ${missing} missing from policy.`;
      const lines = [summary];
      const details: VisitorListDetails = {
        counts: {
          recorded: entries.length,
          inPolicy: emails.size,
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
          const profileId = access.profileId(grant.email);
          const missingFromPolicy = !emails.has(grant.email);
          const expired = grant.expiresAt !== null && grant.expiresAt <= Date.now();
          const state = missingFromPolicy
            ? "MISSING FROM POLICY"
            : expired
              ? "EXPIRED; provider cleanup pending"
              : "managed";
          const gatewayAccess = access.describe(grant.email);
          return {
            line: `${grant.email} | ${grant.githubLogin ? `@${grant.githubLogin}` : "GitHub unknown"}${profileId ? ` | profileId ${profileId}` : ""}${grant.grantId ? ` | grantId ${grant.grantId}` : ""} | invited ${new Date(grant.createdAt).toISOString()} | grant expires ${expiryText(grant.expiresAt)} | ${state} | ${gatewayAccess}`,
            grant: {
              email: grant.email,
              ...(grant.grantId ? { grantId: grant.grantId } : {}),
              ...(profileId ? { profileId } : {}),
              ...(grant.githubLogin ? { githubLogin: grant.githubLogin } : {}),
              invitedAt: new Date(grant.createdAt).toISOString(),
              expiresAt: grant.expiresAt === null ? null : new Date(grant.expiresAt).toISOString(),
              state: missingFromPolicy ? "missing_from_policy" : expired ? "expired" : "managed",
              gatewayAccess,
            },
          };
        });
      rows.push(
        ...unmanaged.map((email) => {
          const gatewayAccess = access.describe(email);
          return {
            line: `${email} | UNMANAGED: no grant record; retained until explicit revoke. | ${gatewayAccess}`,
            unmanaged: { email, gatewayAccess },
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
          `${rows.length - shown} entries omitted by output limits. Inspect the Access policy and revoke by explicit email.`,
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
      await this.policy.update(async (emails) => {
        for (const email of emails) {
          if (!managed.has(email)) {
            this.logger.warn(`visitor-access: unmanaged policy email ${email}; retained.`);
          }
        }
        for (const { key, value } of entries) {
          if (value.grantId === undefined && !expired.has(key) && emails.includes(key)) {
            // The existing provider read confirms this legacy grant before its identity is minted.
            await this.registerGrant({ ...value, grantId: randomUUID() }, store);
          }
          if (!emails.includes(key) && !expired.has(key)) {
            this.logger.warn(
              `visitor-access: ${key} is recorded but missing from policy; invite again to restore access or revoke to remove the record.`,
            );
          }
        }
        return emails.filter((email) => !expired.has(email));
      });
      for (const email of expired) {
        await this.deleteGrant(email, store);
        this.logger.info(`visitor-access: expired grant removed for ${email}.`);
      }
    });
  }
}
