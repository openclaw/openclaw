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
function makeBridge(attemptParams: Attempt = {}) {
  return createCopilotToolBridge({
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
    hostCapabilities: {
      ...createCopilotTestHostCapabilities(),
      createToolSurfaceAsync: async () => [reader, persistence],
      bindToolSurface: () => {
        throw new Error("Host-created tools must not be rebound");
      },
    },
  });
  onTestFinished(() => bridge.cleanup?.());
  const surface = bridge.promptToolPolicy.apply();
  expect(surface.tools.map((tool) => tool.name)).toEqual(["read", name]);
  expect(surface.toolSchemaDirectoryPrompt).toBeUndefined();
  expect(mocks.publicFactory).not.toHaveBeenCalled();
  expect(surface.tools[0]).toMatchObject({ skipPermission: true, overridesBuiltInTool: true });
  await expect(
    runSdkTool(surface.tools[0]!, {}, makeInvocation({ toolName: "read" })),
  ).resolves.toMatchObject({
    resultType: "success",
    textResultForLlm: expect.stringContaining("HOST_PINNED_READER"),
  });
  const tool = surface.tools[1]!;
  const args = { content: "remember this" };
  await expect(runSdkTool(tool, args, makeInvocation({ toolName: name }))).resolves.toMatchObject({
    resultType: "success",
    textResultForLlm: "PERSISTED_MEMORY",
  });
  expect(config).toEqual(originalConfig);
});

it("does not silently fall back to the public factory when host construction is unavailable", async () => {
  await expect(makeBridge({ codeModeOverride: false })).rejects.toThrow(
    "Copilot tool construction requires a current host capability",
  );
  expect(mocks.publicFactory).not.toHaveBeenCalled();
});
