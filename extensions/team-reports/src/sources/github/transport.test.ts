import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { oversizedResponse } from "../oversized-response.test-support.js";
import { createGithubSource } from "./index.js";
import { config, logger } from "./responses.fixtures.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it.each([true, false])(
  "releases guarded responses after body consumption (valid JSON: %s)",
  async (valid) => {
    const controller = new AbortController();
    const response = new Response(valid ? '[{"login":"builder"}]' : "invalid-json");
    const release = vi.fn(async () => {
      expect(response.bodyUsed).toBe(true);
    });
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: config.apiBaseUrl,
      release,
    });
    const result = await createGithubSource({ logger, signal: controller.signal }).loadRoster(
      config,
    );
    expect(result.status.ok).toBe(valid);
    expect(release).toHaveBeenCalledOnce();
    const options = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      requireHttps: true,
      timeoutMs: 30_000,
      signal: controller.signal,
      maxRedirects: 0,
    });
    expect(new Headers(options?.init?.headers).get("Authorization")).toBe(`Bearer ${config.token}`);
  },
);

it("cancels and releases an oversized API response with actionable status", async () => {
  const { response, cancellations } = oversizedResponse();
  const release = vi.fn(async () => {
    expect(response.bodyUsed).toBe(true);
  });
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response,
    finalUrl: config.apiBaseUrl,
    release,
  });

  const result = await createGithubSource({ logger }).loadRoster(config);

  expect(result.status.ok).toBe(false);
  expect(result.status.warnings).toEqual([
    expect.stringMatching(/response exceeded the 16 MiB safety limit.*compatibility.*retry/i),
  ]);
  await vi.waitFor(() => expect(cancellations()).toBe(1));
  expect(release).toHaveBeenCalledOnce();
});
