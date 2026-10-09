import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  describeTelegramMiniAppUrlError,
  resolveTelegramMiniAppUrls,
  TELEGRAM_MINIAPP_URL_ERROR,
  TelegramMiniAppUrlError,
} from "./url.js";

describe("resolveTelegramMiniAppUrls", () => {
  it("resolves HTTPS page and WSS gateway URLs from Tailscale Serve", async () => {
    const runCommand = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
    }));
    const cfg = {
      gateway: {
        tailscale: { mode: "serve" },
        controlUi: { basePath: "/openclaw/" },
      },
    } satisfies OpenClawConfig;

    await expect(resolveTelegramMiniAppUrls({ cfg, runCommand })).resolves.toEqual({
      pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
      controlUiUrl: "https://host.tailnet.ts.net/openclaw",
      gatewayUrl: "wss://host.tailnet.ts.net/openclaw",
    });
    expect(runCommand).toHaveBeenCalledWith(["tailscale", "status", "--json"], {
      timeoutMs: 5000,
    });
  });

  it("fails loud when Tailscale mode is off or MagicDNS cannot resolve", async () => {
    await expect(resolveTelegramMiniAppUrls({ cfg: {} })).rejects.toThrow(
      TELEGRAM_MINIAPP_URL_ERROR,
    );
    await expect(
      resolveTelegramMiniAppUrls({
        cfg: { gateway: { tailscale: { mode: "funnel" } } },
        runCommand: async () => ({ code: 1, stdout: "" }),
      }),
    ).rejects.toThrow(TELEGRAM_MINIAPP_URL_ERROR);
  });

  it("builds URLs from an https gateway.publicOrigin without Tailscale", async () => {
    const runCommand = vi.fn();
    const cfg = {
      gateway: {
        publicOrigin: "https://gateway.example.com/",
        tailscale: { mode: "off" },
      },
    } satisfies OpenClawConfig;

    await expect(resolveTelegramMiniAppUrls({ cfg, runCommand })).resolves.toEqual({
      pageUrl: "https://gateway.example.com/__openclaw_tg_miniapp/",
      controlUiUrl: "https://gateway.example.com",
      gatewayUrl: "wss://gateway.example.com",
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("applies controlUi.basePath to gateway.publicOrigin URLs", async () => {
    const cfg = {
      gateway: {
        publicOrigin: " https://gateway.example.com:8443 ",
        tailscale: { mode: "serve" },
        controlUi: { basePath: "/openclaw/" },
      },
    } satisfies OpenClawConfig;

    await expect(resolveTelegramMiniAppUrls({ cfg, runCommand: vi.fn() })).resolves.toEqual({
      pageUrl: "https://gateway.example.com:8443/__openclaw_tg_miniapp/",
      controlUiUrl: "https://gateway.example.com:8443/openclaw",
      gatewayUrl: "wss://gateway.example.com:8443/openclaw",
    });
  });

  it.each(["http://gateway.example.com", "https://gateway.example.com/openclaw", "not a url"])(
    "ignores unusable gateway.publicOrigin %s and keeps the Tailscale path",
    async (publicOrigin) => {
      await expect(
        resolveTelegramMiniAppUrls({ cfg: { gateway: { publicOrigin } } }),
      ).rejects.toThrow(TELEGRAM_MINIAPP_URL_ERROR);

      const runCommand = vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
      }));
      await expect(
        resolveTelegramMiniAppUrls({
          cfg: { gateway: { publicOrigin, tailscale: { mode: "serve" } } },
          runCommand,
        }),
      ).resolves.toMatchObject({ pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/" });
    },
  );

  describe("mixed ingress (gateway.publicOrigin + Tailscale)", () => {
    const tailnetStatus = () =>
      vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
      }));

    it("prefers gateway.publicOrigin when controlUi.allowedOrigins is unset", async () => {
      const runCommand = tailnetStatus();
      await expect(
        resolveTelegramMiniAppUrls({
          cfg: {
            gateway: {
              publicOrigin: "https://gateway.example.com",
              tailscale: { mode: "serve" },
            },
          },
          runCommand,
        }),
      ).resolves.toMatchObject({ pageUrl: "https://gateway.example.com/__openclaw_tg_miniapp/" });
      expect(runCommand).not.toHaveBeenCalled();
    });

    it.each([[["https://host.tailnet.ts.net"]], [[]]])(
      "keeps the Tailscale URL when controlUi.allowedOrigins %j excludes the public origin",
      async (allowedOrigins) => {
        await expect(
          resolveTelegramMiniAppUrls({
            cfg: {
              gateway: {
                publicOrigin: "https://gateway.example.com",
                tailscale: { mode: "serve" },
                controlUi: { allowedOrigins },
              },
            },
            runCommand: tailnetStatus(),
          }),
        ).resolves.toEqual({
          pageUrl: "https://host.tailnet.ts.net/__openclaw_tg_miniapp/",
          controlUiUrl: "https://host.tailnet.ts.net",
          gatewayUrl: "wss://host.tailnet.ts.net",
        });
      },
    );

    it.each([[["https://host.tailnet.ts.net", " HTTPS://Gateway.Example.com "]], [["*"]]])(
      "uses gateway.publicOrigin when controlUi.allowedOrigins %j admits it",
      async (allowedOrigins) => {
        const runCommand = tailnetStatus();
        await expect(
          resolveTelegramMiniAppUrls({
            cfg: {
              gateway: {
                publicOrigin: "https://gateway.example.com",
                tailscale: { mode: "serve" },
                controlUi: { allowedOrigins },
              },
            },
            runCommand,
          }),
        ).resolves.toMatchObject({ gatewayUrl: "wss://gateway.example.com" });
        expect(runCommand).not.toHaveBeenCalled();
      },
    );

    it("names controlUi.allowedOrigins when the public origin is excluded and Tailscale is off", async () => {
      const failure = resolveTelegramMiniAppUrls({
        cfg: {
          gateway: {
            publicOrigin: "https://gateway.example.com",
            controlUi: { allowedOrigins: ["https://other.example.com"] },
          },
        },
      }).catch((err: unknown) => err);
      await expect(failure).resolves.toBeInstanceOf(TelegramMiniAppUrlError);
      // The command and auth route surface this text instead of the generic hint.
      expect(describeTelegramMiniAppUrlError(await failure)).toContain(
        "Add https://gateway.example.com to `gateway.controlUi.allowedOrigins`",
      );
      expect(describeTelegramMiniAppUrlError(new Error("boom"))).toBe(TELEGRAM_MINIAPP_URL_ERROR);
    });
  });
});
