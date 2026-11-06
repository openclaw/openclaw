import { describe, expect, it } from "vitest";
import { type ExecMode, resolveExecPolicyForMode } from "../infra/exec-approvals-core.js";
import { resolveModelExecCeilings } from "./lazy-exec-tool.js";
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
  const project = (base: object, ceilings: ExecMode[], extra = {}) =>
    projectEffectiveExecPolicy({ base, modelExecCeilings: ceilings, ...extra });
  it.each([
    [exact("full"), ["auto"], exact("auto")],
    [{}, ["deny"], exact("deny")],
    [exact("ask"), ["auto"], exact("ask")],
    [exact("auto"), ["ask"], exact("ask")],
    [exact("allowlist"), ["auto"], exact("allowlist")],
    [exact("full"), ["auto", "allowlist"], exact("allowlist")],
    [{ security: "full", ask: "on-miss" }, ["ask"], exact("ask")],
    // Mandatory approval survives: no canonical mode may erase ask=always.
    [{ ask: "always" }, ["auto"], { mode: undefined, security: "allowlist", ask: "always" }],
    [
      { security: "allowlist", ask: "always" },
      ["allowlist"],
      { mode: undefined, security: "allowlist", ask: "always" },
    ],
  ] as const)("caps %j with %j", (base, ceilings, expected) => {
    expect(project(base, [...ceilings])).toMatchObject(expected);
  });

  it("caps per-run overrides and full sessions without host-floor bypass", () => {
    expect(project({ mode: "ask" }, ["auto"], { overrides: { mode: "full" } })).toMatchObject(
      exact("auto"),
    );
    expect(project({}, ["auto"], { permissionPolicy: { mode: "full" } })).toMatchObject({
      ...exact("auto"),
      bypassHostApprovalFloors: false,
    });
  });

  it("matches provider/model keys and binds both global and agent entries", () => {
    const cfg = {
      tools: { byProvider: { "local-llm/small": { exec: { mode: "auto" } } } },
      agents: {
        entries: { helper: { tools: { byProvider: { "local-llm": { exec: { mode: "deny" } } } } } },
      },
    } as const;
    const ceilings = (agentId: string, modelProvider: string, modelId: string) =>
      resolveModelExecCeilings({ cfg, agentId, modelProvider, modelId });
    expect(ceilings("main", "local-llm", "small")).toEqual(["auto"]);
    expect(ceilings("main", "local-llm", "large")).toEqual([]);
    expect(ceilings("helper", "local-llm", "small")).toEqual(["auto", "deny"]);
    expect(ceilings("main", "anthropic", "small")).toEqual([]);
  });
});
