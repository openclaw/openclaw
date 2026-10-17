import * as network from "openclaw/plugin-sdk/ssrf-runtime";
import { vi } from "vitest";

export function mockMatrixQaHttp() {
  const release = vi.fn(async () => {});
  const request = vi
    .spyOn(network, "fetchWithSsrFGuard")
    .mockImplementation(async ({ url, init }) => ({
      response: await fetch(url, init),
      finalUrl: url,
      release,
    }));
  return { request, release };
}
