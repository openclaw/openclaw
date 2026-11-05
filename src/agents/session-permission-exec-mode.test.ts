import { describe, expect, it } from "vitest";
import { resolveModelExecCeiling } from "./lazy-exec-tool.js";
import {
  projectEffectiveExecPolicy,
  SESSION_PERMISSION_BY_EXEC_MODE,
} from "./session-permission-exec-mode.js";

describe("session permission modes for exec policies", () => {
  it.each([
    ["deny", "read-only"],
    ["allowlist", "guarded"],
    ["ask", "guarded"],
    ["auto", "workspace"],
    ["full", "full"],
  ] as const)("maps %s to %s", (execMode, permissionMode) => {
    expect(SESSION_PERMISSION_BY_EXEC_MODE[execMode]).toBe(permissionMode);
  });
});

describe("model exec ceiling", () => {
  it.each([
    ["full config is capped to auto", { mode: "full" }, "auto", "auto", "allowlist", "on-miss"],
    ["unset config ranks as full", {}, "deny", "deny", "deny", "off"],
    [
      "stricter ask is kept over auto",
      { mode: "ask", security: "allowlist", ask: "on-miss" },
      "auto",
      "ask",
      "allowlist",
      "on-miss",
    ],
    [
      "stricter allowlist is kept",
      { mode: "allowlist", security: "allowlist", ask: "off" },
      "auto",
      "allowlist",
      "allowlist",
      "off",
    ],
    [
      "legacy full/on-miss is capped",
      { security: "full", ask: "on-miss" },
      "ask",
      "ask",
      "allowlist",
      "on-miss",
    ],
  ] as const)("%s", (_name, base, ceiling, mode, security, ask) => {
    expect(projectEffectiveExecPolicy({ base, modelExecCeiling: ceiling })).toMatchObject({
      mode,
      security,
      ask,
    });
  });

  it("caps per-run overrides and full sessions without host-floor bypass", () => {
    expect(
      projectEffectiveExecPolicy({
        base: { mode: "ask" },
        overrides: { mode: "full" },
        modelExecCeiling: "auto",
      }),
    ).toMatchObject({ mode: "auto", security: "allowlist" });
    expect(
      projectEffectiveExecPolicy({
        base: {},
        permissionPolicy: { mode: "full" },
        modelExecCeiling: "auto",
      }),
    ).toMatchObject({ mode: "auto", security: "allowlist", bypassHostApprovalFloors: false });
  });

  it("matches provider/model keys and lets the stricter global or agent entry win", () => {
    const cfg = {
      tools: { byProvider: { "local-llm/small": { exec: { mode: "auto" } } } },
      agents: {
        entries: { helper: { tools: { byProvider: { "local-llm": { exec: { mode: "deny" } } } } } },
      },
    } as const;
    const ceiling = (agentId: string, modelId: string) =>
      resolveModelExecCeiling({ cfg, agentId, modelProvider: "local-llm", modelId });
    expect(ceiling("main", "small")).toBe("auto");
    expect(ceiling("main", "large")).toBeUndefined();
    expect(ceiling("helper", "small")).toBe("deny");
    expect(
      resolveModelExecCeiling({ cfg, agentId: "main", modelProvider: "anthropic", modelId: "x" }),
    ).toBeUndefined();
  });
});
