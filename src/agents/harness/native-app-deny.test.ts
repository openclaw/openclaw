import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectHarnessDeniedNativeAppPatterns,
  harnessNativeAppDenyOverlapsMcpServer,
  isHarnessNativeAppDenyPattern,
  normalizeHarnessNativeAppDenyPrefix,
  resolveHarnessNativeAppDenyReservedNamespaces,
} from "./native-app-deny.js";

const prefix = "mcp__codex_apps__";

describe("isHarnessNativeAppDenyPattern", () => {
  it("accepts whole-app and deny-all patterns in the namespace", () => {
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__gamma_*", prefix)).toBe(true);
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__*", prefix)).toBe(true);
  });

  it("rejects exact names, nested wildcards, and other namespaces", () => {
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__gamma_send", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__*_send_*", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("mcp__codex_apps__gamma_?*", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("mcp__other__*", prefix)).toBe(false);
    expect(isHarnessNativeAppDenyPattern("gamma-mail__*", prefix)).toBe(false);
  });
});

describe("collectHarnessDeniedNativeAppPatterns", () => {
  it("collects normalized patterns across policies, sorted and unique", () => {
    expect(
      collectHarnessDeniedNativeAppPatterns(
        [
          { deny: ["MCP__codex_apps__Gamma_*", "exec"] },
          undefined,
          { deny: ["mcp__codex_apps__gamma_*", "mcp__codex_apps__epsilon_*"] },
        ],
        normalizeHarnessNativeAppDenyPrefix(" MCP__codex_apps__ "),
      ),
    ).toEqual(["mcp__codex_apps__epsilon_*", "mcp__codex_apps__gamma_*"]);
  });

  it("returns nothing without a prefix or without matching denies", () => {
    expect(
      collectHarnessDeniedNativeAppPatterns([{ deny: ["mcp__codex_apps__x_*"] }], undefined),
    ).toEqual([]);
    expect(collectHarnessDeniedNativeAppPatterns([{ deny: ["alpha__*", "*"] }], prefix)).toEqual(
      [],
    );
    expect(normalizeHarnessNativeAppDenyPrefix("  ")).toBeUndefined();
  });
});

describe("resolveHarnessNativeAppDenyReservedNamespaces", () => {
  it("maps configured static servers to their model-facing namespaces", () => {
    const config = {
      mcp: {
        servers: {
          alpha: { url: "https://alpha.example/mcp", transport: "streamable-http" },
          "Codex-Apps": { url: "https://apps.example/mcp", transport: "streamable-http" },
          mcp__codex_apps__gamma: {
            url: "https://gamma.example/mcp",
            transport: "streamable-http",
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(resolveHarnessNativeAppDenyReservedNamespaces(config, prefix)).toEqual([
      "mcp__alpha__",
      "mcp__codex_apps__",
      "mcp__codex_apps__gamma__",
    ]);
    expect(resolveHarnessNativeAppDenyReservedNamespaces(config, undefined)).toEqual([]);
    expect(resolveHarnessNativeAppDenyReservedNamespaces(undefined, prefix)).toEqual([]);
  });
});

describe("harnessNativeAppDenyOverlapsMcpServer", () => {
  it("flags patterns that could reach a configured server's tools", () => {
    expect(
      harnessNativeAppDenyOverlapsMcpServer("mcp__codex_apps__gamma_*", ["mcp__codex_apps__"]),
    ).toBe(true);
    expect(harnessNativeAppDenyOverlapsMcpServer("mcp__codex_apps__*", ["mcp__codex_apps__"])).toBe(
      true,
    );
    expect(
      harnessNativeAppDenyOverlapsMcpServer("mcp__codex_apps__gamma_*", [
        "mcp__codex_apps__gamma__",
      ]),
    ).toBe(true);
    expect(
      harnessNativeAppDenyOverlapsMcpServer("mcp__codex_apps__gamma_*", ["mcp__alpha__"]),
    ).toBe(false);
    expect(
      harnessNativeAppDenyOverlapsMcpServer("mcp__codex_apps__gamma_*", ["mcp__codex_apps_x__"]),
    ).toBe(false);
    expect(harnessNativeAppDenyOverlapsMcpServer("mcp__codex_apps__gamma_*", [])).toBe(false);
  });
});
