// Legacy httpUrl migration shares the managed bind and probe port policy.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract-api.js";

function signalConfig(entry: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      // SAFETY: retired httpUrl fields are the migration input, not the current channel type.
      signal: entry as NonNullable<OpenClawConfig["channels"]>["signal"],
    },
  };
}

describe("signal legacy URL port migration", () => {
  it("allocates distinct managed ports while materializing named account ownership", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        account: "+15555550123",
        httpPort: 8080,
        accounts: { work: { account: "+15555550124" } },
      }),
    });

    expect(result.config.channels?.signal?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8080,
    });
    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      httpPort: 8081,
    });
  });

  it("keeps a free URL-only local httpUrl as the migrated managed bind", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        accounts: {
          work: {
            account: "+15555550124",
            httpUrl: "http://127.0.0.1:8082",
          },
        },
      }),
    });
    const reloaded = normalizeCompatibilityConfig({ cfg: result.config });

    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8082",
      httpPort: 8082,
    });
    expect(reloaded.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8082",
      httpPort: 8082,
    });
  });

  it("keeps a path-prefixed local httpUrl independent of the migrated managed bind", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        accounts: {
          work: {
            account: "+15555550124",
            httpUrl: "http://127.0.0.1:8082/signal",
          },
        },
      }),
    });
    const reloaded = normalizeCompatibilityConfig({ cfg: result.config });

    expect(result.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8082/signal",
      httpPort: 8080,
    });
    expect(reloaded.config.channels?.signal?.accounts?.work?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8082/signal",
      httpPort: 8080,
    });
  });

  it("rewrites a named URL-only httpUrl when another account already claimed 8082", () => {
    const result = normalizeCompatibilityConfig({
      cfg: signalConfig({
        apiMode: "native",
        autoStart: true,
        account: "+15555550123",
        httpUrl: "http://127.0.0.1:8082",
        accounts: {
          work: {
            account: "+15555550124",
            httpUrl: "http://127.0.0.1:8082",
          },
        },
      }),
    });
    const work = result.config.channels?.signal?.accounts?.work?.transport;
    expect(result.config.channels?.signal?.transport).toMatchObject({
      kind: "managed-native",
      url: "http://127.0.0.1:8082",
    });
    expect(work?.kind).toBe("managed-native");
    if (work?.kind !== "managed-native") {
      throw new Error("expected managed-native");
    }
    expect(work.httpPort).not.toBe(8082);
    expect(work.url).toBe(`http://127.0.0.1:${work.httpPort}`);
  });
});
