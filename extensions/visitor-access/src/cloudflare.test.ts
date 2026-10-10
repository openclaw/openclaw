import { describe, expect, it, vi } from "vitest";
import { VisitorPolicyClient } from "./cloudflare.js";
import type { VisitorAccessConfig } from "./config.js";
import { VisitorAccessError } from "./errors.js";

const config: VisitorAccessConfig = {
  accountId: "account-id",
  appId: "app-id",
  apiToken: "test-token-never-echo",
  policyName: "Visitors (openclaw-managed)",
  defaultTtlDays: 14,
  maxVisitors: 50,
};
const collectionUrl =
  "https://api.cloudflare.com/client/v4/accounts/account-id/access/apps/app-id/policies";
const githubProvider = {
  issuer: "https://example.cloudflareaccess.com",
  providerId: "github-provider",
  githubAccountIdClaim: "github_account_id",
};
const githubRule = {
  oidc: {
    identity_provider_id: githubProvider.providerId,
    claim_name: githubProvider.githubAccountIdClaim,
    claim_value: "42",
  },
};

function namedPolicy(targets: (string | number)[] = ["first@example.com"]) {
  return {
    id: "visitor-policy",
    name: config.policyName,
    decision: "allow",
    include: targets.map((target) =>
      typeof target === "string"
        ? { email: { email: target } }
        : { oidc: { ...githubRule.oidc, claim_value: String(target) } },
    ),
  };
}

function cloudflareResponse(result: unknown, resultInfo?: unknown) {
  return Response.json({ success: true, result, result_info: resultInfo });
}

function fetchSequence(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockResolvedValueOnce(response);
  }
  return fetcher;
}

function requestBody(fetcher: ReturnType<typeof fetchSequence>, index: number) {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as unknown;
}

describe("VisitorPolicyClient", () => {
  it.each([
    { field: "githubAccountIdClaim", afterResponse: false },
    { field: "issuer", afterResponse: false },
    { field: "issuer", afterResponse: true },
  ] as const)(
    "pins the current $field mapping through renewal (after response: $afterResponse)",
    async ({ field, afterResponse }) => {
      let provider: typeof githubProvider | undefined;
      const policy = namedPolicy([42]);
      const fetcher = fetchSequence(
        cloudflareResponse([]),
        cloudflareResponse(policy),
        cloudflareResponse([policy]),
        cloudflareResponse(policy),
      );
      const client = new VisitorPolicyClient(config, fetcher, undefined, () => provider);
      const changeMapping = () => {
        provider = {
          ...githubProvider,
          [field]: field === "issuer" ? "https://changed.cloudflareaccess.com" : "changed_claim",
        };
      };
      fetcher.mockImplementationOnce(async () => {
        changeMapping();
        return cloudflareResponse(namedPolicy([42, 43]));
      });
      provider = { ...githubProvider };
      await expect(client.update(() => [42])).resolves.toEqual([42]);
      expect(requestBody(fetcher, 1)).toMatchObject({ include: [githubRule] });
      await expect(
        client.update(() => {
          if (!afterResponse) {
            changeMapping();
          }
          return afterResponse ? [42, 43] : [42];
        }),
      ).rejects.toThrow("mapping changed");
      expect(fetcher.mock.calls.map(([, request]) => request?.method)).toEqual([
        "GET",
        "POST",
        "GET",
        "GET",
        ...(afterResponse ? ["PUT"] : []),
      ]);
    },
  );

  it("creates only the named app policy when absent, leaving other policies untouched", async () => {
    const maintainers = { id: "maintainers", name: "GitHub organization", decision: "allow" };
    const fetcher = fetchSequence(
      cloudflareResponse([maintainers]),
      cloudflareResponse(namedPolicy()),
    );
    const client = new VisitorPolicyClient(config, fetcher);

    await expect(client.update(() => ["first@example.com"])).resolves.toEqual([
      "first@example.com",
    ]);

    expect(fetcher.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
      [`${collectionUrl}?page=1&per_page=100`, "GET"],
      [collectionUrl, "POST"],
    ]);
    expect(requestBody(fetcher, 1)).toEqual({
      name: config.policyName,
      decision: "allow",
      include: [{ email: { email: "first@example.com" } }],
    });
  });

  it("rereads the named policy and preserves mixed dashboard targets and restrictions on update", async () => {
    const original = namedPolicy(["FIRST@example.com", 42]);
    const updated = {
      ...namedPolicy(["first@example.com", "manual@example.com", 42]),
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ["approver@example.com"] }],
      mfa_config: { mfa_disabled: false },
      created_at: "2026-08-28T00:00:00Z",
    };
    const fetcher = fetchSequence(
      cloudflareResponse([original]),
      cloudflareResponse(original),
      cloudflareResponse([updated]),
      cloudflareResponse(updated),
      cloudflareResponse(updated),
    );
    const client = new VisitorPolicyClient(config, fetcher, undefined, () => githubProvider);
    await expect(client.read()).resolves.toEqual({
      id: original.id,
      targets: ["first@example.com", 42],
    });

    await expect(client.update((targets) => [...targets, "next@example.com", 84])).resolves.toEqual(
      ["first@example.com", "manual@example.com", 42, "next@example.com", 84],
    );

    expect(requestBody(fetcher, 4)).toEqual({
      name: config.policyName,
      decision: "allow",
      include: [
        { email: { email: "first@example.com" } },
        { email: { email: "manual@example.com" } },
        githubRule,
        { email: { email: "next@example.com" } },
        {
          oidc: {
            identity_provider_id: "github-provider",
            claim_name: "github_account_id",
            claim_value: "84",
          },
        },
      ],
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: updated.approval_groups,
      mfa_config: updated.mfa_config,
    });
    expect(fetcher.mock.calls[4]?.[0]).toBe(`${collectionUrl}/${original.id}`);
    expect(fetcher.mock.calls[4]?.[1]?.method).toBe("PUT");
  });

  it.each<
    [name: string, override: Record<string, unknown>, provider?: typeof githubProvider | null]
  >([
    ["deny decision", { decision: "deny" }],
    ["unsupported includes", { include: [{ everyone: {} }] }],
    ["mixed email rules", { include: [{ email: { email: "first@example.com" }, everyone: {} }] }],
    ["unconfigured GitHub mapping", { include: [githubRule] }, null],
    [
      "another OIDC provider",
      {
        include: [{ oidc: { ...githubRule.oidc, identity_provider_id: "other-provider" } }],
      },
    ],
    ["another OIDC claim", { include: [{ oidc: { ...githubRule.oidc, claim_name: "login" } }] }],
    ["mixed OIDC rules", { include: [{ ...githubRule, everyone: {} }] }],
    ["extra OIDC fields", { include: [{ oidc: { ...githubRule.oidc, login: "visitor" } }] }],
    ...["0", "-1", "042", "42.0", "4.2e1", " 42", "42 ", "9007199254740992", 42].map(
      (claimValue): [string, Record<string, unknown>] => [
        `noncanonical account ID ${JSON.stringify(claimValue)}`,
        { include: [{ oidc: { ...githubRule.oidc, claim_value: claimValue } }] },
      ],
    ),
    ["required restrictions", { require: [{ email_domain: { domain: "example.com" } }] }],
    ["excluded identities", { exclude: [{ email: { email: "excluded@example.com" } }] }],
    ["renamed policy", { name: "GitHub organization" }],
    ["replaced policy", { id: "other-policy" }],
  ])(
    "refuses %s before running a change or writing Cloudflare",
    async (_name, override, provider = githubProvider) => {
      const policy = namedPolicy();
      const fetcher = fetchSequence(
        cloudflareResponse([policy]),
        cloudflareResponse({ ...policy, ...override }),
      );
      const change = vi.fn(() => ["next@example.com"]);
      await expect(
        new VisitorPolicyClient(config, fetcher, undefined, () => provider ?? undefined).update(
          change,
        ),
      ).rejects.toBeInstanceOf(VisitorAccessError);
      expect(change).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    },
  );

  it("finds a policy on later pages and refuses duplicate configured names across pages", async () => {
    const other = { id: "other", name: "Maintainers" };
    const policy = namedPolicy();
    const fetcher = fetchSequence(
      cloudflareResponse([other], { total_pages: 2 }),
      cloudflareResponse([policy], { total_pages: 2 }),
      cloudflareResponse(policy),
    );
    await expect(new VisitorPolicyClient(config, fetcher).read()).resolves.toEqual({
      id: policy.id,
      targets: ["first@example.com"],
    });
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${collectionUrl}?page=2&per_page=100`);

    const duplicates = fetchSequence(
      cloudflareResponse([policy], { total_pages: 2 }),
      cloudflareResponse([{ ...policy, id: "duplicate" }], { total_pages: 2 }),
    );
    await expect(
      new VisitorPolicyClient(config, duplicates).update(() => []),
    ).rejects.toBeInstanceOf(VisitorAccessError);
    expect(duplicates.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it.each(["network", "http", "api", "json"])(
    "never exposes token-bearing %s failures",
    async (mode) => {
      const fetcher = vi.fn<typeof fetch>();
      if (mode === "network") {
        fetcher.mockRejectedValueOnce(new Error(config.apiToken));
      } else if (mode === "http") {
        fetcher.mockResolvedValueOnce(new Response(config.apiToken, { status: 403 }));
      } else if (mode === "api") {
        fetcher.mockResolvedValueOnce(
          Response.json({ success: false, errors: [{ message: config.apiToken }] }),
        );
      } else {
        fetcher.mockResolvedValueOnce(new Response(config.apiToken));
      }
      const error = await new VisitorPolicyClient(config, fetcher)
        .read()
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(VisitorAccessError);
      expect(String(error)).not.toContain(config.apiToken);
      const options = fetcher.mock.calls[0]?.[1];
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it("fences an obsolete service before the durable callback runs", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
      abort.abort();
      return cloudflareResponse([]);
    });
    const change = vi.fn(() => ["next@example.com"]);
    await expect(
      new VisitorPolicyClient(config, fetcher, abort.signal).update(change),
    ).rejects.toBeInstanceOf(VisitorAccessError);
    expect(change).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
