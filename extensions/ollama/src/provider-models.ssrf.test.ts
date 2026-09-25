import {
  type LookupFn,
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
} from "openclaw/plugin-sdk/ssrf-runtime";
// Ollama tests cover provider models.ssrf plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { buildOllamaBaseUrlSsrFPolicy, buildOllamaEmbeddingSsrFPolicy } from "./provider-models.js";

describe("buildOllamaBaseUrlSsrFPolicy", () => {
  it("pins requests to the configured Ollama hostname for HTTP(S) URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      hostnameAllowlist: ["127.0.0.1"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("http://192.168.1.10:11434")).toEqual({
      hostnameAllowlist: ["192.168.1.10"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      hostnameAllowlist: ["ollama.example.com"],
      allowPrivateNetwork: true,
    });
  });

  it("opts into private-network access for explicit Ollama hosts", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("http://localhost:11434")).toEqual({
      hostnameAllowlist: ["localhost"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("http://[fd00::1]:11434")).toEqual({
      hostnameAllowlist: ["[fd00::1]"],
      allowPrivateNetwork: true,
    });
    expect(buildOllamaBaseUrlSsrFPolicy("https://ollama.local:11434")).toEqual({
      hostnameAllowlist: ["ollama.local"],
      allowPrivateNetwork: true,
    });
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaBaseUrlSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("not-a-url")).toBeUndefined();
    expect(buildOllamaBaseUrlSsrFPolicy("http://metadata.google.internal")).toBeUndefined();
  });
});

describe("buildOllamaEmbeddingSsrFPolicy", () => {
  it("pins to the configured exact origin, without a hostname allowlist or allowPrivateNetwork", () => {
    expect(buildOllamaEmbeddingSsrFPolicy("http://127.0.0.1:11434")).toEqual({
      allowedOrigins: ["http://127.0.0.1:11434"],
      allowUnspecifiedIpv4Range: true,
    });
    expect(buildOllamaEmbeddingSsrFPolicy("https://ollama.example.com/v1")).toEqual({
      allowedOrigins: ["https://ollama.example.com"],
      allowUnspecifiedIpv4Range: true,
    });
  });

  it("never sets hostnameAllowlist (that would block a redirect to a different public hostname the prior origin-only policy always allowed)", () => {
    expect(
      buildOllamaEmbeddingSsrFPolicy("http://127.0.0.1:11434")?.hostnameAllowlist,
    ).toBeUndefined();
    expect(
      buildOllamaEmbeddingSsrFPolicy("http://host.docker.internal:11434")?.hostnameAllowlist,
    ).toBeUndefined();
  });

  it("scopes trust to the exact origin (including port), unlike a flat hostname allowlist", () => {
    const policy = buildOllamaEmbeddingSsrFPolicy("http://model.lan:11434");
    expect(policy?.allowedOrigins).toEqual(["http://model.lan:11434"]);
    // A same-hostname, different-port origin is deliberately NOT in the allowlist — see
    // src/infra/net/ssrf.ts's resolveSsrFPolicyForUrl, which only promotes hostname trust
    // for a request whose URL origin exactly matches.
    expect(policy?.allowedOrigins).not.toContain("http://model.lan:9999");
  });

  it("never sets allowPrivateNetwork (that would waive loopback/link-local/cloud-metadata protections too)", () => {
    expect(
      buildOllamaEmbeddingSsrFPolicy("http://127.0.0.1:11434")?.allowPrivateNetwork,
    ).toBeUndefined();
    expect(
      buildOllamaEmbeddingSsrFPolicy("http://host.docker.internal:11434")?.allowPrivateNetwork,
    ).toBeUndefined();
  });

  it("returns no allowlist for empty or invalid base URLs", () => {
    expect(buildOllamaEmbeddingSsrFPolicy("")).toBeUndefined();
    expect(buildOllamaEmbeddingSsrFPolicy("ftp://ollama.example.com")).toBeUndefined();
    expect(buildOllamaEmbeddingSsrFPolicy("not-a-url")).toBeUndefined();
    expect(buildOllamaEmbeddingSsrFPolicy("http://metadata.google.internal")).toBeUndefined();
  });

  it("preserves guarded redirects to a different public hostname (regression: a static hostnameAllowlist would block these)", async () => {
    const configuredUrl = new URL("http://host.docker.internal:11434/api/embed");
    const policy = buildOllamaEmbeddingSsrFPolicy(configuredUrl.origin);
    const policyForConfiguredRequest = resolveSsrFPolicyForUrl(configuredUrl, policy);

    // A redirect target on a different, unrelated public hostname does not inherit the
    // configured origin's trust (resolveSsrFPolicyForUrl only promotes an exact-origin
    // match), so it falls through to ordinary SSRF checks rather than the private-network
    // exemption — matching the pre-fix origin-only policy's redirect behavior. It must not
    // be rejected up front by a static hostnameAllowlist, which this policy deliberately
    // does not set.
    const publicRedirectLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]) as unknown as LookupFn;
    const redirectUrl = new URL("https://redirect.example.com/embed");
    const policyForRedirect = resolveSsrFPolicyForUrl(redirectUrl, policy);
    await expect(
      resolvePinnedHostnameWithPolicy(redirectUrl.hostname, {
        lookupFn: publicRedirectLookup,
        policy: policyForRedirect,
      }),
    ).resolves.toMatchObject({ addresses: ["93.184.216.34"] });

    // A redirect to a private-range address on that same unrelated hostname is still
    // rejected by ordinary SSRF checks (it never gained the exemption in the first place).
    const privateRedirectLookup = vi.fn(async () => [
      { address: "10.0.0.5", family: 4 as const },
    ]) as unknown as LookupFn;
    await expect(
      resolvePinnedHostnameWithPolicy(redirectUrl.hostname, {
        lookupFn: privateRedirectLookup,
        policy: policyForRedirect,
      }),
    ).rejects.toThrow(/private|internal/i);

    // The configured origin itself keeps the exemption.
    const configuredHostLookup = vi.fn(async () => [
      { address: "0.250.250.254", family: 4 as const },
    ]) as unknown as LookupFn;
    await expect(
      resolvePinnedHostnameWithPolicy(configuredUrl.hostname, {
        lookupFn: configuredHostLookup,
        policy: policyForConfiguredRequest,
      }),
    ).resolves.toMatchObject({ addresses: ["0.250.250.254"] });
  });
});
