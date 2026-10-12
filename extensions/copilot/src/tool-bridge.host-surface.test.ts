import { expectDefined } from "@openclaw/normalization-core";
import {
  createOwnerBackedContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge, makeInvocation, runSdkTool } from "./tool-bridge.test-support.js";

const mocks = vi.hoisted(() => ({ publicFactory: vi.fn(() => []) }));
vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: mocks.publicFactory,
}));

afterEach(() => vi.clearAllMocks());

describe("Copilot host-owned tool construction", () => {
  it.each(
    (["tools", "directory", "code"] as const).flatMap((mode) =>
      (["file", "provider"] as const).map((arm) => ({ mode, arm })),
    ),
  )(
    "keeps $arm memory persistence directly callable with $mode presentation",
    async ({ mode, arm }) => {
      const config = {
        tools: {
          toolSearch: { enabled: true, mode: mode === "directory" ? "directory" : "tools" },
          codeMode: mode === "code",
        },
      } as const;
      const originalConfig = structuredClone(config);
      const name = arm === "file" ? "write" : "memory_store";
      const persistence = createOwnerBackedContractTool({
        pluginId: "fixture-memory-owner",
        name,
        result: textToolResult("PERSISTED_MEMORY"),
      });
      persistence.execute = vi.fn(async () => textToolResult("PERSISTED_MEMORY"));
      // The host has already projected the selected flush arm. This exercises
      // the real bridge's later SDK presentation, not host persistence policy.
      const reader = createOwnerBackedContractTool({
        pluginId: "fixture-memory-owner",
        name: "read",
        result: textToolResult("HOST_PINNED_READER"),
      });
      const bridge = await createCopilotToolBridge({
        attemptParams: {
          config,
          trigger: "memory",
          toolsAllow: ["read", name],
          ...(arm === "file"
            ? { memoryFlushWritePath: "memory/2026-10-09.md" }
            : {
                memoryFlushTools: {
                  flushId: "fixture-flush",
                  ownerPluginId: "fixture-memory-owner",
                  persistenceToolNames: [name],
                  recordPersistenceToolSuccess: () => {},
                },
              }),
          hostCapabilities: createCopilotTestHostCapabilities(() => [reader, persistence]),
        },
      });
      try {
        const surface = bridge.promptToolPolicy.apply();
        expect(bridge.codeModeEngaged).toBe(false);
        expect(bridge.sourceTools.map((tool) => tool.name)).toEqual(["read", name]);
        expect(surface.tools.map((tool) => tool.name)).toEqual(["read", name]);
        expect(surface.callableToolNames).toEqual(["read", name]);
        expect(surface.toolSchemaDirectoryPrompt).toBeUndefined();
        const sdkPersistence = expectDefined(
          surface.tools.find((tool) => tool.name === name),
          "direct memory persistence handler",
        );
        const args = { content: "remember this" };
        await expect(
          runSdkTool(sdkPersistence, args, makeInvocation({ toolName: name })),
        ).resolves.toMatchObject({
          resultType: "success",
          textResultForLlm: "PERSISTED_MEMORY",
        });
        expect(persistence.execute).toHaveBeenCalledExactlyOnceWith(
          "call-1",
          args,
          undefined,
          undefined,
        );
        expect(config).toEqual(originalConfig);
      } finally {
        bridge.cleanup?.();
      }
    },
  );

  it("uses the host-prepared reader without rebinding it or calling the public factory", async () => {
    let active = true;
    const reader = createOwnerBackedContractTool({
      pluginId: "fixture-owner",
      name: "read",
      result: textToolResult("HOST_PINNED_READER"),
    });
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
    const bridge = await createCopilotToolBridge({
      workspaceDir: "/workspace",
      attemptParams: {
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
    });
    expect(createToolSurfaceAsync).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ skillsSnapshot, workspaceDir: "/workspace" }),
      { cwd: "/workspace" },
    );
    expect(mocks.publicFactory).not.toHaveBeenCalled();
    expect(bindToolSurface).not.toHaveBeenCalled();
    expect(bridge.sourceTools).toContain(reader);
    const sdkReader = bridge.promptToolPolicy.apply().tools.find((tool) => tool.name === "read");
    expect(sdkReader).toMatchObject({ skipPermission: true, overridesBuiltInTool: true });
    expect(sdkReader?.handler).toBeTypeOf("function");
    const invocation = makeInvocation({ toolName: "read", toolCallId: "read-1", arguments: {} });
    const result = await sdkReader!.handler!({}, invocation);
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("HOST_PINNED_READER"),
    });
    active = false;
    const rejected = await sdkReader!.handler!({}, { ...invocation, toolCallId: "read-closed" });
    expect(rejected).toMatchObject({
      resultType: "failure",
      error: expect.stringContaining("host closed"),
    });
    bridge.cleanup?.();
  });

  it("does not silently fall back to the public factory when host construction is unavailable", async () => {
    await expect(
      createCopilotToolBridge({
        attemptParams: {
          codeModeOverride: false,
          hostCapabilities: createCopilotTestHostCapabilities(),
        },
      }),
    ).rejects.toThrow("Copilot tool construction requires a current host capability");
    expect(mocks.publicFactory).not.toHaveBeenCalled();
  });
});
