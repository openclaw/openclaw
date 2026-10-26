// Source-run with: node --import ./scripts/tsx.mjs scripts/perf/pairing-channel-attribution.mts ...
// Attribution only: --ingress configures pairing but does not assert a denial response.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { resolveOpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { msteamsQaCliRegistration } from "../../extensions/msteams/src/qa/cli.js";
import { createQaBusState } from "../../extensions/qa-lab/src/bus-state.js";
import { createQaCrablineTransportAdapter } from "../../extensions/qa-lab/src/crabline-transport.js";
import { createQaGatewayChild } from "../../extensions/qa-lab/src/gateway-child.js";
import { redactQaGatewayDebugText } from "../../extensions/qa-lab/src/gateway-log-redaction.js";
import { defaultQaModelForMode } from "../../extensions/qa-lab/src/model-selection.js";
import { startQaProviderServer } from "../../extensions/qa-lab/src/providers/server-runtime.js";
import { createQaTransportAdapter } from "../../extensions/qa-lab/src/qa-transport-registry.js";
import type { QaTransportAdapter } from "../../extensions/qa-lab/src/qa-transport.js";
import { gatewayBenchCpuProfileArgs } from "../lib/gateway-bench-runtime.js";
import {
  EXTRA_PAIRING_CHANNELS,
  createExtraPairingTransport,
} from "./pairing-extra-transports.mjs";

const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    output: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    seconds: { type: "string", default: "60" },
    profile: { type: "boolean", default: false },
    ingress: { type: "boolean", default: false },
  },
});
if (!values.channel || !values.output || !values.observer) {
  throw new Error("--channel, --output, and --observer are required");
}
const seconds = Number(values.seconds);
if (!Number.isInteger(seconds) || seconds < 60) {
  throw new Error("--seconds must be an integer >= 60");
}
const tempParentDir = process.env.SQLMEASURE_TEMP_ROOT ?? process.env.TMPDIR;
if (!tempParentDir) {
  throw new Error(
    "Set SQLMEASURE_TEMP_ROOT or TMPDIR to the lane's internal-disk scratch directory",
  );
}
const repoRoot = process.cwd();
const extraChannel = EXTRA_PAIRING_CHANNELS.find((entry) => entry === values.channel);
const selection =
  values.channel === "msteams" || extraChannel
    ? undefined
    : resolveOpenClawCrablineChannelDriverSelection({ channel: values.channel });
const channel = extraChannel ?? selection?.channel ?? "msteams";
const dmPolicy = channel === "line" || channel === "sms" ? "allowlist" : "pairing";
type AttributionChannelConfig = {
  [key: string]: unknown;
  dm?: { [key: string]: unknown };
  accounts?: Record<string, AttributionChannelConfig | undefined>;
};
// Schema owners: Discord/Slack/Telegram/Signal config-schema.ts, Mattermost
// config-schema-core.ts, core zod-schema.providers-whatsapp.ts, Zalo config-schema.ts.
// Those seven use dmPolicy/allowFrom; Matrix config-schema.ts owns nested dm policy.
// Apply the policy to existing account entries too, preserving credentials and transport leaves.
function configurePairing(cfg: OpenClawConfig): OpenClawConfig {
  const current: AttributionChannelConfig = cfg.channels?.[channel] ?? {};
  const applyPolicy = (entry: AttributionChannelConfig): AttributionChannelConfig =>
    channel === "matrix"
      ? { ...entry, dm: { ...entry.dm, enabled: true, policy: "pairing", allowFrom: [] } }
      : { ...entry, dmPolicy, allowFrom: [] };
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...applyPolicy(current),
        ...(current.accounts
          ? {
              accounts: Object.fromEntries(
                Object.entries(current.accounts).map(([id, account]) => [
                  id,
                  account ? applyPolicy(account) : account,
                ]),
              ),
            }
          : {}),
      },
    },
  };
}
const output = path.resolve(values.output);
const sql = path.join(output, "sql");
await mkdir(output, { mode: 0o700 });
await mkdir(sql, { mode: 0o700 });
await mkdir(tempParentDir, { recursive: true, mode: 0o700 });
const phasePath = path.join(sql, "phase");
const phases: Array<{ name: string; startedAt: string; endedAt?: string }> = [];
async function phase(name: string) {
  const now = new Date().toISOString();
  const previous = phases.at(-1);
  if (previous) {
    previous.endedAt = now;
  }
  phases.push({ name, startedAt: now });
  await writeFile(phasePath, name);
}

const gatewayOwner = createQaGatewayChild();
let transport: QaTransportAdapter | undefined;
let mock: Awaited<ReturnType<typeof startQaProviderServer>> | undefined;
let gateway: Awaited<ReturnType<typeof gatewayOwner.start>> | undefined;
let readGatewayLogs: (() => string) | undefined;
const failures: string[] = [];
let processStopped = false;
let gatewayReady = false;
let transportReady = false;
let idleCompleted = false;
let ingressInjected = false;
const summarizeError = (error: unknown) =>
  redactQaGatewayDebugText(error instanceof Error ? error.message : String(error));

try {
  await phase("boot");
  transport = extraChannel
    ? await createExtraPairingTransport(extraChannel, output)
    : selection
      ? await createQaCrablineTransportAdapter({ outputDir: output, selection })
      : (
          await createQaTransportAdapter(
            { channelId: channel, driver: "live", outputDir: output, state: createQaBusState() },
            [msteamsQaCliRegistration.adapterFactory!],
          )
        ).adapter;
  const primaryModel = defaultQaModelForMode("mock-openai");
  mock = await startQaProviderServer("mock-openai", { modelRefs: [primaryModel] });
  if (!mock) {
    throw new Error("Mock provider did not start");
  }
  gateway = await gatewayOwner.start({
    repoRoot,
    command: {
      executablePath: process.execPath,
      argsPrefix: [
        ...gatewayBenchCpuProfileArgs(values.profile ? path.join(output, "profiles") : undefined),
        path.resolve(values.entry),
      ],
      tempParentDir,
    },
    providerMode: "mock-openai",
    providerBaseUrl: `${mock.baseUrl}/v1`,
    primaryModel,
    transport,
    // Crabline owns provider URLs; the generic QA config still needs a local transport URL.
    transportBaseUrl: mock.baseUrl,
    controlUiEnabled: false,
    mutateConfig: values.ingress ? configurePairing : undefined,
    runtimePreloads: transport.createRuntimePreloads?.(),
    onListening: ({ logs }) => {
      readGatewayLogs = logs;
    },
    runtimeEnvPatch: {
      ...transport.createRuntimeEnvPatch?.(),
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values.observer))} --enable-source-maps`,
      SQLMEASURE_OUT: sql,
    },
  });
  gatewayReady = true;
  readGatewayLogs = gateway.logs;
  await transport.waitReady({ gateway, timeoutMs: 60_000 });
  transportReady = true;
  await phase("idle");
  await delay(seconds * 1_000);
  idleCompleted = true;
  // A single readiness RPC after idle confirms the interval was a live Gateway interval.
  await phase("status");
  await gateway.call("channels.status", { probe: false, timeoutMs: 5_000 });
  if (values.ingress) {
    await phase("ingress");
    await transport.prepareFlow?.({
      config: {},
      gateway,
      outputDir: output,
      primaryModel,
      scenarioId: "pairing-channel-attribution",
      scenarioTitle: "Synthetic pairing read attribution",
      timeoutMs: 30_000,
      signal: AbortSignal.timeout(30_000),
      waitForConfigRestartSettle: async () => {
        throw new Error("Attribution fixture does not request config restarts");
      },
    });
    const peerId =
      channel === "whatsapp"
        ? "12025550123@s.whatsapp.net"
        : channel === "slack"
          ? "DPAIRING001"
          : "pairing-attribution";
    // These native bridges bind a direct conversation to its sender identity.
    const senderId = ["telegram", "signal", "mattermost", "whatsapp"].includes(channel)
      ? peerId
      : channel === "slack"
        ? "UPAIRING001"
        : "driver";
    await transport.sendInbound({
      conversation: { id: peerId, kind: "direct" },
      senderId,
      senderName: "Synthetic driver",
      text: "Reply exactly: SYNTHETIC-PAIRING-ATTRIBUTION",
    });
    ingressInjected = true;
    await delay(10_000);
  }
} catch (error) {
  failures.push(summarizeError(error));
} finally {
  await phase("shutdown");
  // Match the QA host's ownership order: quiesce ingress, stop Gateway, then release provider.
  try {
    await transport?.cleanup?.();
  } catch (error) {
    failures.push(`Transport quiesce: ${summarizeError(error)}`);
  }
  try {
    const result = await gatewayOwner.stop({ keepTemp: false });
    processStopped = result.process !== "unconfirmed";
    failures.push(...result.errors.map(summarizeError));
    if (!processStopped) {
      failures.push("Gateway process stop unconfirmed; provider retained");
    }
  } catch (error) {
    failures.push(`Gateway stop: ${summarizeError(error)}`);
  }
  if (processStopped) {
    try {
      await transport?.cleanupAfterGatewayStop?.();
    } catch (error) {
      failures.push(`Provider cleanup: ${summarizeError(error)}`);
    }
    try {
      await mock?.stop();
    } catch (error) {
      failures.push(`Mock cleanup: ${summarizeError(error)}`);
    }
  }
  if (failures.length) {
    await writeFile(
      path.join(output, "gateway.failure.log"),
      readGatewayLogs
        ? redactQaGatewayDebugText(readGatewayLogs())
        : `Gateway did not reach the log-access callback.\n${failures.join("\n")}\n`,
    );
  }
  await phase("done");
}

const summary = {
  channel,
  source: extraChannel
    ? "synthetic-native-wire-channel"
    : selection
      ? "synthetic-crabline-native-channel"
      : "synthetic-bot-framework-channel",
  idleSecondsRequested: seconds,
  gatewayReady,
  transportReady,
  idleCompleted,
  ingressRequested: values.ingress,
  ingressInjected,
  ingressPolicy: values.ingress
    ? `${dmPolicy} with empty configured allowlist`
    : "transport defaults",
  ingressProof:
    "Provider injection only; pairing denial and agent non-execution require separate assertions",
  processStopped,
  gatewayLogAvailable: Boolean(readGatewayLogs),
  phases,
  failures,
};
await writeFile(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length) {
  process.exitCode = 1;
}
