import { z } from "zod";
import type { PluginLogger, PluginStateKeyedStore } from "../api.js";
import type { ReadVisitorGatewayAccess } from "./access.js";
import type { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";

export type VisitorGrant = {
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
const revokeSchema = z.strictObject(identityFields);
const inviteSchema = z.strictObject({
  ...identityFields,
  days: z.number().int().min(1).max(3650).optional(),
  forever: z.boolean().optional(),
});
const githubSchema = z.object({ email: z.string().nullable() });
const DAY_MS = 86_400_000;
const LIST_MAX_CHARS = 12_000;

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

  constructor(
    private readonly config: VisitorAccessConfig,
    private readonly store: PluginStateKeyedStore<VisitorGrant>,
    private readonly policy: VisitorPolicyClient,
    private readonly logger: PluginLogger,
    private readonly readAccess: ReadVisitorGatewayAccess,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
  ) {}

  // One queue owns the policy read/modify/write and its corresponding durable record.
  // Cloudflare has no cross-store transaction; keep records until revocation succeeds.
  private serialize<T>(operation: () => Promise<T>, assertCurrent?: () => void): Promise<T> {
    const result = this.pending.then(() => {
      this.signal?.throwIfAborted();
      assertCurrent?.();
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }

  async waitForIdle(): Promise<void> {
    await this.pending;
  }

  private actionStore(assertCurrent: () => void): PluginStateKeyedStore<VisitorGrant, 2> {
    if (!this.store.withCurrent) {
      throw new VisitorAccessError(
        "This Gateway cannot authorize visitor grant writes. Update OpenClaw before managing visitors.",
      );
    }
    return this.store.withCurrent({ assertCurrent });
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
  ): Promise<string> {
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
      const now = Date.now();
      const previous = await store.lookup(email);
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
        // Persist first: even a lost API response must leave an expiry cleanup record.
        assertCurrent();
        await store.register(email, grant);
        return [...new Set([...emails, email])];
      }, assertCurrent);
      const who = grant.githubLogin ? `@${grant.githubLogin} (${email})` : email;
      return `${previous ? "Renewed" : "Invited"} ${who}. Visitor grant expires: ${expiryText(grant.expiresAt)}. ${gatewayAccess}. Sign in at https://team.openclaw.ai using Team's existing login with this email. The link itself does not grant access.`;
    }, assertCurrent);
  }

  revoke(raw: unknown, assertCurrent: () => void): Promise<string> {
    return this.serialize(async () => {
      const store = this.actionStore(assertCurrent);
      const input = parseVisitorInput(revokeSchema, raw);
      if (!input.email && !input.github) {
        throw new VisitorAccessError("Provide an email or GitHub login.");
      }
      const entries = await store.entries();
      const matching = input.email
        ? [input.email]
        : entries
            .filter((entry) => entry.value.githubLogin === input.github)
            .map((entry) => entry.key);
      const targets = new Set(matching.length ? matching : [await this.resolveEmail(input)]);
      const now = Date.now();
      for (const { key, value } of entries) {
        if (targets.has(key) && (value.expiresAt === null || value.expiresAt > now)) {
          // An explicit end must survive a failed or ambiguous provider response.
          await store.register(key, { ...value, expiresAt: now });
        }
      }
      let removed = false;
      await this.policy.update((emails) => {
        removed =
          emails.some((email) => targets.has(email)) ||
          entries.some((entry) => targets.has(entry.key));
        return emails.filter((email) => !targets.has(email));
      }, assertCurrent);
      for (const email of targets) {
        assertCurrent();
        await store.delete(email);
      }
      const who =
        targets.size > 1
          ? `@${input.github} (${targets.size} recorded emails)`
          : [...targets].join(", ");
      return removed
        ? `Revoked visitor access for ${who}.`
        : `No visitor grant found for ${who}; nothing to revoke.`;
    }, assertCurrent);
  }

  list(assertCurrent: () => void): Promise<string> {
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
      const rows = entries
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .map(({ value: grant }) => {
          const state = !emails.has(grant.email)
            ? "MISSING FROM POLICY"
            : grant.expiresAt !== null && grant.expiresAt <= Date.now()
              ? "EXPIRED; provider cleanup pending"
              : "managed";
          return `${grant.email} | ${grant.githubLogin ? `@${grant.githubLogin}` : "GitHub unknown"} | invited ${new Date(grant.createdAt).toISOString()} | grant expires ${expiryText(grant.expiresAt)} | ${state} | ${access.describe(grant.email)}`;
        });
      rows.push(
        ...unmanaged.map(
          (email) =>
            `${email} | UNMANAGED: no grant record; retained until explicit revoke. | ${access.describe(email)}`,
        ),
      );
      let length = summary.length;
      let shown = 0;
      for (const row of rows.slice(0, this.config.maxVisitors)) {
        if (length + row.length + 1 > LIST_MAX_CHARS - 120) {
          break;
        }
        lines.push(row);
        length += row.length + 1;
        shown++;
      }
      if (shown < rows.length) {
        lines.push(
          `${rows.length - shown} entries omitted by output limits. Inspect the Access policy and revoke by explicit email.`,
        );
      }
      return lines.join("\n");
    }, assertCurrent);
  }

  sweep(): Promise<void> {
    return this.serialize(async () => {
      const entries = await this.store.entries();
      const expired = new Set(
        entries
          .filter(({ value }) => value.expiresAt !== null && value.expiresAt <= Date.now())
          .map((entry) => entry.key),
      );
      const managed = new Set(entries.map((entry) => entry.key));
      await this.policy.update((emails) => {
        for (const email of emails) {
          if (!managed.has(email)) {
            this.logger.warn(`visitor-access: unmanaged policy email ${email}; retained.`);
          }
        }
        for (const { key } of entries) {
          if (!emails.includes(key) && !expired.has(key)) {
            this.logger.warn(
              `visitor-access: ${key} is recorded but missing from policy; invite again to restore access or revoke to remove the record.`,
            );
          }
        }
        return emails.filter((email) => !expired.has(email));
      });
      for (const email of expired) {
        await this.store.delete(email);
        this.logger.info(`visitor-access: expired grant removed for ${email}.`);
      }
    });
  }
}
