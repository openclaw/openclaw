import { expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { recordSkillFileHost } from "../skills/skill-file-host.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { findSkillUsageMatch } from "./agent-tools.before-tool-call.diagnostics.js";
import {
  getBeforeToolCallPolicyDiagnosticState,
  hasBeforeToolCallPolicy,
} from "./agent-tools.before-tool-call.policy.js";

it("reports trusted policy diagnostics through guarded readers", () => {
  resetGlobalHookRunner();
  const registry = createEmptyPluginRegistry();
  let policyIdReads = 0;
  registry.trustedToolPolicies = [
    {
      pluginId: "fuzzplugin",
      pluginName: "Fuzz Plugin",
      source: "test",
      policy: {
        description: "synthetic trusted policy",
        evaluate: () => undefined,
        get id(): string {
          policyIdReads += 1;
          throw new Error("fuzzplugin trusted policy id is unreadable");
        },
      },
    },
    {
      pluginId: "mockplugin",
      pluginName: "Mock Plugin",
      source: "test",
      policy: {
        id: "mockpolicy",
        description: "mock policy",
        evaluate: () => undefined,
      },
    },
  ];
  setActivePluginRegistry(registry);

  try {
    expect(hasBeforeToolCallPolicy()).toBe(true);
    expect(policyIdReads).toBe(0);
    expect(getBeforeToolCallPolicyDiagnosticState()).toEqual({
      hasBeforeToolCallHook: false,
      trustedToolPolicies: [
        { id: "fuzzplugin", pluginId: "fuzzplugin", pluginName: "Fuzz Plugin" },
        { id: "mockpolicy", pluginId: "mockplugin", pluginName: "Mock Plugin" },
      ],
    });
  } finally {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
  }
});

it("attributes colliding physical and virtual Skill reads to their source hosts", () => {
  const filePath = "/project/skills/guide/SKILL.md";
  const local = createCanonicalFixtureSkill({
    name: "gateway-guide",
    description: "Gateway",
    filePath,
    baseDir: "/project/skills/guide",
    source: "workspace",
  });
  const remote = recordSkillFileHost(
    {
      ...createCanonicalFixtureSkill({
        name: "node-guide",
        description: "Node",
        filePath,
        baseDir: "/project/skills/guide",
        source: "openclaw-node",
      }),
    },
    "workspace",
  );
  const skillsSnapshot = { prompt: "", skills: [], resolvedSkills: [local, remote] };

  expect(
    findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: filePath },
      ctx: { skillsSnapshot },
    }),
  ).toMatchObject({ skillName: "gateway-guide" });
  expect(
    findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: "workspace-skill://workspace/node-guide/SKILL.md" },
      ctx: { skillsSnapshot },
    }),
  ).toMatchObject({ skillName: "node-guide" });
});

it("normalizes a requested skill name once while searching the discovery inventory", () => {
  const requestedName = "  inventory-lookup-target  ";
  const target = createCanonicalFixtureSkill({
    name: "inventory-lookup-target",
    description: "Lookup target",
    filePath: "/project/skills/target/SKILL.md",
    baseDir: "/project/skills/target",
    source: "workspace",
  });
  const discoverySkills = [
    { ...target, disableModelInvocation: true },
    ...Array.from({ length: 40 }, (_, index) => ({ ...target, name: `other-skill-${index}` })),
    target,
  ];
  let requestedNameTrims = 0;
  const trimSpy = vi.spyOn(String.prototype, "trim");
  try {
    expect(
      findSkillUsageMatch({
        toolName: "skills_read",
        toolParams: { name: requestedName },
        ctx: { skillsSnapshot: { prompt: "", skills: [], discoverySkills } },
      }),
    ).toEqual({
      skillName: "inventory-lookup-target",
      skillSource: "workspace",
      activation: "read",
      skillFile: "/project/skills/target/SKILL.md",
    });
    requestedNameTrims = trimSpy.mock.contexts.filter((value) => value === requestedName).length;
  } finally {
    trimSpy.mockRestore();
  }
  expect(requestedNameTrims).toBe(1);
});
