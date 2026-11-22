import path from "node:path";
import { expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { prepareSkillReadIndex } from "../skills/runtime/skill-read-index.js";
import { recordSkillFileHost, resolveSkillFileHost } from "../skills/skill-file-host.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import {
  isWorkspaceSkillReadPath,
  resolveSkillReadPath,
} from "../skills/workspace-skill-read-path.js";
import {
  findSkillUsageMatch,
  resolvedSkillUsageMatch,
} from "./agent-tools.before-tool-call.diagnostics.js";
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

it("preserves scan precedence and telemetry across randomized skill snapshots and read paths", () => {
  let seed = 2676;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * limit);
  };
  for (let trial = 0; trial < 80; trial++) {
    const resolvedSkills = Array.from({ length: 40 }, () => {
      const id = random(10);
      const baseDir = ["", `/synthetic/guide-${id}`, `relative/guide-${id}`][random(3)]!;
      const filePath = ["", `${baseDir}/SKILL.md`, `node://synthetic/guide-${id}/SKILL.md`][
        random(3)
      ]!;
      return {
        ...createCanonicalFixtureSkill({
          name: `guide-${random(8)}`,
          description: "Synthetic",
          baseDir,
          filePath,
          source: ["bundled", "workspace", "unknown"][random(3)]!,
        }),
        name: random(9) === 0 ? " " : `guide-${random(8)}${random(2) ? "  " : ""}`,
        baseDir: baseDir + (random(2) ? "  " : ""),
        filePath: filePath + (random(2) ? "  " : ""),
        fileHost: ([undefined, "gateway", "workspace"] as const)[random(3)],
      };
    });
    const snapshot = { prompt: "", skills: [], resolvedSkills };
    const candidates = new Set(["/synthetic/miss", "node://synthetic/miss/SKILL.md"]);
    for (const skill of resolvedSkills) {
      candidates.add(resolveSkillReadPath(skill).trim());
      candidates.add(skill.filePath.trim());
      candidates.add(path.resolve(skill.baseDir.trim(), "SKILL.md"));
    }
    for (const input of candidates) {
      const candidate =
        input.startsWith("node://") || isWorkspaceSkillReadPath(input)
          ? input
          : path.resolve("/synthetic", input);
      // Frozen pre-index predicate: the differential oracle is intentionally the old algorithm.
      const skill =
        input &&
        resolvedSkills.findLast((entry) => {
          if (typeof entry.name !== "string" || !entry.name.trim()) {
            return false;
          }
          const filePath = typeof entry.filePath === "string" ? entry.filePath.trim() : "";
          const baseDir = typeof entry.baseDir === "string" ? entry.baseDir.trim() : "";
          if (filePath && resolveSkillReadPath(entry) === candidate) {
            return true;
          }
          if (resolveSkillFileHost(entry) === "workspace") {
            return false;
          }
          return Boolean(
            (filePath &&
              (filePath.startsWith("node://")
                ? filePath === candidate
                : path.isAbsolute(filePath) && path.resolve(filePath) === candidate)) ||
            (baseDir &&
              path.isAbsolute(baseDir) &&
              path.resolve(baseDir, "SKILL.md") === candidate),
          );
        });
      expect(
        findSkillUsageMatch({
          toolName: "read",
          toolParams: { path: input },
          ctx: { skillsSnapshot: snapshot, workspaceDir: "/synthetic" },
        }),
      ).toEqual(skill ? resolvedSkillUsageMatch({ activation: "read", skill }) : undefined);
    }
  }
});

it("prepares aliases once and rebuilds them when a snapshot remaps its skills", () => {
  const skill = createCanonicalFixtureSkill({
    name: "guide",
    description: "Synthetic",
    baseDir: "/synthetic/source",
    filePath: "/synthetic/source/SKILL.md",
    source: "workspace",
  });
  const snapshot = { prompt: "", skills: [], resolvedSkills: [skill] };
  prepareSkillReadIndex(snapshot);
  const resolveSpy = vi.spyOn(path, "resolve");
  try {
    for (let i = 0; i < 10; i++) {
      expect(
        findSkillUsageMatch({
          toolName: "read",
          toolParams: { path: "/synthetic/miss" },
          ctx: { skillsSnapshot: snapshot },
        }),
      ).toBeUndefined();
    }
    // Only each untrusted tool argument is resolved; no selected skill path is revisited.
    expect(resolveSpy.mock.calls).toEqual(Array.from({ length: 10 }, () => ["/synthetic/miss"]));
  } finally {
    resolveSpy.mockRestore();
  }
  const remapped = {
    ...snapshot,
    resolvedSkills: [
      { ...skill, filePath: "node://synthetic/guide/SKILL.md", baseDir: "relative" },
    ],
  };
  expect(
    findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: skill.filePath },
      ctx: { skillsSnapshot: remapped },
    }),
  ).toBeUndefined();
  expect(
    findSkillUsageMatch({
      toolName: "read",
      toolParams: { path: remapped.resolvedSkills[0]!.filePath },
      ctx: { skillsSnapshot: remapped },
    }),
  ).toEqual({ skillName: "guide", skillSource: "workspace", activation: "read" });
  expect(JSON.stringify(snapshot)).toBe(JSON.stringify({ ...snapshot }));
});
