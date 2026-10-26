import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveEmbeddedAttemptToolConstructionPlan } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { createOpenClawOnlyToolConstructionPlan } from "./test-helpers/tool-construction-plan.js";
import * as gateway from "./tools/in-process-gateway.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));
beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

function widget(tools: ReturnType<typeof createOpenClawTools>) {
  return tools.find((candidate) => candidate.name === "show_widget");
}
function createWidget(options: Parameters<typeof createOpenClawTools>[0]) {
  return widget(createOpenClawTools(options));
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
    expect(createWidget({ agentSessionKey, pinnedWidgetAuthoring: true })).toBeUndefined();
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
  expect(
    createWidget({
      agentSessionKey: "agent:main:dashboard:scheduled",
      gatewayCallerScheduled: true,
      ...options,
    }),
  ).toBeUndefined();
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
  const tool = createWidget({
    agentSessionKey: "agent:main:dashboard:scheduled",
    gatewayCallerScheduled: true,
    runtimeToolAllowlist: ["show_widget"],
    clientCaps: ["inline-widgets"],
  });
  expect(tool).toMatchObject({ requiredClientCaps: ["inline-widgets"] });
  expect(tool?.parameters).not.toMatchObject({ required: expect.arrayContaining(["pin"]) });
});

it("pins from a recovered turn that keeps the session's inline widget catalog", async () => {
  const agentSessionKey = "agent:main:dashboard:recovered";
  const recorded = createWidget({ agentSessionKey, clientCaps: ["inline-widgets"] });
  const recovered = createWidget({
    agentSessionKey,
    pinnedWidgetAuthoring: true,
    listingClientCaps: ["inline-widgets"],
    clientCaps: [],
  });
  expect(recovered?.parameters).toEqual(recorded?.parameters);
  expect(recovered?.description).toBe(recorded?.description);
  const put = vi.spyOn(gateway, "callInProcessGatewayTool").mockResolvedValue({
    widgets: [{ name: "status", tabId: "main", grantState: "none" }],
    resolvedWidgetName: "status",
  });
  const call = { title: "Status", name: "status", widget_code: "<p>ready</p>" };

  const pinned = await recovered!.execute("pin-call", { ...call, pin: true });
  expect(put).toHaveBeenCalledWith(
    "board.widget.put",
    expect.objectContaining({ sessionKey: agentSessionKey, name: "status" }),
  );
  expect(pinned.content[0]).toMatchObject({ text: expect.stringContaining('"status": "pinned"') });
  await expect(recovered!.execute("inline-call", call)).rejects.toThrow(
    "no connected client can show inline widgets this turn; set pin=true",
  );
});
