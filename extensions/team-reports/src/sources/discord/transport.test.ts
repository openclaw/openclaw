import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import type { SourceStatus } from "../../types.js";
import { oversizedResponse } from "../oversized-response.test-support.js";
import { createClient } from "./client.js";
import { config } from "./discord.fixtures.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("cancels and releases an oversized API response with an actionable error", async () => {
  const { response, cancellations } = oversizedResponse();
  const release = vi.fn(async () => {
    expect(response.bodyUsed).toBe(true);
  });
  vi.mocked(fetchWithSsrFGuard).mockResolvedValue({
    response,
    finalUrl: config.apiBaseUrl,
    release,
  });
  const status: SourceStatus = { ok: true, warnings: [], stats: {} };
  const client = createClient(config, { logger: { info() {}, warn() {}, error() {} } }, status);

  await expect(client.get("/guilds/10/channels")).rejects.toThrow(
    /response exceeded the 16 MiB safety limit.*compatibility.*retry/i,
  );
  await vi.waitFor(() => expect(cancellations()).toBe(1));
  expect(release).toHaveBeenCalledOnce();
  expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
});
