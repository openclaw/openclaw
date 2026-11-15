import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { clickClackPlugin, parseClickClackTarget } from "../api.js";

describe("ClickClack channel capabilities", () => {
  it("inspects configured accounts and routing policy without reading credential files", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example.test",
          workspace: "synthetic-workspace",
          tokenFile: "/unavailable/synthetic-clickclack-token",
          accounts: { disabled: { enabled: false } },
        },
      },
    };
    const probes = (
      [
        "accessSync",
        "openSync",
        "readFileSync",
        "statSync",
        "lstatSync",
        "readdirSync",
        "realpathSync",
      ] as const
    ).map((name) => vi.spyOn(fs, name));
    try {
      for (const accountId of ["default", "disabled"]) {
        const account = clickClackPlugin.config.inspectAccount
          ? clickClackPlugin.config.inspectAccount(cfg, accountId)
          : clickClackPlugin.config.resolveAccount(cfg, accountId);
        expect(account).toMatchObject({
          configured: true,
          enabled: accountId === "default",
          tokenSource: "tokenFile",
        });
        expect(clickClackPlugin.config.resolveAllowFrom?.({ cfg, accountId })).toEqual(["*"]);
        expect(clickClackPlugin.config.resolveDefaultTo?.({ cfg, accountId })).toBe(
          "channel:general",
        );
      }
      for (const probe of probes) {
        expect(probe).not.toHaveBeenCalled();
      }
    } finally {
      for (const probe of probes) {
        probe.mockRestore();
      }
    }
  });

  it("parses channel targets", () => {
    expect(parseClickClackTarget("channel:general")).toEqual({
      chatType: "group",
      kind: "channel",
      id: "general",
    });
    expect(clickClackPlugin.messaging?.normalizeTarget?.("general")).toBe("channel:general");
  });

  it("advertises media delivery through the public plugin descriptor", () => {
    expect(clickClackPlugin.capabilities).toEqual({
      chatTypes: ["direct", "group"],
      threads: true,
      media: true,
      blockStreaming: true,
    });
  });

  it("projects credential source and status without exposing tokens or diagnostics", async () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          tokenFile: "/private/clickclack-unavailable-token",
        },
      },
    };
    const account = clickClackPlugin.config.resolveAccount(cfg, "default");
    const snapshot = await clickClackPlugin.status?.buildAccountSnapshot?.({ account, cfg });

    expect(snapshot).toMatchObject({
      configured: true,
      tokenSource: "tokenFile",
      tokenStatus: "configured_unavailable",
    });
    expect(snapshot).not.toHaveProperty("token");
    expect(snapshot).not.toHaveProperty("credentialDiagnostics");
  });
});
