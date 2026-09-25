import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createInheritedToolPolicyMatcher } from "./inherited-tool-policy.js";
import {
  parseInheritedToolPolicyV2,
  type InheritedToolPolicyV2,
} from "./inherited-tool-policy.schema.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { attachToolAllowlistIntersection } from "./tool-policy.js";

export function registerCodingToolsDelegationTests({
  testConfig,
  latestCreateOpenClawToolsOptions,
  captureLatestDelegationPolicy,
  expectListIncludes,
}: {
  testConfig: OpenClawConfig;
  latestCreateOpenClawToolsOptions: () => NonNullable<Parameters<typeof createOpenClawTools>[0]>;
  captureLatestDelegationPolicy: () => Promise<InheritedToolPolicyV2>;
  expectListIncludes: (list: readonly string[] | undefined, expected: readonly string[]) => void;
}): void {
  it("does not inherit native-harness bridge runtime allowlists", async () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist: ["sessions_spawn", "memory_search"],
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    expect(latestCreateOpenClawToolsOptions().pluginToolAllowlist).toEqual([
      "sessions_spawn",
      "memory_search",
    ]);
    const policy = await captureLatestDelegationPolicy();
    expect(policy).toBeDefined();
    expect(
      createInheritedToolPolicyMatcher({ policy: parseInheritedToolPolicyV2(policy) })({
        name: "exec",
      }),
    ).toBe(true);
  });

  it("inherits embedded runtime toolsAllow when explicitly marked as parent capability", async () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const runtimeToolAllowlist = ["sessions_spawn", "memory_search"];

    createOpenClawCodingTools({
      config: testConfig,
      runtimeToolAllowlist,
      conversationCapabilityProfile: resolveConversationCapabilityProfile({
        config: testConfig,
        runtimeToolAllowlist,
        inheritRuntimeToolAllowlist: true,
      }),
    });

    expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
    const policy = parseInheritedToolPolicyV2(await captureLatestDelegationPolicy());
    const allowed = createInheritedToolPolicyMatcher({ policy });
    expect(allowed({ name: "sessions_spawn" })).toBe(true);
    expect(allowed({ name: "read" })).toBe(false);
    expect(allowed({ name: "exec" })).toBe(false);
  });

  it.each([
    {
      label: "explicit tools",
      toolsAllow: ["sessions_spawn", "read"],
      expected: ["sessions_spawn", "read"],
    },
    {
      label: "overlapping globs",
      toolsAllow: attachToolAllowlistIntersection([], [["sessions_*"], ["*_spawn"]]),
      expected: ["sessions_spawn"],
    },
  ])(
    "lets direct callers inherit $label into subagent spawns",
    async ({ toolsAllow, expected }) => {
      const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
      createOpenClawToolsMock.mockClear();

      createOpenClawCodingTools({
        config: testConfig,
        runtimeToolAllowlist: toolsAllow,
        inheritRuntimeToolAllowlist: true,
      });

      expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
      const policy = parseInheritedToolPolicyV2(await captureLatestDelegationPolicy());
      const allowed = createInheritedToolPolicyMatcher({ policy });
      expect(expected.every((name) => allowed({ name }))).toBe(true);
      expect(allowed({ name: "exec" })).toBe(false);
    },
  );

  it("keeps restricted spawn inheritance in the caller-owned runtime snapshot", async () => {
    const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
    createOpenClawToolsMock.mockClear();
    const inheritedToolAllowlistRef: string[] = [];

    createOpenClawCodingTools({
      config: { tools: { allow: ["read", "sessions_spawn"] } },
      inheritedToolAllowlistRef,
    });

    const policy = parseInheritedToolPolicyV2(await captureLatestDelegationPolicy());
    expect(createInheritedToolPolicyMatcher({ policy })({ name: "exec" })).toBe(false);
    expectListIncludes(inheritedToolAllowlistRef, ["read", "sessions_spawn"]);
    expect(inheritedToolAllowlistRef).not.toContain("exec");
  });

  it("does not snapshot additive alsoAllow policies for spawn inheritance", async () => {
    const inheritedToolAllowlistRef: string[] = [];

    createOpenClawCodingTools({
      config: { tools: { alsoAllow: ["read"], deny: ["exec"] } },
      inheritedToolAllowlistRef,
    });

    expect(inheritedToolAllowlistRef).toEqual([]);
    const policy = parseInheritedToolPolicyV2(await captureLatestDelegationPolicy());
    const allowed = createInheritedToolPolicyMatcher({ policy });
    expect(allowed({ name: "exec" })).toBe(false);
    expect(allowed({ name: "later_plugin_tool" })).toBe(true);
  });

  it("retains configured grants when a permitted tool is unavailable during parent preparation", async () => {
    const config = {
      tools: { allow: ["read", "sessions_spawn", "later_plugin_tool"], deny: ["exec"] },
    };
    const tools = createOpenClawCodingTools({ config });
    expect(tools.some((tool) => tool.name === "later_plugin_tool")).toBe(false);
    const encodedPolicy = JSON.stringify(await captureLatestDelegationPolicy());
    const saved = JSON.parse(encodedPolicy);
    config.tools.allow.splice(0);
    const allows = createInheritedToolPolicyMatcher({ policy: parseInheritedToolPolicyV2(saved) });
    expect(allows({ name: "later_plugin_tool" })).toBe(true);
    expect(allows({ name: "write" })).toBe(false);
    expect(allows({ name: "exec" })).toBe(false);
  });
}
