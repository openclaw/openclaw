import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";
import * as bootstrapRuntime from "../bootstrap-files.js";
import { prepareAgentWorkspaceContext } from "./workspace-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

describe("agent workspace context preparation", () => {
  const workspaceDir = path.resolve("workspace-context-fixture");

  it("budgets the root instruction snapshot independently of unsupported turn context", async () => {
    const rules = "Bounded fixture operating rules.\n".repeat(30);
    vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue([
      bootstrapFile("SOUL.md", "Persona context.\n".repeat(100)),
      bootstrapFile("AGENTS.md", rules),
      bootstrapFile("MEMORY.md", "Durable memory.\n".repeat(100)),
    ]);
    const context = await prepareAgentWorkspaceContext({
      workspaceDir,
      scope: "instructions-only",
      config: { agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 300 } } },
    });
    expect(context.instructionSnapshot.files).toHaveLength(1);
    expect(context.instructionSnapshot.files[0]?.content).toContain(
      "Bounded fixture operating rules.",
    );
    expect(context.instructionSnapshot.files[0]?.content).toContain("truncated");
    expect(context.instructionSnapshot.files[0]?.content.length).toBeLessThanOrEqual(300);
    expect(context.instructionSnapshot.instructions).toContain(
      "OpenClaw Agent Workspace Instructions",
    );
  });

  it.each(["direct", "inherited", "remapped"] as const)(
    "keeps a root USER.md under users/arbitrary shared in a %s workspace",
    async (workspaceMode) => {
      const nestedWorkspace = path.join(workspaceDir, "users", "arbitrary");
      const projectedWorkspace =
        workspaceMode === "remapped"
          ? path.join(workspaceDir, "sandbox", "users", "arbitrary")
          : nestedWorkspace;
      vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue([
        {
          ...bootstrapFile("USER.md", "Shared preferences."),
          path: path.join(nestedWorkspace, "USER.md"),
        },
      ]);
      const context = await prepareAgentWorkspaceContext({
        workspaceDir: nestedWorkspace,
        scope: "full",
        projectPath: (filePath) =>
          path.join(projectedWorkspace, path.relative(nestedWorkspace, filePath)),
      });
      expect(context.personaFiles).toEqual([
        { path: path.join(projectedWorkspace, "USER.md"), content: "Shared preferences." },
      ]);
      expect(context.personaInstructions).toContain("Shared preferences.");
      expect(context.personaInstructions).toContain(
        "Internalize and follow them accordingly.\n\n<AGENT_SOUL>",
      );
    },
  );

  it.each(["inherited", "remapped"] as const)(
    "prepares ordered personal instructions for the current profile in a %s workspace",
    async (workspaceMode) => {
      vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockImplementation(
        async (params) => [
          bootstrapFile("USER.md", "Shared preferences."),
          ...(params.bootstrapUserProfileId
            ? [
                {
                  ...bootstrapFile(
                    "USER.md",
                    params.bootstrapUserProfileId === "alice"
                      ? "Alice preferences."
                      : "Bob preferences.",
                  ),
                  path: path.join(workspaceDir, "users", params.bootstrapUserProfileId, "USER.md"),
                  personalUser: true as const,
                },
              ]
            : []),
          bootstrapFile("IDENTITY.md", "Agent identity."),
          bootstrapFile("SOUL.md", "Agent voice."),
        ],
      );
      const projectedWorkspace =
        workspaceMode === "remapped" ? path.join(workspaceDir, "task") : workspaceDir;
      for (const profile of ["alice", "bob", undefined]) {
        const context = await prepareAgentWorkspaceContext({
          workspaceDir,
          scope: "full",
          bootstrapUserProfileId: profile,
          projectPath: (filePath) =>
            path.join(projectedWorkspace, path.relative(workspaceDir, filePath)),
        });
        const turn = context.personaInstructions ?? "";
        expect(turn).toContain("<AGENT_SOUL>");
        expect(turn).toContain("</AGENT_SOUL>");
        expect(turn).toContain("Shared preferences.");
        expect(turn.includes("Alice preferences.")).toBe(profile === "alice");
        expect(turn.includes("Bob preferences.")).toBe(profile === "bob");
        expect(turn.includes("belongs to this session")).toBe(Boolean(profile));
        expect(context.personaFiles).toEqual([
          { path: path.join(projectedWorkspace, "SOUL.md"), content: "Agent voice." },
          { path: path.join(projectedWorkspace, "IDENTITY.md"), content: "Agent identity." },
          { path: path.join(projectedWorkspace, "USER.md"), content: "Shared preferences." },
          ...(profile
            ? [
                {
                  path: path.join(projectedWorkspace, "users", profile, "USER.md"),
                  content: profile === "alice" ? "Alice preferences." : "Bob preferences.",
                  personalUser: true,
                },
              ]
            : []),
        ]);
        if (profile) {
          expect(turn.indexOf("Shared preferences.")).toBeLessThan(
            turn.indexOf(profile === "alice" ? "Alice preferences." : "Bob preferences."),
          );
        }
      }
    },
  );

  it("routes only root memory before budgeting and retains nested memory as project context", async () => {
    const rootMemory = bootstrapFile("MEMORY.md", "Large durable memory.\n".repeat(100));
    const nestedMemory = {
      ...bootstrapFile("MEMORY.md", "Package-local memory remains project context."),
      path: path.join(workspaceDir, "packages", "pkg", "MEMORY.md"),
    };
    const instructions = bootstrapFile("AGENTS.md", "Keep the bounded operating rules.");
    vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue([
      rootMemory,
      nestedMemory,
      instructions,
    ]);
    const context = await prepareAgentWorkspaceContext({
      workspaceDir,
      scope: "full",
      memoryToolRouted: true,
      config: { agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 300 } } },
    });
    expect(context.memoryReferenceFiles).toEqual([contextFile(rootMemory)]);
    expect(context.memoryToolRoutedBootstrapFiles).toEqual([rootMemory]);
    expect(context.promptContextFiles).toEqual([contextFile(nestedMemory)]);
    expect(context.instructionSnapshot.files).toEqual([contextFile(instructions)]);
    expect(context.instructionSnapshot.instructions).toContain("Keep the bounded operating rules.");
  });

  it("passes agent context to active memory guidance without requiring root MEMORY.md", async () => {
    vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue([]);
    let observedContext:
      | { agentId?: string; agentSessionKey?: string; sandboxed?: boolean }
      | undefined;
    registerMemoryCapability("memory-core", {
      promptBuilder: (context) => {
        observedContext = context;
        return [
          "## Agent Memory",
          `agent=${context.agentId} session=${context.agentSessionKey}`,
          "",
        ];
      },
    });
    const context = await prepareAgentWorkspaceContext({
      workspaceDir,
      scope: "full",
      agentId: "marketing-agent",
      sessionKey: "agent:marketing-agent:session-1",
      memoryToolRouted: true,
      memoryTools: { toolNames: ["memory_search", "memory_get"], sandboxed: true },
    });
    expect(observedContext).toMatchObject({
      agentId: "marketing-agent",
      agentSessionKey: "agent:marketing-agent:session-1",
      sandboxed: true,
    });
    expect(context.memoryRecallInstructions).toContain(
      "agent=marketing-agent session=agent:marketing-agent:session-1",
    );
  });

  it("preserves native project ordering for hook filenames with leading whitespace", async () => {
    const paddedSoul = {
      ...bootstrapFile("SOUL.md", "Hook project context."),
      path: path.join(workspaceDir, "pkg", " SOUL.md"),
    };
    const bootstrap = {
      ...bootstrapFile("BOOTSTRAP.md", "Setup guidance."),
      path: path.join(workspaceDir, "pkg", "BOOTSTRAP.md"),
    };
    vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue([
      paddedSoul,
      bootstrap,
    ]);
    const context = await prepareAgentWorkspaceContext({
      workspaceDir,
      scope: "full",
      contextFileOrder: new Map([
        ["soul.md", 10],
        ["bootstrap.md", 50],
      ]),
    });
    expect(context.promptContextFiles).toEqual([contextFile(bootstrap), contextFile(paddedSoul)]);
  });

  function bootstrapFile(
    name: Awaited<ReturnType<typeof bootstrapRuntime.resolveBootstrapFilesForRun>>[number]["name"],
    content: string,
  ): Awaited<ReturnType<typeof bootstrapRuntime.resolveBootstrapFilesForRun>>[number] {
    return { name, path: path.join(workspaceDir, name), content, missing: false };
  }

  function contextFile(file: ReturnType<typeof bootstrapFile>) {
    return {
      path: file.path,
      content: file.content,
      ...(file.personalUser ? { personalUser: file.personalUser } : {}),
    };
  }
});
