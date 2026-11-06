import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMcpLoopbackPolicyTools,
  resolveMcpLoopbackScopedTools as resolveScopedTools,
} from "../../gateway/mcp-http.runtime.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { execSchema } from "../bash-tools.schemas.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createCliRunnerPrepareFixture } from "../cli-runner.test-helpers.js";
import { mockCliMcpPreparation } from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import { resetCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
  buildAnthropicCliBackend: () => CliBackendPlugin;
}>({ pluginId: "anthropic", artifactBasename: "api.js" });

const searchTool = {
  name: "web_search",
  label: "Search",
  description: "Search",
  parameters: { type: "object", properties: {} },
  execute: vi.fn(),
};
const messageTool = { ...searchTool, name: "message", label: "Message" };
const nodeExecution = vi.fn();
type ExecTarget = { host?: string; node?: string };
function execTool(defaults: ExecTarget = {}) {
  return {
    ...searchTool,
    name: "exec",
    parameters: execSchema,
    execute: async (_id: string, params: unknown) => {
      if (defaults.host !== "node") {
        throw new Error("Gateway-local execution is forbidden in this node-only proof");
      }
      nodeExecution(defaults, params);
      return { content: [{ type: "text", text: "node execution" }] };
    },
  };
}
// mock-isolation: Exercise CLI search authority with inert host tools.
vi.mock("../openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async ({ config }: { config: OpenClawConfig }) =>
    config.tools?.web?.search?.enabled === false ? [messageTool] : [searchTool, messageTool],
}));
// mock-isolation: Observe node-only execution without assembling unrelated coding tools.
vi.mock("../agent-tools.js", () => ({
  createOpenClawCodingToolsInternalAsync: async ({ exec }: { exec?: ExecTarget }) => [
    execTool(exec),
  ],
}));
// mock-isolation: Keep command execution on the inert node-only tool used by this authority fixture.
vi.mock("../bash-tools.js", () => ({ createExecTool: execTool }));
vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: async (method: string) => {
    if (method === "node.list") {
      return { nodes: [{ nodeId: "worker", connected: true, commands: ["system.run"] }] };
    }
    if (method === "computer.status") {
      return { configured: false, available: false };
    }
    throw new Error(`Unexpected Gateway I/O: ${method}`);
  },
}));
let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
const nativeAuthority = vi.fn((_tools: readonly string[] | null) => true);
let mintGrant: ReturnType<typeof mockCliMcpPreparation>["mint"];

beforeEach(() => {
  vi.clearAllMocks();
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: () => undefined,
    resolveRuntimeCliBackends: () => [{ ...buildAnthropicCliBackend(), pluginId: "anthropic" }],
  });
  ({ mint: mintGrant } = mockCliMcpPreparation({
    activateMcpLoopbackClientGrantCapture: () => ({ captureNativeToolAuthority: nativeAuthority }),
    resolveMcpLoopbackPolicyTools,
    resolveMcpLoopbackScopedTools: resolveScopedTools,
  }));
  fixture = createCliRunnerPrepareFixture((params) =>
    prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
  );
});
afterEach(async () => {
  resetCliRunnerPrepareTestDeps();
  cliBackendsTesting.resetDepsForTest();
  await fixture.cleanup();
});

// Columns: mode, config, native search, session search, managed search, explicit tools.
it.each<[string, OpenClawConfig, boolean, boolean, boolean, string[]?]>([
  ["automatic", {}, true, true, true],
  ["pinned provider", { tools: { web: { search: { provider: "brave" } } } }, false, true, true],
  ["global off", { tools: { web: { search: { enabled: false } } } }, false, true, false],
  ["session off", {}, false, false, false, ["exec", "web_search", "message"]],
])(
  "keeps registered Claude CLI native authority consistent with %s",
  async (_name, config, native, sessionSearch, managed, openClaw) => {
    const cfg: OpenClawConfig = {
      ...config,
      plugins: { enabled: false },
      tools: {
        ...config.tools,
        allow: ["exec", "web_search", "message"],
        exec: { host: openClaw ? "auto" : "node", mode: "full" },
      },
    };
    const { preparedBackend, systemPromptReport } = await fixture.prepare({
      provider: "claude-cli",
      config: cfg,
      senderIsOwner: true,
      toolOverrides: { webSearch: sessionSearch },
      model: "fixture-model",
      ...(openClaw ? { cliToolAvailability: { native: ["Read", "WebSearch"], openClaw } } : {}),
    });
    try {
      const capture = expectDefined(preparedBackend.mcpClientGrantCapture, "capture");
      capture.activate("fixture-capture", () => {});
      capture.captureNativeTools?.(["Read", "WebSearch"]);
      expect(nativeAuthority).toHaveBeenLastCalledWith(native ? ["read", "web_search"] : ["read"]);
      const argv = preparedBackend.backend.args ?? [];
      const denied = argv[argv.indexOf("--disallowedTools") + 1] ?? "";
      expect(denied.split(",").includes("WebSearch")).toBe(!native);
      const promptTools = systemPromptReport.tools.entries.map((tool) => tool.name);
      expect.soft(promptTools.includes("web_search")).toBe(managed);
      expect(promptTools).toContain("message");
      const grant = expectDefined(mintGrant.mock.calls[0]?.[0]?.context, "grant");
      expect.soft(grant.toolsAllow).toEqual(openClaw);
      const { tools } = await resolveScopedTools({
        cfg,
        context: grant,
        isGrantCurrent: () => true,
      });
      expect(tools.some((tool) => tool.name === "web_search")).toBe(managed);
      const execution = tools.find((tool) => tool.name === "exec");
      const exec = expectDefined(execution, "exec");
      if (openClaw) {
        expect(exec.parameters).toMatchObject({
          properties: { host: { enum: expect.arrayContaining(["gateway"]) } },
        });
      } else {
        expect.soft(exec.parameters).toMatchObject({ properties: { host: { enum: ["node"] } } });
        await exec.execute("node-proof", { command: "node-proof" }, new AbortController().signal);
        expect(nodeExecution).toHaveBeenCalledWith(expect.objectContaining({ host: "node" }), {
          command: "node-proof",
        });
      }
    } finally {
      await preparedBackend.cleanup?.();
    }
  },
);
