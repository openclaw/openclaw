import { describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

async function inspectKitchenSink(diagnosticSource?: "list" | "inspect") {
  const scenario = readQaScenarioById("kitchen-sink-live-openai");
  const config = scenario.execution.config as {
    pluginId: string;
    channelId: string;
    expectedProviderAny: string[];
    expectedToolAny: string[];
    expectedSurfaceIds: Record<string, string[]>;
  };
  const diagnostics = [
    { level: "error", message: "memory prompt preparation registration missing prepare function" },
  ];
  const inspect = {
    plugin: {
      id: config.pluginId,
      enabled: true,
      status: "loaded",
      channelIds: [config.channelId],
      providerIds: config.expectedProviderAny,
      contracts: { tools: config.expectedToolAny },
      ...config.expectedSurfaceIds,
      hookCount: 30,
    },
    commands: ["kitchen"],
    services: ["kitchen-sink-service"],
    typedHooks: Array.from({ length: 30 }, (_, index) => `hook-${index}`),
    diagnostics: diagnosticSource === "inspect" ? diagnostics : [],
  };
  const step = scenario.execution.flow?.steps[0];
  if (!step) {
    throw new Error("Kitchen Sink installation flow is missing");
  }
  return await runLoadedScenarioFlow(scenario.id, {
    flow: { steps: [step] },
    api: {
      env: { gateway: { configPath: "/qa/openclaw.json" } },
      fs: { readFile: async () => "{}", writeFile: async () => undefined },
      runQaCli: async (_env: unknown, args: string[]) => {
        switch (args[1]) {
          case "install":
          case "enable":
            return undefined;
          case "list":
            return { diagnostics: diagnosticSource === "list" ? diagnostics : [] };
          case "inspect":
            return inspect;
          default:
            throw new Error(`unexpected Kitchen Sink command: ${args.join(" ")}`);
        }
      },
    },
  });
}

describe("Kitchen Sink conformance evidence", () => {
  it("accepts an inspection with all surfaces and no registration errors", async () => {
    await expect(inspectKitchenSink()).resolves.toMatchObject({ status: "pass" });
  });

  it.each(["list", "inspect"] as const)(
    "rejects adversarial-only registration errors in conformance %s output",
    async (source) => {
      await expect(inspectKitchenSink(source)).rejects.toThrow(
        "Kitchen Sink conformance personality emitted unexpected diagnostics",
      );
    },
  );
});

const ADVERSARIAL_CANARIES = [
  "agent tool result middleware must be a function",
  'agent harness "kitchen-sink-agent-harness" registration missing required runtime methods',
  'channel "kitchen-sink-channel-probe" registration missing or invalid required capabilities.chatTypes',
  "trusted tool policy registration requires id, description, and evaluate()",
  "session scheduler job registration requires unique id, sessionKey, and kind",
  "plugin must declare contracts.tools for: kitchen-sink-tool",
];
const PUBLISHED_INVALID_REGISTRATION_DIAGNOSTICS = [
  "invalid widget presenter registration",
  "worker provider registration missing method: resolveAllocation",
  "MCP server connection resolver registration missing serverName or resolve",
];

async function inspectAdversarialKitchenSink(messages: string[]) {
  const scenario = readQaScenarioById("kitchen-sink-live-openai");
  const step = scenario.execution.flow?.steps.at(-1);
  if (!step) {
    throw new Error("Kitchen Sink adversarial flow is missing");
  }
  return await runLoadedScenarioFlow(scenario.id, {
    flow: { steps: [step] },
    api: {
      env: {
        gateway: {
          restartAfterStateMutation: async (
            mutate: (context: { configPath: string }) => Promise<void>,
          ) => await mutate({ configPath: "/qa/openclaw.json" }),
        },
      },
      fs: { readFile: async () => "{}", writeFile: async () => undefined },
      runQaCli: async (_env: unknown, args: string[]) => {
        expect(args.slice(0, 2)).toEqual(["plugins", "inspect"]);
        return { diagnostics: messages.map((message) => ({ level: "error", message })) };
      },
    },
  });
}

describe("Kitchen Sink adversarial evidence", () => {
  it("accepts published invalid registration probes with every stable canary", async () => {
    await expect(
      inspectAdversarialKitchenSink([
        ...ADVERSARIAL_CANARIES,
        ...PUBLISHED_INVALID_REGISTRATION_DIAGNOSTICS,
      ]),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("rejects unknown errors alongside approved adversarial probes", async () => {
    await expect(
      inspectAdversarialKitchenSink([
        ...ADVERSARIAL_CANARIES,
        ...PUBLISHED_INVALID_REGISTRATION_DIAGNOSTICS,
        "unexpected plugin registration failure",
      ]),
    ).rejects.toThrow("Kitchen Sink adversarial diagnostics contained unapproved messages");
  });

  it("rejects adversarial probes when a stable diagnostic canary disappears", async () => {
    await expect(
      inspectAdversarialKitchenSink([
        ...ADVERSARIAL_CANARIES.slice(1),
        ...PUBLISHED_INVALID_REGISTRATION_DIAGNOSTICS,
      ]),
    ).rejects.toThrow("Kitchen Sink adversarial diagnostics missing required canaries");
  });
});
