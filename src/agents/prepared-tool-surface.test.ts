import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { prepareCoreToolPolicy, projectAgentToolDefinition } from "./prepared-tool-surface.js";
import { fakeTool } from "./test-helpers/fake-tool.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
describe("prepared core tool policy", () => {
  it.each([
    [undefined, false, false, true, false],
    ["full", false, false, false, false],
    ["full", true, false, true, false],
    ["full", false, true, true, false],
    ["read-only", false, false, true, true],
  ] as const)("resolves session policy (%#)", (mode, required, memory, workspaceOnly, readOnly) => {
    expect(
      prepareCoreToolPolicy({
        config: { tools: { fs: { workspaceOnly: true } } },
        sessionPermissionPolicy: mode ? { root: "/workspace", mode } : undefined,
        requireWorkspaceOnly: required || undefined,
        trigger: memory ? "memory" : "user",
      }),
    ).toMatchObject({
      workspaceOnly,
      readOnly,
      applyPatchEnabled: !readOnly,
      applyPatchContainmentSource: required ? "required-root" : mode ? "session" : "config",
    });
  });

  it.each([
    [" OPENAI/model-a ", "model-a", true],
    ["openai/model-a", "openai/model-a", true],
    ["model-b", "model-a", false],
    ["model-a", undefined, false],
  ] as const)("checks patch model allowlist (%#)", (allowed, modelId, applyPatchEnabled) => {
    expect(
      prepareCoreToolPolicy({
        config: {
          tools: { exec: { applyPatch: { allowModels: [allowed] } } },
          agents: { defaults: { imageMaxDimensionPx: 800 } },
        },
        modelProvider: "openai",
        modelId,
        modelContextWindowTokens: 32000,
        modelHasVision: false,
      }),
    ).toMatchObject({
      applyPatchEnabled,
      applyPatchWorkspaceOnly: false,
      imageSanitization: { maxDimensionPx: 800 },
      modelContextWindowTokens: 32000,
      modelHasVision: false,
    });
  });

  it.each([false, true])(
    "enforces configured containment after policy transport (%#)",
    async (agentScoped) => {
      const restrictions = {
        fs: { workspaceOnly: true },
        exec: { applyPatch: agentScoped ? { allowModels: ["other-model"] } : { enabled: false } },
      };
      const config: OpenClawConfig = agentScoped
        ? {
            tools: { fs: { workspaceOnly: false } },
            agents: { entries: { restricted: { tools: restrictions } } },
          }
        : { tools: restrictions };
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
        ...fakeTool("sample", "A canonical tool."),
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        hideFromChannelProgress: true,
        executionMode: "sequential",
      },
    ],
    modelProvider: "openai",
    hookContext: {},
    wrapBeforeToolCallHook: false,
  });
  const local = toToolDefinitions(tools);
  const placed = tools.map(projectAgentToolDefinition);
  expect(JSON.stringify(placed)).toBe(JSON.stringify(local));
  expect(placed[0]).toMatchObject({ executionMode: "sequential", hideFromChannelProgress: true });
  expect(Object.keys(placed[0]!)).not.toContain("execute");
});
