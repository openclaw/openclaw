import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { assert, describe, expect, it } from "vitest";
import { planGrokAutomations } from "./automations.js";
import type { GrokSourceInventory } from "./source/types.js";

const ctx: MigrationProviderContext = {
  config: {},
  stateDir: "/migration-test",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
const agentTargets = new Map([
  ["bot-1", { agentId: "grok-bot", agentDir: "/agent", workspaceDir: "/workspace" }],
]);

function inventory(record: Record<string, unknown>): GrokSourceInventory {
  return {
    source: "/grok-export",
    kind: "snapshot",
    settings: { status: "complete", value: { userTimeZone: "Europe/London" } },
    agents: {
      status: "complete",
      value: [
        {
          id: "bot-1",
          name: "Research",
          instructions: "Research carefully.",
          memory: { status: "complete", value: [] },
          skills: { status: "complete", value: [] },
          plugins: { status: "complete", value: [] },
          automations: {
            status: "complete",
            value: [{ id: "daily", name: "Daily report", record: structuredClone(record) }],
          },
        },
      ],
    },
    mcpServers: { status: "complete", value: [] },
    credentials: [],
    issues: [],
  };
}

const cron = {
  prompt: "Review the research backlog.",
  trigger: { type: "cron", schedule: "30 8 * * 1-5" },
  isEnabled: false,
};

describe("Grok automation migration", () => {
  it("preserves explicit timing, timezone, target and disabled state with stable retry identity", async () => {
    const source = inventory(cron);
    const automation = source.agents.value[0]?.automations.value[0];
    assert(automation, "Expected the source automation fixture");
    const [item] = await planGrokAutomations({ inventory: source, ctx, agentTargets });
    assert(item, "Expected the translated automation");
    expect(item).toMatchObject({
      kind: "automation",
      action: "create-cron",
      status: "planned",
      applyPhase: "after-promotion",
      details: {
        sourceAgentId: "bot-1",
        job: {
          agentId: "grok-bot",
          name: "Daily report",
          enabled: false,
          message: "Review the research backlog.",
          schedule: { kind: "cron", expr: "30 8 * * 1-5", tz: "Europe/London" },
        },
      },
    });
    automation.name = "Renamed report";
    const [renamed] = await planGrokAutomations({ inventory: source, ctx, agentTargets });
    assert(renamed, "Expected the renamed automation");
    expect(renamed.id).toBe(item.id);
    automation.record.isEnabled = true;
    const [enabledSource, review] = await planGrokAutomations({
      inventory: source,
      ctx,
      agentTargets,
    });
    expect(enabledSource).toMatchObject({
      details: { sourceEnabled: true, job: { enabled: false } },
    });
    expect(review).toMatchObject({
      kind: "manual",
      status: "skipped",
      message: expect.stringContaining("permissions and delivery"),
    });
  });

  it("keeps unsupported triggers, unresolved plugin dependencies, and unknown timezone out of the scheduler", async () => {
    const pluginDependent = inventory(cron);
    const agent = pluginDependent.agents.value[0];
    assert(agent, "Expected the source agent fixture");
    agent.plugins.value.push({
      name: "Grok mail",
      pluginId: "cloud-mail",
    });
    const missingZone = inventory(cron);
    missingZone.settings.value = {};
    for (const source of [
      inventory({ ...cron, trigger: { type: "event", event: "email" } }),
      pluginDependent,
      missingZone,
    ]) {
      const items = await planGrokAutomations({ inventory: source, ctx, agentTargets });
      expect(items).toEqual([expect.objectContaining({ kind: "manual", status: "skipped" })]);
    }
  });
});
