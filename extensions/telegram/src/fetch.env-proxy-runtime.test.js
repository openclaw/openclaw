import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
const require2 = createRequire(import.meta.url);
const EnvHttpProxyAgent = require2("undici/lib/dispatcher/env-http-proxy-agent.js");
const { kHttpsProxyAgent, kNoProxyAgent } = require2("undici/lib/core/symbols.js");
function getOwnSymbolValue(target, description) {
  const symbol = Object.getOwnPropertySymbols(target).find(
    (entry) => entry.description === description
  );
  const value = symbol ? target[symbol] : void 0;
  return value && typeof value === "object" ? value : void 0;
}
afterEach(() => {
  vi.unstubAllEnvs();
});
describe("undici env proxy semantics", () => {
  it("uses proxyTls rather than connect for proxied HTTPS transport settings", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const connect = {
      family: 4,
      autoSelectFamily: false
    };
    const withoutProxyTls = new EnvHttpProxyAgent({ connect });
    const noProxyAgent = withoutProxyTls[kNoProxyAgent];
    const httpsProxyAgent = withoutProxyTls[kHttpsProxyAgent];
    expect(getOwnSymbolValue(noProxyAgent, "options")?.connect).toEqual(
      expect.objectContaining(connect)
    );
    expect(getOwnSymbolValue(httpsProxyAgent, "proxy tls settings")).toBeUndefined();
    const withProxyTls = new EnvHttpProxyAgent({
      connect,
      proxyTls: connect
    });
    const httpsProxyAgentWithProxyTls = withProxyTls[kHttpsProxyAgent];
    expect(getOwnSymbolValue(httpsProxyAgentWithProxyTls, "proxy tls settings")).toEqual(
      expect.objectContaining(connect)
    );
  });
});
