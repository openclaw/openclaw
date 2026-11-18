import "./browser-tool.test-support.js";
import type { DecisionRuntimeV2 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "../plugin-registration.js";
import { createBrowserTool } from "./browser-tool.js";

// mock-isolation: Exercise lazy registration without starting the Browser service.
vi.mock("../register.runtime.js", () => ({
  createBrowserTool,
  hasBrowserNodeHostWork: () => false,
}));

const {
  browserActionsMocks,
  browserConfigMocks,
  gatewayMocks,
  mockSingleBrowserProxyNode,
  registerBrowserToolAfterEachReset,
} = await import("./browser-tool.test-support.js");
registerBrowserToolAfterEachReset();

describe("explicit browser judgment", () => {
  it("uses the registered Decision runtime and trusted calling agent", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const evaluateV2 = vi
        .fn<DecisionRuntimeV2["evaluateV2"]>()
        .mockResolvedValue({ status: "unavailable", reason: "not-configured" });
      const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
      const api = createTestPluginApi({
        registerTool,
        runtime: createPluginRuntimeMock({
          decisions: { evaluate: vi.fn(), evaluateV2 },
          state: {
            openKeyedStore: (options) => createPluginStateKeyedStoreForTests("browser", options),
          },
        }),
      });
      registerBrowserPlugin(api);
      const factory = registerTool.mock.calls[0]?.[0];
      if (typeof factory !== "function") {
        throw new Error("Expected registered Browser factory");
      }
      const tool = factory({ config: {}, runtimeConfig: {}, agentId: "page-reader" });
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected one Browser tool");
      }
      const result = await tool.execute("judge", { action: "judge" });
      expect(evaluateV2.mock.calls[0]?.[1].agentId).toBe("page-reader");
      expect(result.details).toMatchObject({
        judgment: { status: "unavailable", reason: "not-configured" },
      });
    });
  });
  const unavailable = { status: "unavailable" as const, reason: "not-configured" as const };
  function fixture() {
    const evaluateV2 = vi.fn<DecisionRuntimeV2["evaluateV2"]>().mockResolvedValue(unavailable);
    const decisions: DecisionRuntimeV2 = { evaluate: vi.fn(), evaluateV2 };
    return { evaluateV2, tool: createBrowserTool({ agentId: "requesting-agent", decisions }) };
  }

  it("preserves unavailability without retry or model fallback", async () => {
    const { tool, evaluateV2 } = fixture();
    const result = await tool.execute("judge", { action: "judge" });
    expect(result.details).toMatchObject({ judgment: unavailable });
    expect(evaluateV2).toHaveBeenCalledTimes(1);
    expect(browserActionsMocks.browserAct).not.toHaveBeenCalled();
  });

  it("keeps an omitted model target on the trusted run-bound tab", async () => {
    const evaluateV2 = vi.fn<DecisionRuntimeV2["evaluateV2"]>().mockResolvedValue(unavailable);
    const tool = createBrowserTool({
      agentId: "requesting-agent",
      decisions: { evaluate: vi.fn(), evaluateV2 },
      runToolBinding: {
        kind: "tab",
        tabId: 1,
        target: "host",
        profile: "openclaw",
        targetId: "bound-tab",
      },
    });
    await tool.execute("judge", { action: "judge" });
    expect(browserActionsMocks.browserPageText).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ targetId: "bound-tab", profile: "openclaw" }),
    );
    await expect(
      tool.execute("escape", { action: "judge", targetId: "other-tab" }),
    ).rejects.toThrow("cannot override its run-bound tab");
    expect(evaluateV2).toHaveBeenCalledTimes(1);
  });

  it("does not classify blank evidence as usable content or loading", async () => {
    const { tool, evaluateV2 } = fixture();
    browserActionsMocks.browserPageText.mockResolvedValueOnce({
      ok: true,
      targetId: "blank",
      text: " \n",
      truncated: false,
    });
    const result = await tool.execute("judge", { action: "judge" });
    expect(result.details).toMatchObject({
      judgment: { status: "unavailable", reason: "empty-observation" },
    });
    expect(evaluateV2).not.toHaveBeenCalled();
  });

  it("cancels after extraction before starting inference", async () => {
    const { tool, evaluateV2 } = fixture();
    const controller = new AbortController();
    browserActionsMocks.browserPageText.mockImplementationOnce(async () => {
      controller.abort(new Error("caller cancelled"));
      return { ok: true, targetId: "cancelled", text: "Login wall", truncated: false };
    });
    await expect(tool.execute("judge", { action: "judge" }, controller.signal)).rejects.toThrow(
      "caller cancelled",
    );
    expect(evaluateV2).not.toHaveBeenCalled();
  });

  it("bounds secondary evidence and reports truncation without returning the excerpt", async () => {
    const { tool, evaluateV2 } = fixture();
    browserActionsMocks.browserPageText.mockResolvedValueOnce({
      ok: true,
      targetId: "large",
      text: "SECRET-EXCERPT" + "x".repeat(20_000),
      truncated: true,
    });
    const result = await tool.execute("judge", { action: "judge" });
    const state = evaluateV2.mock.calls[0]![0].state;
    expect(state).toMatchObject({
      type: "text",
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
    if (state.type !== "text") {
      throw new Error("expected bounded text evidence");
    }
    expect(state.text.length).toBeLessThan(8000);
    expect(result.details).toMatchObject({ observation: { truncated: true } });
    expect(JSON.stringify(result)).not.toContain("SECRET-EXCERPT");
  });

  it("does not classify another host when the selected node supplies the page", async () => {
    const { tool, evaluateV2 } = fixture();
    mockSingleBrowserProxyNode();
    gatewayMocks.callGatewayTool.mockResolvedValueOnce({
      ok: true,
      payload: {
        result: { ok: true, targetId: "node-target", text: "NODE_PAGE", truncated: false },
        route: { status: "resolved", profile: "node-profile", driver: "openclaw" },
      },
    });
    const result = await tool.execute("judge", {
      action: "judge",
      target: "node",
      profile: "node-profile",
      targetId: "node-target",
    });
    expect(evaluateV2.mock.calls[0]![0].state).toMatchObject({
      text: expect.stringContaining("NODE_PAGE"),
    });
    expect(result.details).toMatchObject({ targetId: "node-target" });
    expect(browserActionsMocks.browserPageText).not.toHaveBeenCalled();
  });

  it("rejects unsupported existing-session profiles before inference", async () => {
    const { tool, evaluateV2 } = fixture();
    browserConfigMocks.resolveBrowserConfig.mockReturnValue({
      enabled: true,
      controlPort: 18791,
      defaultProfile: "user",
      actionTimeoutMs: 60_000,
      profiles: { user: { driver: "existing-session", attachOnly: true, color: "#00AA00" } },
    });
    await expect(tool.execute("judge", { action: "judge", profile: "user" })).rejects.toThrow(
      "not supported for existing-session",
    );
    expect(browserActionsMocks.browserPageText).not.toHaveBeenCalled();
    expect(evaluateV2).not.toHaveBeenCalled();
  });
  it("classifies the selected page without returning page text or inferring usability", async () => {
    browserActionsMocks.browserPageText.mockResolvedValueOnce({
      ok: true,
      targetId: "canonical-tab",
      url: "https://example.com/search",
      text: "PRIVATE_PAGE_BODY: Loading search results",
      truncated: false,
    });
    const outcome = {
      status: "ok" as const,
      result: {
        model: "fixture",
        answers: {
          loading: { type: "boolean" as const, probabilityTrue: 0.9 },
          empty_results: { type: "boolean" as const, answer: null },
          login_wall: { type: "error" as const, code: "provider-error" as const },
        },
      },
      provenance: { providerId: "fixture", rubricVersion: "fixture", runtimeGeneration: "one" },
    };
    const evaluateV2 = vi.fn<DecisionRuntimeV2["evaluateV2"]>().mockResolvedValue(outcome);
    const decisions: DecisionRuntimeV2 = { evaluate: vi.fn(), evaluateV2 };
    const result = await createBrowserTool({ agentId: "requesting-agent", decisions }).execute(
      "judge",
      { action: "judge", targetId: "selected-tab", profile: "openclaw" },
    );
    expect(browserActionsMocks.browserPageText).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        targetId: "selected-tab",
        profile: "openclaw",
        selector: "body",
        maxChars: 6000,
      }),
    );
    const [batch, options] = evaluateV2.mock.calls[0]!;
    expect(batch.state).toMatchObject({
      type: "text",
      text: expect.stringContaining("PRIVATE_PAGE_BODY"),
    });
    expect(batch.questions).toHaveProperty("loading");
    expect(batch.questions).toHaveProperty("empty_results");
    expect(options).toMatchObject({ agentId: "requesting-agent", purpose: "browser.judge" });
    expect(result.details).toMatchObject({ targetId: "canonical-tab", judgment: outcome });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PAGE_BODY");
    expect(result.details).not.toHaveProperty("usable");
    expect(result.details).not.toHaveProperty("reason");
  });
});
