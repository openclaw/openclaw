import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { clearMemoryPluginState, registerMemoryCapability } from "../../plugins/memory-state.js";
import * as bootstrapRuntime from "../bootstrap-files.js";
import { prepareAgentWorkspaceContext } from "./workspace-context.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
});

const workspaceDir = path.resolve("workspace-context-fixture");
type BootstrapFile = Awaited<
  ReturnType<typeof bootstrapRuntime.resolveBootstrapFilesForRun>
>[number];
const budget = { agents: { defaults: { bootstrapMaxChars: 300, bootstrapTotalMaxChars: 300 } } };
function prepare(
  files: BootstrapFile[],
  params: Partial<Parameters<typeof prepareAgentWorkspaceContext>[0]> = {},
) {
  vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockResolvedValue(files);
  return prepareAgentWorkspaceContext({ workspaceDir, scope: "full", ...params });
}

it("budgets root instructions independently of turn context", async () => {
  const { instructionSnapshot: snapshot } = await prepare(
    [
      bootstrapFile("SOUL.md", "Persona context.\n".repeat(100)),
      bootstrapFile("AGENTS.md", "Bounded fixture operating rules.\n".repeat(30)),
      bootstrapFile("MEMORY.md", "Durable memory.\n".repeat(100)),
    ],
    { scope: "instructions-only", config: budget },
  );
  expect(snapshot.files).toHaveLength(1);
  expect(snapshot.files[0]?.content).toContain("Bounded fixture operating rules.");
  expect(snapshot.files[0]?.content).toContain("truncated");
  expect(snapshot.files[0]?.content.length).toBeLessThanOrEqual(300);
  expect(snapshot.instructions).toContain("OpenClaw Agent Workspace Instructions");
});

it("orders personal instructions in a remapped workspace", async () => {
  const personalFile = (profile: string, root = workspaceDir): BootstrapFile => ({
    ...bootstrapFile("USER.md", `${profile} preferences.`, `users/${profile}/USER.md`, root),
    personalUser: true,
  });
  vi.spyOn(bootstrapRuntime, "resolveBootstrapFilesForRun").mockImplementation(async (params) => [
    bootstrapFile("USER.md", "Shared preferences."),
    ...(params.bootstrapUserProfileId ? [personalFile(params.bootstrapUserProfileId)] : []),
    bootstrapFile("IDENTITY.md", "Agent identity."),
    bootstrapFile("SOUL.md", "Agent voice."),
  ]);
  const projectedWorkspace = path.join(workspaceDir, "task");
  for (const profile of ["alice", "bob", undefined]) {
    const context = await prepareAgentWorkspaceContext({
      workspaceDir,
      scope: "full",
      bootstrapUserProfileId: profile,
      projectPath: (filePath) =>
        path.join(projectedWorkspace, path.relative(workspaceDir, filePath)),
    });
    const shared = context.sharedPersonaInstructions ?? "";
    for (const text of ["Shared preferences.", "Agent identity.", "Agent voice."]) {
      expect(shared).toContain(text);
    }
    for (const text of ["alice preferences.", "bob preferences.", "belongs to this session"]) {
      expect(shared).not.toContain(text);
    }
    const turn = context.personaInstructions ?? "";
    expect(turn).toContain("<AGENT_SOUL>");
    expect(turn).toContain("</AGENT_SOUL>");
    expect(turn).toContain("Shared preferences.");
    expect(turn.includes("alice preferences.")).toBe(profile === "alice");
    expect(turn.includes("bob preferences.")).toBe(profile === "bob");
    expect(turn.includes("belongs to this session")).toBe(Boolean(profile));
    expect(context.personaFiles).toEqual([
      { path: path.join(projectedWorkspace, "SOUL.md"), content: "Agent voice." },
      { path: path.join(projectedWorkspace, "IDENTITY.md"), content: "Agent identity." },
      { path: path.join(projectedWorkspace, "USER.md"), content: "Shared preferences." },
      ...(profile ? [contextFile(personalFile(profile, projectedWorkspace))] : []),
    ]);
    if (profile) {
      expect(turn.indexOf("Shared preferences.")).toBeLessThan(
        turn.indexOf(`${profile} preferences.`),
      );
    }
  }
});

it("routes root memory before budgeting and keeps nested memory as context", async () => {
  const rootMemory = bootstrapFile("MEMORY.md", "Large durable memory.\n".repeat(100));
  const nestedMemory = bootstrapFile(
    "MEMORY.md",
    "Package-local memory remains project context.",
    "packages/pkg/MEMORY.md",
  );
  const instructions = bootstrapFile("AGENTS.md", "Keep the bounded operating rules.");
  const context = await prepare([rootMemory, nestedMemory, instructions], {
    memoryToolRouted: true,
    config: budget,
  });
  expect(context.memoryReferenceFiles).toEqual([contextFile(rootMemory)]);
  expect(context.memoryToolRoutedBootstrapFiles).toEqual([rootMemory]);
  expect(context.promptContextFiles).toEqual([contextFile(nestedMemory)]);
  expect(context.instructionSnapshot.files).toEqual([contextFile(instructions)]);
});

it("passes agent context to memory guidance without MEMORY.md", async () => {
  const promptBuilder = (context: {
    agentId?: string;
    agentSessionKey?: string;
    sandboxed?: boolean;
  }) => [
    `agent=${context.agentId} session=${context.agentSessionKey} sandboxed=${context.sandboxed}`,
  ];
  registerMemoryCapability("memory-core", { promptBuilder });
  const context = await prepare([], {
    agentId: "marketing-agent",
    sessionKey: "agent:marketing-agent:session-1",
    memoryToolRouted: true,
    memoryTools: { toolNames: ["memory_search", "memory_get"], sandboxed: true },
  });
  expect(context.memoryRecallInstructions).toContain(
    "agent=marketing-agent session=agent:marketing-agent:session-1 sandboxed=true",
  );
});

it("preserves project ordering for whitespace-prefixed hook filenames", async () => {
  const paddedSoul = bootstrapFile("SOUL.md", "Hook project context.", "pkg/ SOUL.md");
  const bootstrap = bootstrapFile("BOOTSTRAP.md", "Setup guidance.", "pkg/BOOTSTRAP.md");
  const context = await prepare([paddedSoul, bootstrap], {
    contextFileOrder: new Map([
      ["soul.md", 10],
      ["bootstrap.md", 50],
    ]),
  });
  expect(context.promptContextFiles).toEqual([contextFile(bootstrap), contextFile(paddedSoul)]);
});

function bootstrapFile(
  name: BootstrapFile["name"],
  content: string,
  relativePath: string = name,
  root = workspaceDir,
): BootstrapFile {
  return { name, path: path.join(root, relativePath), content, missing: false };
}

function contextFile(file: ReturnType<typeof bootstrapFile>) {
  return {
    path: file.path,
    content: file.content,
    ...(file.personalUser ? { personalUser: file.personalUser } : {}),
  };
}
