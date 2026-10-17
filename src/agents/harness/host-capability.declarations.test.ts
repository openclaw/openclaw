import { afterEach, expect, it } from "vitest";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { isEmbeddedMode, setEmbeddedMode } from "../../infra/embedded-mode.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import {
  createNamedToolEntry,
  createToolRegistry,
} from "../../plugins/tools.optional.test-helpers.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
});

async function surface(
  senderIsOwner: boolean,
  deny: string[] = [],
  overrides: Parameters<
    NonNullable<AgentHarnessHostCapabilities["createToolSurfaceAsync"]>
  >[0] = {},
) {
  const config = {
    tools: { profile: "full" as const, deny },
    ...overrides.config,
  };
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: `declarations-${senderIsOwner}-${deny.join("-")}`,
    agentId: "main",
    sessionKey: "agent:main:declarations",
    senderIsOwner,
    config,
  });
  cleanups.push(host.closeAdmission, host.closeHost);
  const tools = await host.hostCapabilities.createToolSurfaceAsync!({
    config,
    senderIsOwner,
    sessionKey: "agent:main:declarations",
    agentId: "main",
    messageProvider: "discord",
    includeCoreTools: true,
    ...overrides,
  });
  return { ...host, tools };
}

it("projects fresh core declarations without granting private execution", async () => {
  const options = {
    clientCaps: ["ui-commands"],
    modelHasVision: true,
    senderId: "synthetic-owner",
  };
  const owner = await surface(true, [], options);
  const privateTurn = await surface(false, [], options);
  expect(privateTurn.tools.map((tool) => tool.name)).not.toContain("conversations_send");
  const read = privateTurn.hostCapabilities.readCoreToolDeclarations;
  expect(read).toBeTypeOf("function");
  const declarations = read!(privateTurn.tools);
  expect(declarations).toEqual(owner.hostCapabilities.readCoreToolDeclarations!(owner.tools));
  expect(declarations.map((tool) => tool.name)).toEqual(
    expect.arrayContaining([
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "sessions",
      "sessions_send",
      "gateway",
      "plugins",
      "automations",
      "mobile_ui",
      "nodes",
      "openclaw",
      "portal",
      "terminal",
      "computer",
      "screen",
      "exec",
      "process",
    ]),
  );
  for (const declaration of declarations) {
    expect(Object.keys(declaration).toSorted()).toEqual(
      ["openclaw", "computer"].includes(declaration.name)
        ? ["catalogMode", "description", "name", "parameters"]
        : ["description", "name", "parameters"],
    );
    const executable = owner.tools.find((tool) => tool.name === declaration.name)!;
    expect(declaration).toEqual({
      name: executable.name,
      description: executable.description,
      parameters: executable.parameters,
      ...(executable.catalogMode ? { catalogMode: executable.catalogMode } : {}),
    });
    expect(structuredClone(declaration)).toEqual(declaration);
    expect(Object.isFrozen(declaration)).toBe(true);
  }
  const sessions = privateTurn.tools.find((tool) => tool.name === "sessions")!;
  await expect(
    sessions.execute("private-patch", { action: "patch", label: "synthetic" }),
  ).rejects.toThrow();
  expect(declarations.find((tool) => tool.name === "sessions")?.parameters).toHaveProperty(
    "properties.action.enum",
    expect.arrayContaining(["patch", "reset", "delete"]),
  );
  expect(declarations.find((tool) => tool.name === "openclaw")).toHaveProperty(
    "catalogMode",
    "direct-only",
  );
  expect(privateTurn.tools.map((tool) => tool.name)).not.toContain("portal");
  privateTurn.closeHost();
  expect(() => read!(privateTurn.tools)).toThrow(/active|closed/);
});

it("keeps transcript registration across caller-provenance changes without publishing an executor", async () => {
  const owner = await surface(true, [], { senderId: "synthetic-owner" });
  const internal = await surface(false, [], { senderId: undefined });
  const declaration = (host: Awaited<ReturnType<typeof surface>>) =>
    host.hostCapabilities.readCoreToolDeclarations!(host.tools).find(
      (tool) => tool.name === "transcripts",
    );
  expect(owner.tools.some((tool) => tool.name === "transcripts")).toBe(true);
  expect(internal.tools.some((tool) => tool.name === "transcripts")).toBe(false);
  expect(declaration(internal)).toEqual(declaration(owner));
  expect(declaration(internal)).toHaveProperty("parameters.properties.action");
  const disabled = await surface(false, [], { config: { transcripts: { enabled: false } } });
  const denied = await surface(false, ["transcripts"]);
  expect(declaration(disabled)).toBeUndefined();
  expect(declaration(denied)).toBeUndefined();
});

it("retains configured denies and rejects foreign surfaces and revoked admissions", async () => {
  const denied = ["conversations_send", "portal", "openclaw", "exec"];
  const host = await surface(false, denied);
  const read = host.hostCapabilities.readCoreToolDeclarations;
  expect(read).toBeTypeOf("function");
  for (const name of denied) {
    expect(read!(host.tools).map((tool) => tool.name)).not.toContain(name);
    expect(host.tools.map((tool) => tool.name)).not.toContain(name);
  }
  expect(() => read!([...host.tools])).toThrow();
  host.closeAdmission();
  expect(() => read!(host.tools)).toThrow(/active|closed/);
});

it("keeps real plugin factory identity and never projects a core-name plugin replacement", async () => {
  const identities: unknown[] = [];
  const registry = createToolRegistry([
    createNamedToolEntry("declaration-probe", "sessions", {
      factory: (context) => {
        if (!context || typeof context !== "object" || !("senderIsOwner" in context)) {
          throw new Error("missing sender");
        }
        identities.push(context.senderIsOwner);
        return {
          name: "sessions",
          label: "Plugin sessions",
          description: `Plugin sender: ${String(context.senderIsOwner)}`,
          parameters: { type: "object", properties: { plugin: { type: "boolean" } } },
          execute: async () => ({ content: [], details: {} }),
        };
      },
    }),
  ]) as PluginRegistry;
  const config = {
    plugins: { enabled: true, allow: ["declaration-probe"] },
    tools: { allow: ["sessions"] },
  };
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "declaration-probe",
        contracts: { tools: ["sessions"] },
        enabledByDefault: true,
        source: "/tmp/declaration-probe.js",
        rootDir: "/tmp",
      },
    ],
  });
  setPluginRuntimeLoadContext(registry, {
    config,
    rawConfig: config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: undefined,
    env: process.env,
    metadataSnapshot,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    logger: { info() {}, warn() {}, error() {} },
  });
  for (const senderIsOwner of [true, false, true]) {
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: `plugin-${identities.length}`,
      config,
      senderIsOwner,
    });
    cleanups.push(host.closeAdmission, host.closeHost);
    const tools = await withPluginRuntimeRegistryScope(registry, () =>
      host.hostCapabilities.createToolSurfaceAsync!({
        config,
        senderIsOwner,
        includeCoreTools: false,
      }),
    );
    expect(tools.map((tool) => tool.name)).toEqual(["sessions"]);
    expect(tools[0]?.description).toBe(`Plugin sender: ${senderIsOwner}`);
    expect(host.hostCapabilities.readCoreToolDeclarations!(tools)).toEqual([]);
    expect(identities.at(-1)).toBe(senderIsOwner);
  }
  expect(identities).toEqual([true, false, true]);
});

it("rejects retained declaration readers after lifecycle rotation", async () => {
  const host = await surface(false);
  const read = host.hostCapabilities.readCoreToolDeclarations!;
  expect(read(host.tools).length).toBeGreaterThan(0);
  rotateAgentRunRegistryLifecycleGeneration();
  expect(() => read(host.tools)).toThrow(/active|closed/);
});

it("keeps screen declarations across client capabilities without granting execution", async () => {
  const declaration = (host: Awaited<ReturnType<typeof surface>>) =>
    host.hostCapabilities.readCoreToolDeclarations!(host.tools).find(
      (tool) => tool.name === "screen",
    );
  const withoutClient = await surface(true);
  const withoutClientDeclaration = declaration(withoutClient);
  expect(withoutClientDeclaration).toBeDefined();
  expect(withoutClient.tools.some((tool) => tool.name === "screen")).toBe(false);
  const withClient = await surface(true, [], { clientCaps: ["ui-commands"] });
  expect(declaration(withClient)).toEqual(withoutClientDeclaration);
  expect(withClient.tools.some((tool) => tool.name === "screen")).toBe(true);
  const denied = await surface(true, ["screen"], { clientCaps: ["ui-commands"] });
  expect(declaration(denied)).toBeUndefined();
  expect(denied.tools.some((tool) => tool.name === "screen")).toBe(false);
});

it("retains model, sandbox, transport and embedded declaration availability", async () => {
  const names = async (options: Parameters<typeof surface>[2] = {}) => {
    const host = await surface(false, [], options);
    return host.hostCapabilities.readCoreToolDeclarations!(host.tools).map((tool) => tool.name);
  };
  expect(await names()).toContain("screen");
  expect(await names({ clientCaps: ["ui-commands"] })).toContain("screen");
  expect(await names({ modelHasVision: false })).not.toContain("computer");
  expect(await names({ computerTransport: null })).not.toContain("computer");
  expect(await names({ messageProvider: "node" })).toEqual([]);
  const sandbox = createSandboxTestContext();
  sandbox.fsBridge = createHostSandboxFsBridge(sandbox.workspaceDir);
  const sandboxed = await names({ sandbox });
  for (const name of ["portal", "terminal", "openclaw"]) {
    expect(sandboxed).not.toContain(name);
  }
  const embedded = isEmbeddedMode();
  cleanups.push(() => setEmbeddedMode(embedded));
  setEmbeddedMode(true);
  const embeddedHost = await surface(false);
  expect(
    embeddedHost.hostCapabilities.readCoreToolDeclarations!(embeddedHost.tools).map(
      (tool) => tool.name,
    ),
  ).toEqual(["exec", "process", "transcripts"]);
  expect(embeddedHost.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["exec", "process"]),
  );
});

it("retains declaration delegation restrictions and fresh execution-policy descriptions", async () => {
  const normal = await surface(false);
  const normalDescription = normal.hostCapabilities.readCoreToolDeclarations!(normal.tools).find(
    (tool) => tool.name === "openclaw",
  )?.description;
  const reportOnly = await surface(false, [], { delegationCapability: "report_only" });
  const read = (host: Awaited<ReturnType<typeof surface>>) =>
    host.hostCapabilities.readCoreToolDeclarations!(host.tools);
  expect(read(reportOnly).map((tool) => tool.name)).not.toContain("openclaw");
  expect(read(reportOnly).map((tool) => tool.name)).not.toContain("sessions_send");
  expect(read(reportOnly).map((tool) => tool.name)).toContain("automations");
  const restricted = await surface(false, [], {
    config: { tools: { profile: "full", exec: { mode: "ask" } } },
  });
  expect(read(restricted).find((tool) => tool.name === "openclaw")?.description).toContain(
    "Changes wait for the user to approve",
  );
  expect(read(restricted).find((tool) => tool.name === "openclaw")?.description).not.toBe(
    normalDescription,
  );
  expect(() => read(normal)).toThrow(/active|closed/);
});

it("keeps current runtime caps and refreshes cross-tool descriptions after configured denial", async () => {
  const initial = await surface(false);
  const denied = await surface(false, ["conversations_turn"]);
  const initialDeclarations = initial.hostCapabilities.readCoreToolDeclarations!(initial.tools);
  const deniedDeclarations = denied.hostCapabilities.readCoreToolDeclarations!(denied.tools);
  expect(deniedDeclarations.map((tool) => tool.name)).not.toContain("conversations_turn");
  expect(deniedDeclarations.find((tool) => tool.name === "sessions_send")?.description).not.toBe(
    initialDeclarations.find((tool) => tool.name === "sessions_send")?.description,
  );
  const shellDenied = await surface(false, ["automations", "process"]);
  const shellDeclarations = shellDenied.hostCapabilities.readCoreToolDeclarations!(
    shellDenied.tools,
  );
  expect(shellDeclarations.map((tool) => tool.name)).not.toContain("process");
  const exec = shellDeclarations.find((tool) => tool.name === "exec")!;
  expect(exec.description).not.toContain("automations");
  expect(exec.description).toContain("wait for completion");
  expect(exec.parameters).not.toHaveProperty("properties.background");
  expect(exec.parameters).not.toHaveProperty("properties.yieldMs");
  expect(initialDeclarations.find((tool) => tool.name === "exec")?.parameters).toHaveProperty(
    "properties.background",
  );
  const auto = await surface(false, [], {
    config: { tools: { profile: "full", exec: { mode: "auto" } } },
  });
  expect(
    auto.hostCapabilities.readCoreToolDeclarations!(auto.tools).find((tool) => tool.name === "exec")
      ?.description,
  ).toContain("An automatic reviewer may deny a command");
  const capped = await surface(false, [], {
    runtimeToolAllowlist: ["sessions"],
    inheritRuntimeToolAllowlist: true,
  });
  expect(
    capped.hostCapabilities.readCoreToolDeclarations!(capped.tools).map((tool) => tool.name),
  ).toEqual(["sessions"]);
});
