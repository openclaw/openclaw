import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PROTOCOL_FEATURES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../../src/gateway/node-registry-private.js";
import { createNodeWorkerTunnelManager } from "../../src/gateway/worker-environments/node-worker-tunnel.js";
import { createNodeWorkspaceTransferService } from "../../src/gateway/worker-environments/node-workspace-transfer-service.js";
import type { WorkerEnvironmentRecord } from "../../src/gateway/worker-environments/store.js";
import { NODE_WORKER_ENVIRONMENT_STOP_COMMAND } from "../../src/infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../src/infra/node-runner-inventory.js";
import { runWithProcessCleanupBudget } from "../../src/process/supervisor/cleanup-budget.js";

// Owner-level reproduction: real cleanup, synthetic delayed node acknowledgements.
// This does not measure a whole Gateway restart or create a real background exec session.
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "ack-delay-ms": { type: "string", default: "40000" },
  },
});
if (!values["state-dir"]) {
  throw new Error("Usage: --state-dir <new-directory> [--ack-delay-ms 40000]");
}
const stateDir = path.resolve(values["state-dir"]);
const ackDelayMs = Number(values["ack-delay-ms"]);
assert(Number.isSafeInteger(ackDelayMs) && ackDelayMs > 0 && ackDelayMs < 60_000);
await fs.mkdir(stateDir, { mode: 0o700 });
const build = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.10.18",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
const record: WorkerEnvironmentRecord = {
  environmentId: "shutdown-fixture",
  ownerEpoch: 2,
  preparation: null,
  lastActivatedAtMs: null,
  providerId: "device",
  profileId: "device:synthetic",
  profileSnapshot: { settings: { device: "synthetic" } },
  provisionOperationId: "synthetic-provision",
  resourceReceipt: null,
  nodeSetupId: null,
  nodeDeviceId: "synthetic",
  sharedHost: true,
  desktop: null,
  bootstrapReceipt: { ...build, installKind: "bundle" },
  teardownTerminalState: null,
  attachedSessionIds: ["synthetic-session"],
  lastError: null,
  createdAtMs: 1,
  updatedAtMs: 2,
  stateChangedAtMs: 2,
  idleSinceAtMs: null,
  destroyRequestedAtMs: null,
  state: "attached",
  leaseId: "synthetic-lease",
  sshEndpoint: null,
};
const node: NodeWorkerSupervisorNodeProof = {
  nodeId: "synthetic",
  connId: "synthetic-connection",
  pairingIdentity: "synthetic-pairing",
  pairingGeneration: "synthetic-generation",
  clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
  clientMode: GATEWAY_CLIENT_MODES.NODE,
  protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  workerHost: {
    enabled: true,
    capacity: { total: 1, available: 1 },
    environmentSession: 1,
    workspaceQuiescence: 1,
  },
  commands: ["system.run"],
};
const entered = Promise.withResolvers<void>();
const requests: Array<{ command: string; timeoutMs?: number; result?: string }> = [];
const fixtureLifetime = new AbortController();
const transport: NodeWorkerSupervisorTransport = {
  getCurrentNode: async () => node,
  listCurrentNodes: async () => [node],
  hasCurrentRunner: () => true,
  isCurrent: () => true,
  invoke: async (request) => {
    assert(request.isDispatchAuthorized());
    const observation = {
      command: request.command,
      timeoutMs: request.timeoutMs,
      result: "pending",
    };
    requests.push(observation);
    entered.resolve();
    const signal = request.signal
      ? AbortSignal.any([request.signal, fixtureLifetime.signal])
      : fixtureLifetime.signal;
    try {
      await sleep(ackDelayMs, undefined, { signal });
      observation.result = "acknowledged";
    } catch {
      observation.result = "aborted";
      throw signal.reason;
    }
    return {
      ok: true,
      payloadJSON:
        request.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND
          ? "null"
          : JSON.stringify({
              workspaceDir: path.join(stateDir, "workspace"),
              stdout: "drained\n",
              stderr: "",
              code: 0,
              signal: null,
              killed: false,
              termination: "exit",
            }),
    };
  },
};
const manager = createNodeWorkerTunnelManager({
  gatewayDeviceId: "synthetic-gateway",
  getEnvironment: () => record,
  listEnvironments: () => [record],
  getTransport: () => transport,
  launchNodeWorker: async () => {
    throw new Error("Worker launch is outside this fixture");
  },
  validateWorkerTurn: () => false,
  workspaceTransfer: createNodeWorkspaceTransferService({
    getOwner: () => undefined,
    temporaryRoot: path.join(stateDir, "transfers"),
  }),
});
await manager.start({
  executionMode: "worker-turn",
  environmentId: record.environmentId,
  ownerEpoch: record.ownerEpoch,
  deviceId: node.nodeId,
  sessionId: record.attachedSessionIds[0]!,
  expectedBuild: build,
});
const cleanup = manager.stop(record.environmentId, record.ownerEpoch);
const cleanupResult = cleanup.then(
  () => "acknowledged",
  (error: unknown) => (error instanceof Error ? error.name : "unknown-error"),
);
await entered.promise;
const shutdownStarted = performance.now();
// The same script runs unchanged against the base revision, which lacks beginClose.
const supportsBeginClose = "beginClose" in manager && typeof manager.beginClose === "function";
let shutdownResult: string;
try {
  shutdownResult = await runWithProcessCleanupBudget(
    { deadline: shutdownStarted + 85_000, warn: () => {} },
    async () => {
      if (supportsBeginClose) {
        manager.beginClose();
      }
      return manager.stopAll().then(
        () => "acknowledged",
        (error: unknown) => (error instanceof Error ? error.name : "unknown-error"),
      );
    },
  );
} finally {
  fixtureLifetime.abort(new Error("Synthetic acknowledgement fixture ended"));
}
const shutdownMs = performance.now() - shutdownStarted;
const result = {
  script: "worker-environment-shutdown-measure.ts",
  scriptSha256: createHash("sha256")
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest("hex"),
  scope: "node-worker-tunnel cleanup owner; delayed synthetic transport acknowledgements",
  wholeGatewayRestart: false,
  realBackgroundExecSession: false,
  durableDatabase: false,
  nodeVersion: process.version,
  ackDelayMs,
  supportsBeginClose,
  shutdownMs,
  shutdownResult,
  cleanupResult: await cleanupResult,
  requests,
};
await fs.writeFile(path.join(stateDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, {
  flag: "wx",
});
console.log(JSON.stringify(result));
