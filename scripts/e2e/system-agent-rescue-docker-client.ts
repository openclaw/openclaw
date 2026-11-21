// OpenClaw rescue-message Docker harness.
// Imports packaged dist modules so the Docker lane verifies the npm tarball,
// while this small test driver stays mounted from the checkout.
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { mock } from "node:test";
import type { OpenClawConfig } from "../../dist/config/types.openclaw.js";
import { createE2eStateDir } from "./lib/temp-state-dir.ts";

// This lane proves persistence and approval, not live provider credentials.
const inference = await import("../../dist/system-agent/setup-inference.js");
let inferenceChecks = 0;
const verifySetupInferenceConfig: typeof inference.verifySetupInferenceConfig = async () => {
  inferenceChecks += 1;
  return { ok: true, modelRef: "openai/gpt-5.2", latencyMs: 1 };
};
const inferenceMock = mock.module(
  new URL("../../dist/system-agent/setup-inference.js", import.meta.url).href,
  { namedExports: { ...inference, verifySetupInferenceConfig } },
);
const { handleSystemAgentCommand } =
  await import("../../dist/auto-reply/reply/commands-system-agent.js");
const { clearConfigCache } = await import("../../dist/config/config.js");
const { createSqliteAuditRecordStore } =
  await import("../../dist/infra/sqlite-audit-record-store.js");
const { SYSTEM_AGENT_AUDIT_MAX_ENTRIES, SYSTEM_AGENT_AUDIT_SCOPE } =
  await import("../../dist/system-agent/audit.js");
const { runSystemAgentRescueMessage } = await import("../../dist/system-agent/rescue-message.js");
type SystemAgentAuditEntry = import("../../dist/system-agent/audit.js").SystemAgentAuditEntry;

type CommandResult = Awaited<ReturnType<typeof handleSystemAgentCommand>>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeParams(commandBody: string, cfg: OpenClawConfig, isGroup = false) {
  return {
    cfg,
    command: {
      surface: "whatsapp",
      channel: "whatsapp",
      channelId: "whatsapp",
      accountId: "default",
      ownerList: ["user:owner"],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "user:owner",
      rawBodyNormalized: commandBody,
      commandBodyNormalized: commandBody,
      from: "user:owner",
      to: "account:default",
    },
    agentId: "default",
    isGroup,
  } as Parameters<typeof handleSystemAgentCommand>[0];
}

async function invoke(commandBody: string, cfg: OpenClawConfig, isGroup = false): Promise<string> {
  const result: CommandResult = await handleSystemAgentCommand(
    makeParams(commandBody, cfg, isGroup),
    true,
  );
  assert(result, `Command was not handled: ${commandBody}`);
  assert(!result.shouldContinue, `Command should stop normal agent dispatch: ${commandBody}`);
  const text = result.reply?.text;
  assert(typeof text === "string", `Command did not return text: ${commandBody}`);
  return text;
}

async function invokeRescue(commandBody: string, cfg: OpenClawConfig): Promise<string> {
  const result = await runSystemAgentRescueMessage({
    cfg,
    command: makeParams(commandBody, cfg).command,
    commandBody,
    agentId: "default",
    isGroup: false,
  });
  assert(typeof result === "string", `Direct rescue command did not return text: ${commandBody}`);
  return result;
}

async function main() {
  const tempState = await createE2eStateDir("openclaw-openclaw-");
  tempState.registerExitCleanup();
  const stateDir = tempState.stateDir;
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        meta: { lastTouchedVersion: "docker-e2e" },
        agents: { defaults: {} },
      },
      null,
      2,
    ),
  );
  clearConfigCache();

  const denied = await invoke("/openclaw status", {
    systemAgent: { rescue: { enabled: true } },
    agents: { defaults: { sandbox: { mode: "all" } } },
  });
  assert(denied.includes("sandboxing is active"), "sandboxed rescue was not denied");

  const cfg: OpenClawConfig = {};
  const refusedTui = await invoke("/openclaw talk to agent", cfg);
  assert(
    refusedTui.includes("cannot open the local TUI"),
    "remote rescue TUI handoff was not refused",
  );

  const plan = await invokeRescue("/openclaw set default model openai/gpt-5.2", cfg);
  assert(
    plan.includes("Reply /openclaw yes to apply"),
    "persistent change did not require approval",
  );
  const applied = await invokeRescue("/openclaw yes", cfg);
  assert(applied.includes("Default model: openai/gpt-5.2"), "approved change did not apply");

  const configValid = await invoke("/openclaw validate config", cfg);
  assert(configValid.includes("Config valid:"), "config validation did not report valid config");

  const configSetPlan = await invoke("/openclaw config set gateway.port 19001", cfg);
  assert(
    configSetPlan.includes("Reply /openclaw yes to apply"),
    "generic config set did not require approval",
  );
  const configSetApplied = await invoke("/openclaw yes", cfg);
  assert(configSetApplied.includes("[openclaw] done: config.set"), "generic config set failed");

  const refPlan = await invoke(
    "/openclaw config set-ref gateway.auth.token env OPENCLAW_GATEWAY_TOKEN",
    cfg,
  );
  assert(
    refPlan.includes("Reply /openclaw yes to apply"),
    "SecretRef set did not require approval",
  );
  const refApplied = await invoke("/openclaw yes", cfg);
  assert(refApplied.includes("[openclaw] done: config.setRef"), "SecretRef set failed");

  // Fresh setup chooses the workspace before an authored fleet owns it.
  const setupPlan = await invokeRescue(
    "/openclaw setup workspace /tmp/openclaw-setup model openai/gpt-5.2",
    cfg,
  );
  assert(setupPlan.includes("Reply /openclaw yes to apply"), "setup did not require approval");
  const setupApplied = await invokeRescue("/openclaw yes", cfg);
  assert(setupApplied.includes("[openclaw] done: openclaw.setup"), "setup did not apply");

  const agentPlan = await invoke("/openclaw create agent work workspace /tmp/openclaw-work", cfg);
  assert(
    agentPlan.includes("Reply /openclaw yes to apply"),
    "agent creation did not require approval",
  );
  const agentApplied = await invoke("/openclaw yes", cfg);
  assert(agentApplied.includes("[openclaw] done: agents.create"), "agent creation did not apply");

  const gatewayRestarts: string[] = [];
  const gatewayCommand = makeParams("/openclaw restart gateway", cfg).command;
  const gatewayHostLifecycle: NonNullable<
    NonNullable<Parameters<typeof runSystemAgentRescueMessage>[0]["deps"]>["gatewayHostLifecycle"]
  > = {
    request: async (action, assertCaller) => {
      assertCaller();
      gatewayRestarts.push(action);
      return { ok: true, value: { outcome: "scheduled" } };
    },
  };
  const runGatewayCommand = (commandBody: string) =>
    runSystemAgentRescueMessage({
      cfg,
      command: gatewayCommand,
      commandBody,
      agentId: "default",
      isGroup: false,
      deps: { setupSurface: "gateway", gatewayHostLifecycle },
    });
  const gatewayPlan = await runGatewayCommand("/openclaw restart gateway");
  assert(
    gatewayPlan?.includes("Reply /openclaw yes to apply"),
    "gateway restart did not require approval",
  );
  const pluginList = await runGatewayCommand("/openclaw plugins list");
  assert(
    pluginList?.includes("Plugins") || pluginList?.includes("No plugins found."),
    "read-only rescue command did not return the packaged plugin inventory",
  );
  const revokedApproval = await runGatewayCommand("/openclaw yes");
  assert(
    revokedApproval === "No pending OpenClaw rescue change is waiting for approval.",
    "fresh rescue command did not revoke the older pending change",
  );
  assert(gatewayRestarts.length === 0, "revoked gateway restart was invoked");
  await runGatewayCommand("/openclaw restart gateway");
  const gatewayApplied = await runGatewayCommand("/openclaw yes");
  assert(
    gatewayApplied?.includes("[openclaw] done: gateway.restart"),
    "gateway restart did not apply",
  );
  assert(gatewayRestarts.length === 1, "gateway host restart was not requested once");
  assert(gatewayRestarts[0] === "restart", "gateway requested the wrong host action");

  const doctorRuns: string[] = [];
  const doctorCommand = makeParams("/openclaw doctor fix", cfg).command;
  // Refusal must not launch the packaged Doctor subprocess.
  const doctorSpawn = mock.method(childProcess, "spawn", () => {
    doctorRuns.push("doctor");
    throw new Error("Remote rescue unexpectedly launched a Doctor subprocess");
  });
  syncBuiltinESMExports();
  let doctorReply: string | null;
  try {
    doctorReply = await runSystemAgentRescueMessage({
      cfg,
      command: doctorCommand,
      commandBody: "/openclaw doctor fix",
      agentId: "default",
      isGroup: false,
    });
  } finally {
    doctorSpawn.mock.restore();
    syncBuiltinESMExports();
  }
  assert(
    doctorReply?.includes("openclaw doctor --fix"),
    "remote doctor fix did not point to the local repair command",
  );
  assert(doctorRuns.length === 0, "remote rescue must not invoke doctor repair");
  assert(inferenceChecks > 0, "packaged inference fixture was not invoked");

  const updatedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  const updatedModel = updatedConfig.agents?.defaults?.model;
  assert(
    (typeof updatedModel === "string" ? updatedModel : updatedModel?.primary) === "openai/gpt-5.2",
    "config default model was not updated",
  );
  assert(updatedConfig.gateway?.port === 19001, "generic config set did not update gateway.port");
  assert(
    updatedConfig.gateway?.auth?.token &&
      typeof updatedConfig.gateway.auth.token === "object" &&
      "id" in updatedConfig.gateway.auth.token &&
      updatedConfig.gateway.auth.token.id === "OPENCLAW_GATEWAY_TOKEN",
    "SecretRef set did not update gateway.auth.token",
  );
  assert(
    updatedConfig.agents?.defaults?.workspace === "/tmp/openclaw-setup",
    "setup did not update default workspace",
  );
  assert(
    updatedConfig.agents?.entries?.work?.workspace === "/tmp/openclaw-work",
    "agent config was not updated",
  );

  const audits = createSqliteAuditRecordStore<SystemAgentAuditEntry>({
    scope: SYSTEM_AGENT_AUDIT_SCOPE,
    maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  })
    .entries()
    .map((entry) => entry.value);
  for (const [operation, message] of [
    ["config.setDefaultModel", "model audit operation missing"],
    ["config.set", "config set audit missing"],
    ["config.setRef", "SecretRef config audit missing"],
    ["openclaw.setup", "setup audit missing"],
  ] as const) {
    assert(
      audits.some((audit) => audit.operation === operation),
      message,
    );
  }
  const agentAudit = audits.find((audit) => audit.operation === "agents.create");
  assert(agentAudit, "agent audit operation missing");
  assert(agentAudit.details?.rescue === true, "audit rescue marker missing");
  assert(agentAudit.details?.channel === "whatsapp", "audit channel missing");
  assert(agentAudit.details?.senderId === "user:owner", "audit sender missing");
  assert(agentAudit.details?.agentId === "work", "audit agent missing");
  assert(
    audits.some((audit) => audit.operation === "gateway.restart"),
    "gateway restart audit operation missing",
  );

  console.log("OpenClaw rescue Docker E2E passed");
}

main()
  .finally(() => inferenceMock.restore())
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
