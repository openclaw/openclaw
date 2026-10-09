import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramMiniAppUrls, TELEGRAM_MINIAPP_URL_ERROR } from "./url.js";

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
});
