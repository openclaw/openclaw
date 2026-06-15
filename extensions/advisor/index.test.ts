// Advisor plugin tests cover tool factory behavior and llm.complete integration.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import advisorPlugin from "./index.js";

function buildApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return createTestPluginApi({
    runtime: {
      llm: {
        complete: vi.fn(async () => ({
          text: "The approach looks solid.",
          provider: "test-provider",
          model: "test-model",
          agentId: "test-agent",
          usage: { inputTokens: 10, outputTokens: 5 },
          audit: { caller: { kind: "plugin" } },
        })),
      },
    } as unknown as OpenClawPluginApi["runtime"],
    ...overrides,
  });
}

describe("advisor plugin", () => {
  it("registers exactly one tool named advisor", () => {
    const api = buildApi();
    const registered: unknown[] = [];
    const spy = vi.spyOn(api, "registerTool").mockImplementation((t) => {
      registered.push(t);
    });
    advisorPlugin.register(api);
    expect(spy).toHaveBeenCalledOnce();
    expect(registered).toHaveLength(1);
  });

  it("creates advisor tool with correct name and description", () => {
    const api = buildApi();
    let toolFactory: ((ctx: object) => unknown) | null = null;
    vi.spyOn(api, "registerTool").mockImplementation((factory) => {
      toolFactory = factory as typeof toolFactory;
    });
    advisorPlugin.register(api);
    expect(toolFactory).not.toBeNull();
    const tool = toolFactory!({ agentId: "agent-1" }) as {
      name: string;
      label: string;
      description: string;
    };
    expect(tool.name).toBe("advisor");
    expect(tool.label).toBe("Advisor");
    expect(tool.description).toContain("second opinion");
  });

  it("calls api.runtime.llm.complete with user message on execute", async () => {
    const completeMock = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Looks good.",
      provider: "test",
      model: "test-model",
      agentId: "agent-1",
      usage: {},
      audit: { caller: { kind: "plugin" as const } },
    }));
    const api = buildApi({
      runtime: {
        llm: { complete: completeMock },
      } as unknown as OpenClawPluginApi["runtime"],
    });

    let toolFactory: ((ctx: object) => unknown) | null = null;
    vi.spyOn(api, "registerTool").mockImplementation((factory) => {
      toolFactory = factory as typeof toolFactory;
    });
    advisorPlugin.register(api);

    const tool = toolFactory!({ agentId: "agent-1" }) as {
      execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
    };

    const result = await tool.execute("call-1", {
      question: "Is this implementation correct?",
    });

    expect(completeMock).toHaveBeenCalledOnce();
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: "Is this implementation correct?" }],
        purpose: "advisor",
      }),
    );
    expect(result.content[0]?.text).toContain("Looks good.");
  });

  it("prepends context before question when context is provided", async () => {
    const completeMock = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Context noted.",
      provider: "test",
      model: "test-model",
      agentId: "agent-1",
      usage: {},
      audit: { caller: { kind: "plugin" as const } },
    }));
    const api = buildApi({
      runtime: {
        llm: { complete: completeMock },
      } as unknown as OpenClawPluginApi["runtime"],
    });

    let toolFactory: ((ctx: object) => unknown) | null = null;
    vi.spyOn(api, "registerTool").mockImplementation((factory) => {
      toolFactory = factory as typeof toolFactory;
    });
    advisorPlugin.register(api);

    const tool = toolFactory!({ agentId: "agent-1" }) as {
      execute: (id: string, params: unknown) => Promise<{ content: { text: string }[] }>;
    };

    await tool.execute("call-2", {
      question: "Is this safe?",
      context: "We are writing to /etc/hosts",
    });

    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("We are writing to /etc/hosts"),
          }),
        ],
      }),
    );
    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining("Is this safe?"),
          }),
        ],
      }),
    );
  });

  it("passes configuredModelRef as model when pluginConfig.modelRef is set", async () => {
    const completeMock = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Model override worked.",
      provider: "vmlx",
      model: "gemma-4-26B",
      agentId: "agent-1",
      usage: {},
      audit: { caller: { kind: "plugin" as const } },
    }));
    const api = buildApi({
      pluginConfig: { modelRef: "vmlx/gemma-4-26B" },
      runtime: {
        llm: { complete: completeMock },
      } as unknown as OpenClawPluginApi["runtime"],
    });

    let toolFactory: ((ctx: object) => unknown) | null = null;
    vi.spyOn(api, "registerTool").mockImplementation((factory) => {
      toolFactory = factory as typeof toolFactory;
    });
    advisorPlugin.register(api);

    const tool = toolFactory!({ agentId: "agent-1" }) as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    await tool.execute("call-3", { question: "Any issues?" });

    expect(completeMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "vmlx/gemma-4-26B" }),
    );
  });

  it("omits model from complete call when pluginConfig.modelRef is not set", async () => {
    const completeMock = vi.fn(async (_params: Record<string, unknown>) => ({
      text: "Default model response.",
      provider: "anthropic",
      model: "claude-opus-4-8",
      agentId: "agent-1",
      usage: {},
      audit: { caller: { kind: "plugin" as const } },
    }));
    const api = buildApi({
      runtime: {
        llm: { complete: completeMock },
      } as unknown as OpenClawPluginApi["runtime"],
    });

    let toolFactory: ((ctx: object) => unknown) | null = null;
    vi.spyOn(api, "registerTool").mockImplementation((factory) => {
      toolFactory = factory as typeof toolFactory;
    });
    advisorPlugin.register(api);

    const tool = toolFactory!({ agentId: "agent-1" }) as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };
    await tool.execute("call-4", { question: "Any issues?" });

    expect(completeMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ model: expect.anything() }),
    );
  });
});
