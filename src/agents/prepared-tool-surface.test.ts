import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { prepareCoreToolPolicy, projectAgentToolDefinition } from "./prepared-tool-surface.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type PolicyCase = {
  options: Parameters<typeof prepareCoreToolPolicy>[0];
  expected: Partial<ReturnType<typeof prepareCoreToolPolicy>>;
  exact?: true;
};

describe("prepared core tool policy", () => {
  it.each<PolicyCase>([
    ...(
      [
        { mode: undefined, required: false, memory: false, workspaceOnly: true, readOnly: false },
        { mode: "full", required: false, memory: false, workspaceOnly: false, readOnly: false },
        { mode: "full", required: true, memory: false, workspaceOnly: true, readOnly: false },
        { mode: "full", required: false, memory: true, workspaceOnly: true, readOnly: false },
        { mode: "read-only", required: false, memory: false, workspaceOnly: true, readOnly: true },
      ] as const
    ).map<PolicyCase>(({ mode, required, memory, workspaceOnly, readOnly }) => ({
      options: {
        config: { tools: { fs: { workspaceOnly: true } } },
        sessionPermissionPolicy: mode ? { root: "/workspace", mode } : undefined,
        requireWorkspaceOnly: required || undefined,
        trigger: memory ? "memory" : "user",
      },
      expected: {
        workspaceOnly,
        readOnly,
        applyPatchEnabled: !readOnly,
        applyPatchContainmentSource: required ? "required-root" : mode ? "session" : "config",
      },
    })),
    ...[
      { allowModels: [" OPENAI/model-a "], modelId: "model-a", expected: true },
      { allowModels: ["model-a"], modelId: "model-a", expected: true },
      { allowModels: ["openai/model-a"], modelId: "openai/model-a", expected: true },
      { allowModels: ["model-b"], modelId: "model-a", expected: false },
      { allowModels: ["model-a"], modelId: undefined, expected: false },
    ].map<PolicyCase>(({ allowModels, modelId, expected }) => ({
      options: {
        config: { tools: { exec: { applyPatch: { allowModels } } } },
        modelProvider: "openai",
        modelId,
      },
      expected: { applyPatchEnabled: expected },
    })),
    {
      options: {
        config: { agents: { defaults: { imageMaxDimensionPx: 800 } } },
        modelContextWindowTokens: 32000,
        modelHasVision: false,
      },
      expected: {
        workspaceOnly: false,
        readOnly: false,
        applyPatchEnabled: true,
        applyPatchWorkspaceOnly: true,
        applyPatchContainmentSource: "config",
        imageSanitization: { maxDimensionPx: 800 },
        modelContextWindowTokens: 32000,
        modelHasVision: false,
      },
      exact: true,
    },
  ])("resolves session, model, and transport policy (%#)", ({ options, expected, exact }) => {
    const policy = prepareCoreToolPolicy(options);
    if (exact) {
      expect(policy).toEqual(expected);
    } else {
      expect(policy).toMatchObject(expected);
    }
  });

  it.each([
    { tools: { fs: { workspaceOnly: true }, exec: { applyPatch: { enabled: false } } } },
    {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        list: [
          {
            id: "restricted",
            tools: {
              fs: { workspaceOnly: true },
              exec: { applyPatch: { allowModels: ["other-model"] } },
            },
          },
        ],
      },
    },
  ] satisfies OpenClawConfig[])(
    "enforces configured containment after policy transport (%#)",
    async (config) => {
      const parent = await fs.realpath(tempDirs.make("prepared-tool-policy-"));
      const root = path.join(parent, "workspace");
      const outside = path.join(parent, "outside.txt");
      await fs.mkdir(root);
      await fs.writeFile(outside, "unchanged");
      const policy = structuredClone(
        prepareCoreToolPolicy({ config, agentId: "restricted", modelId: "model-a" }),
      );
      const tools = createCoreCodingTools({
        ...policy,
        codingRoot: root,
        containmentRoot: root,
        includeBaseCodingTools: true,
        shellTools: "patch-only",
        execDefaults: {},
        processDefaults: {},
      });
      expect(tools.map((tool) => tool.name)).not.toContain("apply_patch");
      for (const name of ["read", "write"]) {
        const tool = tools.find((candidate) => candidate.name === name)!;
        await expect(
          tool.execute(`${name}-outside`, { path: outside, content: "changed" }),
        ).rejects.toThrow(/escapes sandbox root/);
      }
      await expect(fs.readFile(outside, "utf8")).resolves.toBe("unchanged");
      const write = tools.find((tool) => tool.name === "write")!;
      await write.execute("write-inside", { path: "inside.txt", content: "permitted" });
      await expect(fs.readFile(path.join(root, "inside.txt"), "utf8")).resolves.toBe("permitted");
    },
  );
});

it("issues byte-identical definitions to the local session adapter", () => {
  const tools = finalizeAgentTools({
    tools: [
      {
        name: "sample",
        label: "Sample",
        description: "A canonical tool.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        hideFromChannelProgress: true,
        executionMode: "sequential",
        execute: async () => ({ content: [], details: {} }),
      },
    ],
    modelProvider: "openai",
    hookContext: {},
    wrapBeforeToolCallHook: false,
  });
  const local = toToolDefinitions(tools);
  const placed = tools.map(projectAgentToolDefinition);
  expect(JSON.stringify(placed)).toBe(JSON.stringify(local));
  expect(placed[0]?.executionMode).toBe("sequential");
  expect(placed[0]?.hideFromChannelProgress).toBe(true);
  expect(Object.keys(placed[0]!)).not.toContain("execute");
});
