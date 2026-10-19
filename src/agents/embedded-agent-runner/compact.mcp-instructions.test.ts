import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import {
  buildConfiguredAgentSystemPromptMock,
  createAgentSessionMock,
  createOpenClawCodingToolsMock,
  loadCompactHooksHarness,
  resolveContextEngineMock,
} from "./compact.hooks.harness.js";

const sessionKey = "agent:main:mcp-compaction";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: typeof import("./compact.js").compactEmbeddedAgentSessionDirect;
let configRuntime: typeof import("../../config/runtime-snapshot.js");

beforeAll(async () => {
  ({ compactEmbeddedAgentSessionDirect: compact } = await loadCompactHooksHarness());
  configRuntime = await import("../../config/runtime-snapshot.js");
  await fixture.prepare();
});
afterEach(() => configRuntime.clearRuntimeConfigSnapshot());

it.each([
  { label: "direct", tools: {} },
  { label: "Tool Search", tools: { toolSearch: true } },
  { label: "Code Mode", tools: { codeMode: true } },
])("omits remote server guidance from the $label compaction prompt", async ({ tools }) => {
  const { workspaceDir, sessionId } = await fixture.prepareSession();
  const config = { tools } as OpenClawConfig;
  configRuntime.setRuntimeConfigSnapshot(config);
  const target = {
    name: "research__search",
    label: "search",
    description: "Research search",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  };
  // The harness reloads modules; bind metadata through that same runtime owner.
  const { setPluginToolMeta } = await import("../../plugins/tool-metadata.js");
  setPluginToolMeta(target, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "research",
      safeServerName: "research",
      toolName: "search",
      operation: "tool",
      serverInstructions: "COMPACTION_REMOTE_GUIDANCE " + "detail ".repeat(3_000) + "GUIDANCE_TAIL",
    },
  });
  resolveContextEngineMock.mockResolvedValue({
    info: { ownsCompaction: false },
    compact: delegateCompactionToRuntime,
  } as never);
  createOpenClawCodingToolsMock.mockReturnValue([target]);
  const actual = await vi.importActual<typeof import("../system-prompt-config.js")>(
    "../system-prompt-config.js",
  );
  expect(actual.buildConfiguredAgentSystemPrompt({ workspaceDir, tools: [target] })).toContain(
    "GUIDANCE_TAIL",
  );
  buildConfiguredAgentSystemPromptMock.mockImplementation(actual.buildConfiguredAgentSystemPrompt);
  const result = await compact({
    agentId: "main",
    sessionId,
    sessionKey,
    sessionFile: sessionKey,
    workspaceDir: join(workspaceDir, "workspace"),
    config,
  });
  expect(result).toMatchObject({ ok: true, compacted: true });
  const created = await createAgentSessionMock.mock.results[0]?.value;
  const prompt = created.session.agent.state.systemPrompt ?? "";
  expect(prompt).toContain(target.name);
  expect(prompt).not.toContain("COMPACTION_REMOTE_GUIDANCE");
  expect(prompt).not.toContain("GUIDANCE_TAIL");
});
