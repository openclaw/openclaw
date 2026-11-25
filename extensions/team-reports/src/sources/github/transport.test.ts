import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { createGithubSource } from "./index.js";
import { config, logger } from "./responses.fixtures.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it.each([true, false])(
  "releases guarded responses after body consumption (valid JSON: %s)",
  async (valid) => {
    const response = new Response(valid ? '[{"login":"builder"}]' : "invalid-json");
    const release = vi.fn(async () => {
      expect(response.bodyUsed).toBe(true);
    });
    vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
      response,
      finalUrl: config.apiBaseUrl,
      release,
    });
    const result = await createGithubSource({ logger }).loadRoster(config);
    expect(result.status.ok).toBe(valid);
    expect(release).toHaveBeenCalledOnce();
    const options = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
    expect(options).toMatchObject({
      requireHttps: true,
      timeoutMs: 30_000,
      maxRedirects: 0,
    });
    expect(new Headers(options?.init?.headers).get("Authorization")).toBe(`Bearer ${config.token}`);
  },
);
