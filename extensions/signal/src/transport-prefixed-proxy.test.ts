import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import {
  prepareSignalManagedNativeTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

const proxyUrl = "http://127.0.0.1:8080/signal";

function savedProxyConfig(): OpenClawConfig {
  return {
    channels: {
      signal: {
        transport: {
          kind: "managed-native",
          url: proxyUrl,
        },
      },
    },
  };
}

it("keeps a same-port path prefix on the proxy and binds the daemon beside it", () => {
  const prepared = prepareSignalManagedNativeTransport({
    cfg: savedProxyConfig(),
    accountId: "default",
  });

  expect(prepared.url).toBe(proxyUrl);
  expect(prepared.httpPort).toBe(8081);

  const reloaded = prepareSignalManagedNativeTransport({
    cfg: writeSignalAccountTransport({
      cfg: savedProxyConfig(),
      accountId: "default",
      transport: prepared,
    }),
    accountId: "default",
  });

  expect(reloaded.url).toBe(proxyUrl);
  expect(reloaded.httpPort).toBe(8081);
});
