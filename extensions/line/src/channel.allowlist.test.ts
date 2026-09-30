import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

const allowlist = linePlugin.allowlist;

describe("line allowlist adapter", () => {
  it("reads dm/group allowlists and group overrides from line config", () => {
    const cfg = {
      channels: {
        line: {
          enabled: true,
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: ["Ualice"],
          groupAllowFrom: ["Ubob"],
          groups: {
            Cgroup1: { allowFrom: ["Ucarol"] },
          },
        },
      },
    } as OpenClawConfig;

    expect(allowlist?.readConfig?.({ cfg, accountId: "default" })).toEqual({
      dmAllowFrom: ["Ualice"],
      groupAllowFrom: ["Ubob"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "Cgroup1", entries: ["Ucarol"] }],
    });
  });

  it("treats a line:-prefixed entry as already present via the line normalizer", () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { line: { allowFrom: ["Ufrank"] } },
    };
    const result = allowlist?.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "dm",
      action: "add",
      entry: "line:user:Ufrank",
    });

    expect(result).toMatchObject({ kind: "ok", changed: false });
    expect(parsedConfig).toMatchObject({ channels: { line: { allowFrom: ["Ufrank"] } } });
  });
});
