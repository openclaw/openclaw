import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createCronScheduledToolProjection,
  readCronScheduledToolProjection,
} from "../exec-tool-target-pinning.js";
import type { AnyAgentTool } from "../tools/common.js";
import { normalizeAgentRuntimeTools } from "./tools.js";
import type { AgentRuntimePlan } from "./types.js";

vi.mock("../embedded-agent-runner/tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: vi.fn(),
  normalizeProviderToolSchemas: vi.fn(),
}));

function fixture() {
  let active = true;
  const execute = vi.fn(async () => ({ content: [], details: {} }));
  const source = {
    name: "exec",
    label: "Exec",
    description: "Exec",
    parameters: Type.Object({}),
    execute,
  } satisfies AnyAgentTool;
  const alias = createCronScheduledToolProjection(
    source,
    () => {
      if (!active) {
        throw new Error("host run closed");
      }
    },
    "exec",
    {
      kind: "exec",
      name: "gateway_exec",
      description: "Gateway exec",
      followupText: "Use gateway_process",
      ask: "always",
    },
  );
  return {
    alias,
    execute,
    close: () => {
      active = false;
    },
  };
}

function normalizeAlias(alias: AnyAgentTool, normalize: (tools: AnyAgentTool[]) => AnyAgentTool[]) {
  const [normalized] = normalizeAgentRuntimeTools({
    tools: [alias],
    provider: "fixture",
    runtimePlan: { tools: { normalize, logDiagnostics: vi.fn() } } as unknown as AgentRuntimePlan,
  });
  if (!normalized) {
    throw new Error("expected normalized alias");
  }
  return normalized;
}

it.each([false, true])(
  "retains projection through fenced normalization (cloned=%s)",
  async (cloned) => {
    const instance = new PluginInstance("normalizer-fixture");
    const { alias, execute, close } = fixture();
    const normalize = instance.wrap((tools: AnyAgentTool[]) =>
      cloned ? tools.map((tool) => ({ ...tool })) : tools,
    );
    try {
      const normalized = normalizeAlias(alias, normalize);
      expect(readCronScheduledToolProjection(normalized)).toEqual({
        targetTool: "exec",
        execTarget: { host: "gateway", ask: "always" },
      });
      await normalized.execute("current", { command: "echo safe", host: "node", ask: "off" });
      expect(execute).toHaveBeenCalledWith(
        "current",
        { command: "echo safe", host: "gateway", ask: "always" },
        undefined,
        undefined,
      );
      close();
      expect(() => readCronScheduledToolProjection(normalized)).toThrow("host run closed");
      await instance.dispose();
      expect(() => readCronScheduledToolProjection(normalized)).toThrow("reloaded or disabled");
      expect(() => normalized.execute("retired", {})).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  },
);

it.each(["replacement", "wrapped-replacement", "foreign-proxy"] as const)(
  "does not certify a %s executor",
  async (mode) => {
    const instance = new PluginInstance("normalizer-fixture");
    const { alias } = fixture();
    const replacement = async () => ({ content: [], details: {} });
    try {
      const execute =
        mode === "foreign-proxy" ? new Proxy(instance.wrap(alias.execute), {}) : replacement;
      const normalize = (tools: AnyAgentTool[]) => tools.map((tool) => ({ ...tool, execute }));
      const normalized = normalizeAlias(
        alias,
        mode === "wrapped-replacement" ? instance.wrap(normalize) : normalize,
      );
      expect(readCronScheduledToolProjection(normalized)).toBeUndefined();
    } finally {
      await instance.dispose();
    }
  },
);

it("retains nested admission and rejects subsequent executor replacement", async () => {
  const inner = new PluginInstance("inner-normalizer");
  const outer = new PluginInstance("outer-normalizer");
  const { alias } = fixture();
  try {
    const normalize = outer.wrap(
      inner.wrap((tools: AnyAgentTool[]) => tools.map((tool) => ({ ...tool }))),
    );
    const normalized = normalizeAlias(alias, normalize);
    expect(readCronScheduledToolProjection(normalized)?.targetTool).toBe("exec");
    const original = normalized.execute;
    normalized.execute = async () => ({ content: [], details: {} });
    expect(() => readCronScheduledToolProjection(normalized)).toThrow(
      "changed after host creation",
    );
    normalized.execute = original;
    await inner.dispose();
    expect(() => readCronScheduledToolProjection(normalized)).toThrow("reloaded or disabled");
  } finally {
    await inner.dispose();
    await outer.dispose();
  }
});

it("retains the exact registry view admission rather than the still-active instance", async () => {
  const instance = new PluginInstance("normalizer-fixture");
  let active = true;
  const wrap = instance.createRegistryView(createEmptyPluginRegistry(), (run) => {
    if (!active) {
      throw new Error("registry view retired");
    }
    return instance.run(run);
  });
  try {
    const { alias } = fixture();
    const normalized = normalizeAlias(
      alias,
      wrap((tools: AnyAgentTool[]) => tools.map((tool) => ({ ...tool }))),
    );
    expect(readCronScheduledToolProjection(normalized)?.targetTool).toBe("exec");
    active = false;
    expect(instance.acceptingCalls).toBe(true);
    expect(() => readCronScheduledToolProjection(normalized)).toThrow("registry view retired");
    expect(() => normalized.execute("retired-view", {})).toThrow("registry view retired");
  } finally {
    await instance.dispose();
  }
});
