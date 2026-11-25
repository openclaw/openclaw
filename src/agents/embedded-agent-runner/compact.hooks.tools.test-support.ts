import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { createOpenClawCodingToolsInternal } from "../agent-tools.js";
import { expectRecordFields } from "./compact.hooks.assertions.test-support.js";

function createMockToolDefinitions(tools: unknown[] = []) {
  return tools.map((tool) => {
    const source = tool && typeof tool === "object" ? (tool as Record<string, unknown>) : {};
    const name = typeof source.name === "string" && source.name.length > 0 ? source.name : "tool";
    return {
      name,
      label: source.label ?? name,
      description: source.description ?? "",
      parameters: source.parameters,
      execute: source.execute ?? vi.fn(),
    };
  });
}

export function mockCompactHooksTools(createTools: typeof createOpenClawCodingToolsInternal) {
  // mock-isolation: Supply fixture tools without constructing the full runtime surface.
  vi.doMock("../agent-tools.async.js", () => ({
    createOpenClawCodingToolsInternalAsync: async (...args: Parameters<typeof createTools>) =>
      createTools(...args),
  }));

  vi.doMock("./tool-schema-runtime.js", () => ({
    logProviderToolSchemaDiagnostics: vi.fn(),
    normalizeProviderToolSchemas: vi.fn(({ tools }: { tools: unknown[] }) => tools),
  }));

  vi.doMock("../agent-tool-definition-adapter.js", () => ({
    toToolDefinitions: vi.fn(createMockToolDefinitions),
  }));
}

export function mockCompactHooksSkills(
  resolveSkillsPrompt: typeof import("../../skills/loading/workspace-skill-prompt.js").resolveSkillsPrompt,
) {
  vi.doMock("../../skills/runtime/env-overrides.js", () => ({
    applySkillEnvOverrides: vi.fn(() => () => {}),
    applySkillEnvOverridesFromSnapshot: vi.fn(() => () => {}),
  }));

  vi.doMock("../../skills/loading/workspace-skill-loader.js", () => ({
    prepareWorkspaceSkills: vi.fn<
      typeof import("../../skills/loading/workspace-skill-loader.js").prepareWorkspaceSkills
    >(async () => []),
  }));

  vi.doMock("../../skills/loading/workspace-skill-prompt.js", () => ({
    buildSkillSnapshot: vi.fn<
      typeof import("../../skills/loading/workspace-skill-prompt.js").buildSkillSnapshot
    >(async () => ({ prompt: "", skills: [], resolvedSkills: [], discoverySkills: [] })),
    resolveSkillsPrompt,
  }));
}

export function registerCompactionPermissionTests({
  compactDirect,
  fixture,
  workspaceDir,
  sessionId,
  toolOptions,
}: {
  compactDirect: (overrides: Record<string, unknown>) => Promise<unknown>;
  fixture: { makeTempDir: (prefix: string) => string };
  workspaceDir: () => string;
  sessionId: () => string;
  toolOptions: () => unknown;
}) {
  it.each([
    { execMode: "deny", permissionMode: "read-only", expectedExecMode: "deny", rootless: false },
    { execMode: "allowlist", permissionMode: "guarded", expectedExecMode: "ask", rootless: false },
    { execMode: "full", permissionMode: "full", expectedExecMode: "full", rootless: false },
    { execMode: undefined, permissionMode: "workspace", expectedExecMode: "auto", rootless: true },
  ] as const)(
    "uses the final $permissionMode permission policy for compaction tools",
    async ({ execMode, permissionMode, expectedExecMode, rootless }) => {
      const directory = rootless
        ? fixture.makeTempDir("openclaw-rootless-compaction-permission-")
        : join(workspaceDir(), "workspace");
      const root = rootless ? await realpath(directory) : directory;
      await compactDirect({
        workspaceDir: directory,
        requireWorkspaceOnly: rootless || undefined,
        permissionMode: rootless ? "workspace" : "full",
        sessionRoot: rootless ? undefined : root,
        execOverrides: execMode ? { mode: execMode } : undefined,
        sessionEntry: {
          sessionId: sessionId(),
          permissionMode: rootless ? "workspace" : "full",
          sessionRoot: rootless ? undefined : root,
        },
      });

      const options = expectRecordFields(toolOptions(), {
        sessionPermissionPolicy: {
          mode: permissionMode,
          root,
        },
      });
      expect(options.exec).toEqual(expect.objectContaining({ mode: expectedExecMode }));
      if (rootless) {
        expect(options.requireWorkspaceOnly).toBe(true);
      }
    },
  );

  it.each(["direct", "recorder"] as const)(
    "keeps default-mode participant compaction tools at the clamped root via %s",
    async (source) => {
      const { createParticipationTestAuthority } =
        await import("../participation-ceiling.test-support.js");
      const { attachCompactionAccountingRecorder } =
        await import("./run/compaction-accounting-bridge.js");
      const directory = fixture.makeTempDir("participant-compaction-");
      const root = await realpath(directory);
      const operatorAuthority = createParticipationTestAuthority({
        kind: "send",
        profileId: "guest",
        sessionKey: "agent:main:invited",
        permission: "workspace",
        source: {
          agentId: "main",
          sessionId: "invited",
          lifecycleRevision: null,
          creatorProfileId: "creator",
          root,
        },
      });
      const contextEngineRuntimeContext = {};
      attachCompactionAccountingRecorder(contextEngineRuntimeContext, { operatorAuthority });
      await compactDirect({
        workspaceDir: workspaceDir(),
        sessionRoot: workspaceDir(),
        ...(source === "direct"
          ? { pluginExecutionAuthority: operatorAuthority }
          : { contextEngineRuntimeContext }),
        execOverrides: { mode: "full" },
      });
      expect(toolOptions()).toMatchObject({
        sessionPermissionPolicy: { root, mode: "workspace" },
        exec: { mode: "auto" },
      });
    },
  );
}
