import { describe, expect, it } from "vitest";
import { type ExecMode, resolveExecPolicyForMode } from "../infra/exec-approvals-core.js";
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
  const exact = (mode: ExecMode) => {
    const { security, ask } = resolveExecPolicyForMode(mode);
    return { mode, security, ask };
  };
  it.each([
    [{ mode: "full" }, "auto", "auto"],
    [{}, "deny", "deny"],
    [exact("ask"), "auto", "ask"],
    [exact("allowlist"), "auto", "allowlist"],
    [{ security: "full", ask: "on-miss" }, "ask", "ask"],
  ] as const)("caps %j at %s to %s", (base, ceiling, mode) => {
    expect(projectEffectiveExecPolicy({ base, modelExecCeiling: ceiling })).toMatchObject(
      exact(mode),
    );
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
