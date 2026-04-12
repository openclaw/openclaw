import { describe, expect, it, vi } from "vitest";
import type { NetworkPolicy } from "./network-policy.js";
import {
  DEFAULT_OUTBOUND_PROXY_IMAGE,
  DEFAULT_OUTBOUND_PROXY_PORT,
  ensureOutboundProxy,
  type OutboundProxyDocker,
  renderTinyproxyConfig,
  resolveOutboundProxyBinding,
  resolveOutboundProxyNames,
} from "./outbound-proxy.js";

const policy = (overrides: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  agentId: "quinn",
  mode: "allowlist",
  allowedHosts: ["api.anthropic.com", "api.stripe.com"],
  ...overrides,
});

const buildDocker = (
  overrides: Partial<OutboundProxyDocker> = {},
): { docker: OutboundProxyDocker; calls: Record<string, number> } => {
  const calls: Record<string, number> = {
    networkExists: 0,
    createInternalNetwork: 0,
    containerExists: 0,
    containerRunning: 0,
    removeContainer: 0,
    runTinyproxyContainer: 0,
    attachToBridge: 0,
  };
  const docker: OutboundProxyDocker = {
    networkExists: vi.fn(async () => {
      calls.networkExists++;
      return false;
    }),
    createInternalNetwork: vi.fn(async () => {
      calls.createInternalNetwork++;
    }),
    containerExists: vi.fn(async () => {
      calls.containerExists++;
      return false;
    }),
    containerRunning: vi.fn(async () => {
      calls.containerRunning++;
      return false;
    }),
    removeContainer: vi.fn(async () => {
      calls.removeContainer++;
    }),
    runTinyproxyContainer: vi.fn(async () => {
      calls.runTinyproxyContainer++;
    }),
    attachToBridge: vi.fn(async () => {
      calls.attachToBridge++;
    }),
    ...overrides,
  };
  return { docker, calls };
};

describe("resolveOutboundProxyNames", () => {
  it("prefixes network and container names with the slugified agentId", () => {
    expect(resolveOutboundProxyNames("quinn")).toEqual({
      internalNetwork: "openclaw-allowlist-quinn",
      proxyContainer: "openclaw-proxy-quinn",
    });
  });

  it("lowercases and replaces unsafe characters", () => {
    expect(resolveOutboundProxyNames("QUINN@Voice!")).toEqual({
      internalNetwork: "openclaw-allowlist-quinn-voice",
      proxyContainer: "openclaw-proxy-quinn-voice",
    });
  });

  it("falls back to 'unknown' for empty/whitespace agentId", () => {
    expect(resolveOutboundProxyNames("   ")).toEqual({
      internalNetwork: "openclaw-allowlist-unknown",
      proxyContainer: "openclaw-proxy-unknown",
    });
  });
});

describe("renderTinyproxyConfig", () => {
  it("emits a config body with core directives + Filter pointing at /etc/tinyproxy/filter", () => {
    const { configBody, filterBody } = renderTinyproxyConfig(policy());
    expect(configBody).toContain(`Port ${DEFAULT_OUTBOUND_PROXY_PORT}`);
    expect(configBody).toContain(`Listen 0.0.0.0`);
    expect(configBody).toContain(`Filter "/etc/tinyproxy/filter"`);
    expect(configBody).toContain(`FilterDefaultDeny Yes`);
    expect(configBody).toContain(`ConnectPort 443`);
    expect(filterBody).toContain("^api\\.anthropic\\.com$");
    expect(filterBody).toContain("^api\\.stripe\\.com$");
  });

  it("strips shell metacharacters and path separators from hostnames (injection safety)", () => {
    const { filterBody } = renderTinyproxyConfig(
      policy({ allowedHosts: ["api.example.com; rm -rf /"] }),
    );
    expect(filterBody).toContain("^api\\.example\\.com");
    // Shell metacharacters must not survive into the filter file
    expect(filterBody).not.toContain(";");
    expect(filterBody).not.toContain(" ");
    expect(filterBody).not.toContain("/");
    // Regex metachars besides the anchors and the escaped dots must be gone
    expect(filterBody).not.toContain("*");
    expect(filterBody).not.toContain("?");
    expect(filterBody).not.toContain("(");
    expect(filterBody).not.toContain("|");
  });

  it("throws on non-allowlist policies", () => {
    expect(() => renderTinyproxyConfig(policy({ mode: "open" }))).toThrow(/non-allowlist/);
  });

  it("throws when allowedHosts is empty", () => {
    expect(() => renderTinyproxyConfig(policy({ allowedHosts: [] }))).toThrow(/empty/);
  });
});

describe("resolveOutboundProxyBinding", () => {
  it("returns the env map the sandbox spawn needs to route through the proxy", () => {
    const binding = resolveOutboundProxyBinding(policy());
    expect(binding.internalNetwork).toBe("openclaw-allowlist-quinn");
    expect(binding.proxyContainer).toBe("openclaw-proxy-quinn");
    expect(binding.proxyUrl).toBe(`http://openclaw-proxy-quinn:${DEFAULT_OUTBOUND_PROXY_PORT}`);
    expect(binding.env).toMatchObject({
      HTTP_PROXY: binding.proxyUrl,
      HTTPS_PROXY: binding.proxyUrl,
      http_proxy: binding.proxyUrl,
      https_proxy: binding.proxyUrl,
    });
    expect(binding.env.NO_PROXY).toContain("localhost");
    expect(binding.env.NO_PROXY).toContain("127.0.0.1");
  });

  it("respects custom image + port overrides", () => {
    const binding = resolveOutboundProxyBinding(policy(), {
      image: "custom/tinyproxy:1.0",
      port: 9999,
    });
    expect(binding.image).toBe("custom/tinyproxy:1.0");
    expect(binding.proxyUrl).toBe("http://openclaw-proxy-quinn:9999");
    expect(binding.env.HTTP_PROXY).toBe("http://openclaw-proxy-quinn:9999");
  });

  it("defaults to the pinned dannydirect/tinyproxy image", () => {
    const binding = resolveOutboundProxyBinding(policy());
    expect(binding.image).toBe(DEFAULT_OUTBOUND_PROXY_IMAGE);
  });
});

describe("ensureOutboundProxy", () => {
  it("creates network + container on first call", async () => {
    const { docker, calls } = buildDocker();
    const result = await ensureOutboundProxy({ policy: policy(), docker });
    expect(calls.networkExists).toBe(1);
    expect(calls.createInternalNetwork).toBe(1);
    expect(calls.containerExists).toBe(1);
    expect(calls.runTinyproxyContainer).toBe(1);
    expect(calls.attachToBridge).toBe(1);
    expect(result.created).toBe(true);
    expect(result.reused).toBe(false);
  });

  it("skips network creation when the network already exists", async () => {
    const { docker, calls } = buildDocker({
      networkExists: vi.fn(async () => true),
    });
    await ensureOutboundProxy({ policy: policy(), docker });
    expect(calls.createInternalNetwork).toBe(0);
  });

  it("reuses a running proxy container without recreating it", async () => {
    const { docker, calls } = buildDocker({
      networkExists: vi.fn(async () => true),
      containerExists: vi.fn(async () => true),
      containerRunning: vi.fn(async () => true),
    });
    const result = await ensureOutboundProxy({ policy: policy(), docker });
    expect(calls.runTinyproxyContainer).toBe(0);
    expect(calls.removeContainer).toBe(0);
    expect(result.reused).toBe(true);
    expect(result.created).toBe(false);
  });

  it("removes a stopped container before recreating it", async () => {
    const { docker, calls } = buildDocker({
      networkExists: vi.fn(async () => true),
      containerExists: vi.fn(async () => true),
      containerRunning: vi.fn(async () => false),
    });
    const result = await ensureOutboundProxy({ policy: policy(), docker });
    expect(calls.removeContainer).toBe(1);
    expect(calls.runTinyproxyContainer).toBe(1);
    expect(result.created).toBe(true);
  });

  it("passes the rendered config + filter bodies into runTinyproxyContainer", async () => {
    let capturedConfig = "";
    let capturedFilter = "";
    const { docker } = buildDocker({
      runTinyproxyContainer: vi.fn(async (params) => {
        capturedConfig = params.configBody;
        capturedFilter = params.filterBody;
      }),
    });
    await ensureOutboundProxy({ policy: policy(), docker });
    expect(capturedConfig).toContain(`Port ${DEFAULT_OUTBOUND_PROXY_PORT}`);
    expect(capturedConfig).toContain(`FilterDefaultDeny Yes`);
    expect(capturedFilter).toContain("^api\\.anthropic\\.com$");
  });

  it("throws on non-allowlist policies", async () => {
    const { docker } = buildDocker();
    await expect(
      ensureOutboundProxy({ policy: policy({ mode: "open" }), docker }),
    ).rejects.toThrow(/non-allowlist/);
  });
});
