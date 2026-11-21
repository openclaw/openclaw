import { beforeEach, describe, expect, it, vi } from "vitest";
import { VisitorPolicyClient } from "./cloudflare.js";
import { VisitorAccessError } from "./errors.js";
import { visitorConfig, githubProvider, githubRule, namedPolicy } from "./visitors.test-support.js";

const config = visitorConfig;
const collectionUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";
const oidc = (overrides: Record<string, unknown>) => ({
  oidc: { ...githubRule.oidc, ...overrides },
});

const cloudflareResponse = (result: unknown, resultInfo?: unknown) =>
  Response.json({ success: true, result, result_info: resultInfo });
const page = (policies: unknown[]) => cloudflareResponse(policies, { total_pages: 2 });
const fetcher = vi.fn<typeof fetch>();
let provider: typeof githubProvider | undefined;
const client = new VisitorPolicyClient(config, fetcher, undefined, () => provider);

function respond(...responses: unknown[]) {
  for (const response of responses) {
    const payload = response instanceof Response ? response : cloudflareResponse(response);
    fetcher.mockResolvedValueOnce(payload);
  }
}

function requestBody(index: number) {
  const body = fetcher.mock.calls[index]?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(body) as unknown;
}

const methods = () => fetcher.mock.calls.map(([, request]) => request?.method).join(" ");

describe("VisitorPolicyClient", () => {
  beforeEach(() => {
    fetcher.mockReset();
    provider = { ...githubProvider };
  });

  it.each([1, 32])("bounds a streamed %i MiB Cloudflare response", async (paddingMiB) => {
    const padding = new Uint8Array(1024 * 1024).fill(32);
    let remaining = paddingMiB;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"success":true,"result":[]}'));
      },
      pull(controller) {
        if (remaining-- > 0) {
          controller.enqueue(padding);
        } else {
          controller.close();
        }
      },
      cancel,
    });
    respond(new Response(body));
    if (paddingMiB === 1) {
      await expect(client.read()).resolves.toBeUndefined();
    } else {
      await expect(client.read()).rejects.toThrow("Cloudflare returned an unreadable response");
      expect(cancel).toHaveBeenCalledOnce();
      expect(remaining).toBeGreaterThan(0);
    }
  });

  it.each([
    ["githubAccountIdClaim", false],
    ["issuer", true],
  ] as const)("pins %s through renewal (after response: %s)", async (field, afterResponse) => {
    const policy = namedPolicy([42]);
    respond([], policy, [policy], policy);
    const changed = { ...githubProvider, [field]: "changed" };
    fetcher.mockImplementationOnce(async () => {
      provider = changed;
      return cloudflareResponse(namedPolicy([42, 43]));
    });
    await expect(client.update(() => [42])).resolves.toEqual([42]);
    expect(requestBody(1)).toEqual({
      name: config.policyName,
      decision: "allow",
      include: [githubRule],
    });
    await expect(
      client.update(() => {
        if (!afterResponse) {
          provider = changed;
        }
        return afterResponse ? [42, 43] : [42];
      }),
    ).rejects.toThrow("mapping changed");
    expect(methods()).toEqual(afterResponse ? "GET POST GET GET PUT" : "GET POST GET GET");
  });

  it("rereads dashboard targets and preserves restrictions on update", async () => {
    const original = namedPolicy(["A@b.com", 42]);
    const restrictions = {
      precedence: 9,
      session_duration: "12h",
      approval_required: true,
      approval_groups: [{ approvals_needed: 1, email_addresses: ["approver@example.com"] }],
      mfa_config: { mfa_disabled: false },
    };
    const updated = {
      ...namedPolicy(["a@b.com", "m@b.com", 42]),
      ...restrictions,
      created_at: "2026-08-28T00:00:00Z",
    };
    const other = { id: "other", name: "Other" };
    respond(page([other]), page([original]), original, [updated], updated, updated);
    expect(await client.read()).toEqual({ id: original.id, targets: ["a@b.com", 42] });
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${collectionUrl}?page=2&per_page=100`);

    const expected = ["a@b.com", "m@b.com", 42, "n@b.com", 84];
    expect(await client.update((targets) => [...targets, "n@b.com", 84])).toEqual(expected);

    const { id, ...payload } = namedPolicy(expected);
    expect(requestBody(5)).toEqual({ ...payload, ...restrictions });
    expect(fetcher.mock.calls[5]?.[0]).toBe(`${collectionUrl}/${id}`);
    expect(fetcher.mock.calls[5]?.[1]?.method).toBe("PUT");
  });

  it.each<[Record<string, unknown>, (typeof githubProvider | null)?]>([
    [{ decision: "deny" }],
    [{ include: [{ everyone: {} }] }],
    [{ include: [{ email: { email: "first@example.com" }, everyone: {} }] }],
    [{ include: [githubRule] }, null],
    [{ include: [oidc({ identity_provider_id: "other-provider" })] }],
    [{ include: [oidc({ claim_name: "login" })] }],
    [{ include: [{ ...githubRule, everyone: {} }] }],
    [{ include: [oidc({ login: "visitor" })] }],
    [{ include: [oidc({ claim_value: "042" })] }],
    [{ include: [oidc({ claim_value: "9007199254740992" })] }],
    [{ include: [oidc({ claim_value: 42 })] }],
    [{ require: [{ email_domain: { domain: "example.com" } }] }],
    [{ exclude: [{ email: { email: "excluded@example.com" } }] }],
    [{ name: "GitHub organization" }],
    [{ id: "other-policy" }],
  ])("rejects %j (provider %j)", async (override, mapping = githubProvider) => {
    const policy = namedPolicy();
    respond([policy], { ...policy, ...override });
    provider = mapping ?? undefined;
    const change = vi.fn(() => ["next@example.com"]);
    await expect(client.update(change)).rejects.toBeInstanceOf(VisitorAccessError);
    expect(change).not.toHaveBeenCalled();
    expect(methods()).toBe("GET GET");
  });

  it("rejects duplicate policies across pages without writing", async () => {
    const policy = namedPolicy();
    respond(page([policy]), page([{ ...policy, id: "duplicate" }]));
    await expect(client.update(() => [])).rejects.toBeInstanceOf(VisitorAccessError);
    expect(methods()).toBe("GET GET");
  });

  it.each([
    ["network", () => Promise.reject(new Error(config.apiToken))],
    ["http", async () => new Response(config.apiToken, { status: 403 })],
    ["api", async () => Response.json({ success: false, errors: [{ message: config.apiToken }] })],
    ["json", async () => new Response(config.apiToken)],
  ] as const)("never exposes token-bearing %s failures", async (_mode, response) => {
    fetcher.mockImplementationOnce(response);
    const error = await client.read().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(VisitorAccessError);
    expect(String(error)).not.toContain(config.apiToken);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("fences an obsolete service before the durable callback runs", async () => {
    const abort = new AbortController();
    fetcher.mockImplementationOnce(async () => {
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
