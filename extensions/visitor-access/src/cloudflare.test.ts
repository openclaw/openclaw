import { describe, expect, it, vi } from "vitest";
import { VisitorPolicyClient } from "./cloudflare.js";
import { VisitorAccessError } from "./errors.js";
import {
  visitorConfig as config,
  githubProvider,
  githubRule,
  namedPolicy,
} from "./visitors.test-support.js";

const collectionUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";
const oidc = (overrides: Record<string, unknown> = {}) => ({
  oidc: { ...githubRule.oidc, ...overrides },
});

function cloudflareResponse(result: unknown, resultInfo?: unknown) {
  return Response.json({ success: true, result, result_info: resultInfo });
}
const policyPage = (policies: unknown[]) => cloudflareResponse(policies, { total_pages: 2 });

function fetchSequence(...responses: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockResolvedValueOnce(
      response instanceof Response ? response : cloudflareResponse(response),
    );
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
    ["githubAccountIdClaim", false],
    ["issuer", true],
  ] as const)("pins %s through renewal (after response: %s)", async (field, afterResponse) => {
    let provider: typeof githubProvider | undefined;
    const policy = namedPolicy([42]);
    const fetcher = fetchSequence([], policy, [policy], policy);
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
  });

  it("rereads the named policy and preserves mixed dashboard targets and restrictions on update", async () => {
    const original = namedPolicy(["FIRST@example.com", 42]);
    const restrictions = {
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ["approver@example.com"] }],
      mfa_config: { mfa_disabled: false },
    };
    const updated = {
      ...namedPolicy(["first@example.com", "manual@example.com", 42]),
      ...restrictions,
      created_at: "2026-08-28T00:00:00Z",
    };
    const fetcher = fetchSequence([original], original, [updated], updated, updated);
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
        oidc({ claim_value: "84" }),
      ],
      ...restrictions,
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
    ["another OIDC provider", { include: [oidc({ identity_provider_id: "other-provider" })] }],
    ["another OIDC claim", { include: [oidc({ claim_name: "login" })] }],
    ["mixed OIDC rules", { include: [{ ...githubRule, everyone: {} }] }],
    ["extra OIDC fields", { include: [oidc({ login: "visitor" })] }],
    ...["042", "9007199254740992", 42].map((claimValue): [string, Record<string, unknown>] => [
      `noncanonical account ID ${JSON.stringify(claimValue)}`,
      { include: [oidc({ claim_value: claimValue })] },
    ]),
    ["required restrictions", { require: [{ email_domain: { domain: "example.com" } }] }],
    ["excluded identities", { exclude: [{ email: { email: "excluded@example.com" } }] }],
    ["renamed policy", { name: "GitHub organization" }],
    ["replaced policy", { id: "other-policy" }],
  ])(
    "refuses %s before running a change or writing Cloudflare",
    async (_name, override, provider = githubProvider) => {
      const policy = namedPolicy();
      const fetcher = fetchSequence([policy], { ...policy, ...override });
      const change = vi.fn(() => ["next@example.com"]);
      const readProvider = () => provider ?? undefined;
      const client = new VisitorPolicyClient(config, fetcher, undefined, readProvider);
      await expect(client.update(change)).rejects.toBeInstanceOf(VisitorAccessError);
      expect(change).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    },
  );

  it.each([false, true])("discovers policies; rejects duplicates: %s", async (duplicate) => {
    const policy = namedPolicy();
    const fetcher = fetchSequence(
      policyPage([duplicate ? policy : { id: "other", name: "Maintainers" }]),
      policyPage([{ ...policy, id: duplicate ? "duplicate" : policy.id }]),
      ...(duplicate ? [] : [policy]),
    );
    const client = new VisitorPolicyClient(config, fetcher);
    if (duplicate) {
      await expect(client.update(() => [])).rejects.toBeInstanceOf(VisitorAccessError);
    } else {
      await expect(client.read()).resolves.toEqual({
        id: policy.id,
        targets: ["first@example.com"],
      });
    }
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${collectionUrl}?page=2&per_page=100`);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
  });

  it.each([
    ["network", () => Promise.reject(new Error(config.apiToken))],
    ["http", async () => new Response(config.apiToken, { status: 403 })],
    ["api", async () => Response.json({ success: false, errors: [{ message: config.apiToken }] })],
    ["json", async () => new Response(config.apiToken)],
  ] as const)("never exposes token-bearing %s failures", async (_mode, response) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(response);
    const error = await new VisitorPolicyClient(config, fetcher)
      .read()
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VisitorAccessError);
    expect(String(error)).not.toContain(config.apiToken);
    const options = fetcher.mock.calls[0]?.[1];
    expect(options).toMatchObject({ redirect: "error", signal: expect.any(AbortSignal) });
  });

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
