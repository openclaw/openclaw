import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { MAX_API_RESPONSE_BYTES } from "../../limits.js";
import { createGithubSource } from "./index.js";
import { config, logger, oversizedRoster } from "./responses.fixtures.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it.each<[string, BodyInit, boolean, string]>([
  ["valid JSON", '[{"login":"builder"}]', true, ""],
  ["invalid JSON", "invalid-json", false, "Invalid JSON API response"],
  ["oversized JSON", oversizedRoster(), false, "API response exceeded the 32 MiB limit"],
])("releases guarded responses after consuming %s", async (_label, body, ok, warning) => {
  const response = new Response(body);
  const release = vi.fn(async () => {
    expect(response.bodyUsed).toBe(true);
  });
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response,
    finalUrl: config.apiBaseUrl,
    release,
  });
  const result = await createGithubSource({ logger }).loadRoster(config);
  expect(result.status.ok).toBe(ok);
  expect(result.status.warnings).toEqual(warning ? [expect.stringContaining(warning)] : []);
  if (_label === "oversized JSON") {
    // The warning names the bytes read, so an operator sees where the cutoff tripped.
    const read = /\(read ([\d,]+) bytes before the cutoff\)/u.exec(result.status.warnings[0] ?? "");
    expect(Number(read?.[1]?.replaceAll(",", ""))).toBeGreaterThan(MAX_API_RESPONSE_BYTES);
  }
  expect(release).toHaveBeenCalledOnce();
  const options = vi.mocked(fetchWithSsrFGuard).mock.calls[0]?.[0];
  expect(options).toMatchObject({ requireHttps: true, timeoutMs: 30_000, maxRedirects: 0 });
  expect(new Headers(options?.init?.headers).get("Authorization")).toBe(`Bearer ${config.token}`);
});

it("names the advertised page size when an oversized response declares one", async () => {
  const declared = MAX_API_RESPONSE_BYTES + 4 * 1024 * 1024;
  const response = new Response(oversizedRoster(), {
    headers: { "content-length": String(declared) },
  });
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response,
    finalUrl: config.apiBaseUrl,
    release: vi.fn(async () => {}),
  });
  const result = await createGithubSource({ logger }).loadRoster(config);
  expect(result.status.warnings).toEqual([
    expect.stringContaining(
      `API response exceeded the 32 MiB limit (host declared ${declared.toLocaleString("en-US")} bytes)`,
    ),
  ]);
});
