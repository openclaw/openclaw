import {
  createOwnerBackedContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge, makeInvocation, runSdkTool } from "./tool-bridge.test-support.js";

const mocks = vi.hoisted(() => ({ publicFactory: vi.fn(() => []) }));
vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: mocks.publicFactory,
}));

afterEach(() => vi.clearAllMocks());

const owner = "fixture-memory-owner";
const makeTool = (name: string, text = "HOST_PINNED_READER") =>
  createOwnerBackedContractTool({ pluginId: owner, name, result: textToolResult(text) });
type Attempt = Parameters<typeof createCopilotToolBridge>[0]["attemptParams"];
function makeBridge(attemptParams: Attempt = {}, workspaceDir?: string) {
  return createCopilotToolBridge({
    workspaceDir,
    attemptParams: { hostCapabilities: createCopilotTestHostCapabilities(), ...attemptParams },
  });
}

it.each(
  (["tools", "directory", "code"] as const).flatMap((mode) =>
    (["file", "provider"] as const).map((arm) => ({ mode, arm })),
  ),
)("$arm memory remains directly callable in $mode mode", async ({ mode, arm }) => {
  const config = {
    tools: {
      toolSearch: { enabled: true, mode: mode === "directory" ? "directory" : "tools" },
      codeMode: mode === "code",
    },
  } as const;
  const originalConfig = structuredClone(config);
  const name = arm === "file" ? "write" : "memory_store";
  const persistence = makeTool(name, "PERSISTED_MEMORY");
  // The host has already projected the selected flush arm. This exercises
  // the real bridge's later SDK presentation, not host persistence policy.
  const reader = makeTool("read");
  const bridge = await makeBridge({
    config,
    trigger: "memory",
    toolsAllow: ["read", name],
    ...(arm === "file"
      ? { memoryFlushWritePath: "memory/2026-10-09.md" }
      : {
          memoryFlushTools: {
            flushId: "fixture-flush",
            ownerPluginId: owner,
            persistenceToolNames: [name],
            recordPersistenceToolSuccess: () => {},
          },
        }),
    hostCapabilities: createCopilotTestHostCapabilities(() => [reader, persistence]),
  });
  onTestFinished(() => bridge.cleanup?.());
  const surface = bridge.promptToolPolicy.apply();
  expect(bridge.codeModeEngaged).toBe(false);
  expect(bridge.sourceTools.map((tool) => tool.name)).toEqual(["read", name]);
  expect(surface.tools.map((tool) => tool.name)).toEqual(["read", name]);
  expect(surface.callableToolNames).toEqual(["read", name]);
  expect(surface.toolSchemaDirectoryPrompt).toBeUndefined();
  const tool = surface.tools[1]!;
  const args = { content: "remember this" };
  await expect(runSdkTool(tool, args, makeInvocation({ toolName: name }))).resolves.toMatchObject({
    resultType: "success",
    textResultForLlm: "PERSISTED_MEMORY",
  });
  expect(vi.mocked(persistence.execute).mock.calls).toEqual([
    ["call-1", args, undefined, undefined],
  ]);
  expect(config).toEqual(originalConfig);
});

it("uses the host-prepared reader without rebinding it or calling the public factory", async () => {
  let active = true;
  const reader = makeTool("read");
  reader.execute = vi.fn(async () => {
    if (!active) {
      throw new Error("host closed");
    }
    return textToolResult("HOST_PINNED_READER");
  });
  const createToolSurfaceAsync = vi.fn(async () => [reader]);
  const bindToolSurface = vi.fn(() => {
    throw new Error("Host-created tools must not be rebound");
  });
  const skillsSnapshot = { prompt: "", skills: [{ name: "manual" }], resolvedSkills: [] };
  const bridge = await makeBridge(
    {
      config: { tools: { toolSearch: false } },
      codeModeOverride: false,
      skillsSnapshot,
      toolsAllow: ["read"],
      hostCapabilities: {
        ...createCopilotTestHostCapabilities(),
        createToolSurfaceAsync,
        bindToolSurface,
      },
    },
    "/workspace",
  );
  onTestFinished(() => bridge.cleanup?.());
  expect(createToolSurfaceAsync).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ skillsSnapshot, workspaceDir: "/workspace" }),
    { cwd: "/workspace" },
  );
  expect(mocks.publicFactory).not.toHaveBeenCalled();
  expect(bindToolSurface).not.toHaveBeenCalled();
  expect(bridge.sourceTools).toContain(reader);
  const sdkReader = bridge.promptToolPolicy.apply().tools.find((tool) => tool.name === "read");
  expect(sdkReader).toMatchObject({ skipPermission: true, overridesBuiltInTool: true });
  const invocation = makeInvocation({ toolName: "read", toolCallId: "read-1", arguments: {} });
  await expect(sdkReader!.handler!({}, invocation)).resolves.toMatchObject({
    resultType: "success",
    textResultForLlm: expect.stringContaining("HOST_PINNED_READER"),
  });
  active = false;
  await expect(
    sdkReader!.handler!({}, { ...invocation, toolCallId: "read-closed" }),
  ).resolves.toMatchObject({
    resultType: "failure",
    error: expect.stringContaining("host closed"),
  });
});

it("does not silently fall back to the public factory when host construction is unavailable", async () => {
  await expect(makeBridge({ codeModeOverride: false })).rejects.toThrow(
    "Copilot tool construction requires a current host capability",
  );
  expect(mocks.publicFactory).not.toHaveBeenCalled();
});
