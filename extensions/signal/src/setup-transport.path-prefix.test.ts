// Path-prefixed managed-native URLs stay independent of daemon bind allocation.
import { describe, expect, it } from "vitest";
import { resolveSignalAccount } from "./accounts.js";
import {
  prepareSignalManagedNativeTransport,
  writeSignalAccountTransport,
} from "./setup-transport.js";

describe("prepareSignalManagedNativeTransport path-prefixed proxy URLs", () => {
  it("does not infer daemon bind from a path-prefixed local proxy URL", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8082/signal",
          },
        },
      },
    } as const;

    const transport = prepareSignalManagedNativeTransport({
      cfg,
      accountId: "default",
    });
    const next = writeSignalAccountTransport({
      cfg,
      accountId: "default",
      transport,
    });

    expect(transport).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8082/signal",
      httpHost: "127.0.0.1",
      httpPort: 8080,
    });
    expect(resolveSignalAccount({ cfg: next, accountId: "default" }).transport).toMatchObject({
      kind: "managed-native",
      baseUrl: "http://127.0.0.1:8082/signal",
      httpPort: 8080,
    });
  });

  it("preserves a path-prefixed proxy URL when setup changes the bind", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15555550123",
          transport: {
            kind: "managed-native",
            url: "http://127.0.0.1:8082/signal",
          },
        },
      },
    } as const;

    expect(
      prepareSignalManagedNativeTransport({
        cfg,
        accountId: "default",
        overrides: { httpPort: 8282 },
      }),
    ).toEqual({
      kind: "managed-native",
      url: "http://127.0.0.1:8082/signal",
      httpHost: "127.0.0.1",
      httpPort: 8282,
    });
  });

  it("keeps a path-prefixed proxy URL when fallback allocates a different bind", () => {
    const cfg = {
      channels: {
        signal: {
          accounts: {
            sibling: {
              account: "+15555550123",
              transport: { kind: "external-native", url: "http://127.0.0.1:8080" },
            },
            work: {
              account: "+15555550124",
              transport: { kind: "managed-native", url: "http://127.0.0.1:8082/signal" },
            },
          },
        },
      },
    } as const;

    const transport = prepareSignalManagedNativeTransport({
      cfg,
      accountId: "work",
    });
    const next = writeSignalAccountTransport({
      cfg,
      accountId: "work",
      transport,
    });

    expect(transport.httpPort).not.toBe(8080);
    expect(transport.httpPort).not.toBe(8082);
    expect(transport.url).toBe("http://127.0.0.1:8082/signal");
    expect(resolveSignalAccount({ cfg: next, accountId: "work" }).transport).toMatchObject({
      httpPort: transport.httpPort,
      baseUrl: "http://127.0.0.1:8082/signal",
    });
  });
});
