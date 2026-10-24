import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

function widget(tools: ReturnType<typeof createOpenClawTools>) {
  return tools.find((candidate) => candidate.name === "show_widget");
}

function expectPinnedOnlySchema(tools: ReturnType<typeof createOpenClawTools>): void {
  expect(widget(tools)?.requiredClientCaps).toBeUndefined();
  expect(widget(tools)).toMatchObject({
    parameters: { required: expect.arrayContaining(["pin"]), properties: { pin: { const: true } } },
  });
}

it.each([undefined, "agent:main:cron:job:run:detached"])(
  "requires a persistent session for recovered authoring (%s)",
  (agentSessionKey) => {
    const tools = createOpenClawTools({ agentSessionKey, pinnedWidgetAuthoring: true });
    expect(widget(tools)).toBeUndefined();
  },
);

it("applies tool policy to recovered dashboard authoring", () => {
  const options = {
    sessionKey: "agent:main:dashboard:recovered",
    pinnedWidgetAuthoring: true,
    toolConstructionPlan: createOpenClawOnlyToolConstructionPlan(),
  };
  expectPinnedOnlySchema(createOpenClawCodingTools(options));
  const deniedTools = createOpenClawCodingTools({
    ...options,
    config: { tools: { deny: ["show_widget"] } },
  });
  expect(widget(deniedTools)).toBeUndefined();
});

it.each([
  {},
  {
    runtimeToolAllowlist: ["show_widget"],
    config: { tools: { deny: ["show_widget"] } },
  },
])("applies scheduled widget capability and deny policy: %j", (options) => {
  const tools = createOpenClawTools({
    agentSessionKey: "agent:main:dashboard:scheduled",
    gatewayCallerScheduled: true,
    ...options,
  });

  expect(widget(tools)).toBeUndefined();
});

it("lets a server-authorized canvas cap select pinned widget authoring", () => {
  const toolsAllow = ["canvas"];
  const plan = resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow });
  const tools = createOpenClawCodingTools({
    sessionKey: "agent:main:dashboard:scheduled",
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    runtimeToolAllowlist: plan.runtimeToolAllowlist,
    includeCoreTools: plan.includeCoreTools,
    config: { tools: { allow: toolsAllow } },
    toolConstructionPlan: plan.codingToolConstructionPlan,
  });

  expectPinnedOnlySchema(tools);
});

it("keeps scheduled turns with a real inline client on the normal widget surface", () => {
  const tool = widget(
    createOpenClawTools({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
      runtimeToolAllowlist: ["show_widget"],
      clientCaps: ["inline-widgets"],
    }),
  );
  expect(tool).toMatchObject({ requiredClientCaps: ["inline-widgets"] });
  expect(tool?.parameters).not.toMatchObject({ required: expect.arrayContaining(["pin"]) });
});
