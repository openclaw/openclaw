/**
 * Test mocks that pin Browser SSRF DNS lookups to a public example address.
 */
import { vi } from "vitest";

const lookupFn = vi.hoisted(() => async (_hostname: string, options?: { all?: boolean }) => {
  const result = { address: "93.184.216.34", family: 4 };
  return options?.all === true ? [result] : result;
});

vi.mock("openclaw/plugin-sdk/security-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/security-runtime")>(
    "openclaw/plugin-sdk/security-runtime",
  );
  return {
    ...actual,
    resolvePinnedHostnameWithPolicy: (hostname: string, params: object = {}) =>
      actual.resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupFn as never }),
  };
});
