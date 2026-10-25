import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { z } from "zod";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";

const policyReferenceSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(128)
    .refine((value) => value !== "." && value !== ".."),
  name: z.string(),
});
const emailRuleSchema = z.strictObject({
  email: z.strictObject({ email: z.email().max(254) }),
});
const githubRuleSchema = z.strictObject({
  oidc: z.strictObject({
    identity_provider_id: z.string().min(1),
    claim_name: z.string().min(1),
    claim_value: z
      .string()
      .regex(/^[1-9][0-9]*$/u)
      .refine((value) => Number.isSafeInteger(Number(value))),
  }),
});
const managedPolicySchema = policyReferenceSchema
  .extend({
    decision: z.literal("allow"),
    include: z.array(z.union([emailRuleSchema, githubRuleSchema])).max(10_000),
    exclude: z.array(z.unknown()).max(0).optional(),
    require: z.array(z.unknown()).max(0).optional(),
  })
  .passthrough();
const responseSchema = z.object({
  success: z.literal(true),
  result: z.unknown(),
  result_info: z
    .object({
      total_pages: z.number().int().nonnegative().optional(),
      per_page: z.number().int().positive().optional(),
    })
    .optional(),
});

type ManagedPolicy = z.infer<typeof managedPolicySchema>;
type GitHubProvider = { issuer: string; providerId: string; githubAccountIdClaim: string };

function requireGithubProvider(provider: GitHubProvider | undefined): GitHubProvider {
  if (!provider) {
    throw new VisitorAccessError(
      "GitHub account invitations require the existing trusted-proxy Cloudflare Access OIDC provider and GitHub account-ID claim mapping. Configure that sign-in mapping before inviting by GitHub account.",
    );
  }
  return provider;
}

export type VisitorTarget = string | number;

export function visitorTargetKey(target: VisitorTarget): string {
  return typeof target === "string" ? target : `github:${target}`;
}

export class VisitorPolicyClient {
  private readonly policiesUrl: string;

  constructor(
    private readonly config: VisitorAccessConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly signal?: AbortSignal,
    private readonly readGithubProvider?: () => GitHubProvider | undefined,
  ) {
    this.policiesUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/access/apps/${encodeURIComponent(config.appId)}/policies`;
  }

  async read(
    assertCurrent?: () => void,
  ): Promise<{ id: string; targets: VisitorTarget[] } | undefined> {
    const policy = await this.readPolicy(assertCurrent);
    return policy ? { id: policy.id, targets: this.policyTargets(policy) } : undefined;
  }

  async update(
    change: (targets: readonly VisitorTarget[]) => VisitorTarget[] | Promise<VisitorTarget[]>,
    assertCurrent?: () => void,
  ): Promise<VisitorTarget[]> {
    // Every mutation starts from Cloudflare, preserving dashboard edits made since
    // the previous tool call. The service serializes its own mutations separately.
    const policy = await this.readPolicy(assertCurrent);
    const configured = this.readGithubProvider?.();
    const githubProvider = configured && { ...configured };
    const current = policy ? this.policyTargets(policy, githubProvider) : [];
    if (this.signal?.aborted) {
      throw new VisitorAccessError("Visitor access is stopping; retry after the gateway starts.");
    }
    const targets = [...new Set(await change(current))];
    const usesGithub = [...current, ...targets].some((target) => typeof target === "number");
    const assertPolicyCurrent = () => {
      assertCurrent?.();
      if (usesGithub) {
        const currentProvider = this.readGithubProvider?.();
        if (
          currentProvider?.issuer !== githubProvider?.issuer ||
          currentProvider?.providerId !== githubProvider?.providerId ||
          currentProvider?.githubAccountIdClaim !== githubProvider?.githubAccountIdClaim
        ) {
          throw new VisitorAccessError(
            "The GitHub account-ID mapping changed; inspect the visitor policy before retrying.",
          );
        }
        requireGithubProvider(githubProvider);
      }
    };
    assertPolicyCurrent();
    if (targets.length === current.length && targets.every((target) => current.includes(target))) {
      return targets;
    }
    if (policy && targets.length === 0) {
      await this.request(
        `${this.policiesUrl}/${encodeURIComponent(policy.id)}`,
        "DELETE",
        undefined,
        assertPolicyCurrent,
      );
      assertPolicyCurrent();
      return targets;
    }

    const payload: Record<string, unknown> = { ...policy };
    // Retain the policy's restrictions and precedence; only these response-only
    // fields are omitted. Never reconstruct other app policies or their ordering.
    for (const key of ["id", "account_id", "created_at", "updated_at"]) {
      delete payload[key];
    }
    payload.name = this.config.policyName;
    payload.decision = "allow";
    payload.include = targets.map((target) => {
      if (typeof target === "string") {
        return { email: { email: target } };
      }
      const provider = requireGithubProvider(githubProvider);
      return {
        oidc: {
          identity_provider_id: provider.providerId,
          claim_name: provider.githubAccountIdClaim,
          claim_value: String(target),
        },
      };
    });
    const url = policy ? `${this.policiesUrl}/${encodeURIComponent(policy.id)}` : this.policiesUrl;
    await this.request(url, policy ? "PUT" : "POST", payload, assertPolicyCurrent);
    assertPolicyCurrent();
    return targets;
  }

  assertGithubConfigured() {
    return requireGithubProvider(this.readGithubProvider?.());
  }

  private policyTargets(
    policy: ManagedPolicy,
    githubProvider = this.readGithubProvider?.(),
  ): VisitorTarget[] {
    return [
      ...new Set(
        policy.include.map((rule) => {
          if ("email" in rule) {
            return rule.email.email.toLowerCase();
          }
          const provider = requireGithubProvider(githubProvider);
          if (
            rule.oidc.identity_provider_id !== provider.providerId ||
            rule.oidc.claim_name !== provider.githubAccountIdClaim
          ) {
            throw new VisitorAccessError(
              "The visitor policy has an OIDC rule outside the configured GitHub account-ID mapping; inspect the policy before retrying.",
            );
          }
          return Number(rule.oidc.claim_value);
        }),
      ),
    ];
  }

  private async readPolicy(assertCurrent?: () => void): Promise<ManagedPolicy | undefined> {
    let reference: z.infer<typeof policyReferenceSchema> | undefined;
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(
        `${this.policiesUrl}?page=${page}&per_page=100`,
        "GET",
        undefined,
        assertCurrent,
      );
      const policies = z.array(policyReferenceSchema).max(100).safeParse(response.result);
      if (!policies.success) {
        throw new VisitorAccessError(
          "Cloudflare returned an invalid policy list; inspect the Access application.",
        );
      }
      for (const policy of policies.data) {
        if (policy.name !== this.config.policyName) {
          continue;
        }
        if (reference) {
          throw new VisitorAccessError(
            "Multiple Access policies have the configured visitor policy name; make the name unique before retrying.",
          );
        }
        reference = policy;
      }
      const totalPages = response.result_info?.total_pages;
      const pageSize = response.result_info?.per_page ?? 100;
      const complete =
        totalPages === undefined ? policies.data.length < pageSize : page >= totalPages;
      if (complete) {
        if (!reference) {
          return undefined;
        }
        // Fetch the selected policy after discovery so its identity and include
        // rules are validated together immediately before the change callback.
        const detail = await this.request(
          `${this.policiesUrl}/${encodeURIComponent(reference.id)}`,
          "GET",
          undefined,
          assertCurrent,
        );
        const parsed = managedPolicySchema.safeParse(detail.result);
        if (
          !parsed.success ||
          parsed.data.id !== reference.id ||
          parsed.data.name !== this.config.policyName
        ) {
          throw new VisitorAccessError(
            "The visitor policy changed or is not a supported email/GitHub-account allow policy. Inspect its name, decision, include, require, and exclude rules before retrying.",
          );
        }
        return parsed.data;
      }
    }
    throw new VisitorAccessError(
      "The Access application has too many policies to inspect safely; reduce its policy count before retrying.",
    );
  }

  private async request(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown,
    assertCurrent?: () => void,
  ) {
    let response: Response;
    assertCurrent?.();
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new VisitorAccessError(
        "Cloudflare request failed; check connectivity and retry. Policy state may need reconciliation.",
      );
    }
    if (!response.ok) {
      throw new VisitorAccessError(
        `Cloudflare request failed (HTTP ${response.status}); check the token's Access policy permissions and retry.`,
      );
    }
    let data: unknown;
    try {
      data = await readProviderJsonResponse(response, "Cloudflare visitor access response", {
        requestHeaders: {
          Authorization: `Bearer ${this.config.apiToken}`,
        },
      });
    } catch {
      throw new VisitorAccessError(
        "Cloudflare returned an unreadable response; retry and inspect the visitor policy.",
      );
    }
    const parsed = responseSchema.safeParse(data);
    if (!parsed.success) {
      throw new VisitorAccessError(
        "Cloudflare did not confirm the request; inspect the visitor policy before retrying.",
      );
    }
    return parsed.data;
  }
}
