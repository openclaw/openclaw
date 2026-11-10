import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../../src/gateway/node-registry-private.js";
import type { WorkerSessionTurnClaim } from "../../src/gateway/worker-environments/placement-record.js";
import type { PairedDevice } from "../../src/infra/device-pairing.types.js";
import type { WorkerProvider } from "../../src/plugins/types.js";
import type { NodeWorkerLaunchInput } from "../../src/worker/node-supervisor-protocol.js";

// Real placement sidecar, stores, service, tunnel and launch adapter. Only the remote
// provider/node boundary is synthetic; no model, WebSocket Gateway or worker child runs.
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "start-at": { type: "string" },
    "idle-owner-read": { type: "boolean", default: false },
    "blocked-shutdown-tail": { type: "boolean", default: false },
    "open-existing": { type: "boolean", default: false },
    "device-inspection": { type: "string" },
    "slow-provider-inspection": { type: "boolean", default: false },
    "suspend-before-stop": { type: "boolean", default: false },
    port: { type: "string" },
  },
});
assert(
  values["state-dir"],
  "Usage: --state-dir <directory> [--start-at <unix-ms>] [--idle-owner-read | --open-existing]",
);
assert(!(values["idle-owner-read"] && values["open-existing"]));
assert(
  !values["blocked-shutdown-tail"] || (!values["idle-owner-read"] && !values["open-existing"]),
);
const idleOwnerRead = values["idle-owner-read"];
const deviceInspection = values["device-inspection"];
const slowProviderInspection = values["slow-provider-inspection"];
const remoteInspection = Boolean(deviceInspection) || slowProviderInspection;
assert(deviceInspection === undefined || ["pairing", "presence"].includes(deviceInspection));
assert(!remoteInspection || (!idleOwnerRead && !values["open-existing"]));
assert(!(deviceInspection && slowProviderInspection));
const idlePlacements = idleOwnerRead || remoteInspection;
const blockedShutdownTail = values["blocked-shutdown-tail"];
const placementCount = blockedShutdownTail ? 3 : 2;
const stateDir = path.resolve(values["state-dir"]);
if (!values["open-existing"]) {
  await fs.mkdir(stateDir, { mode: 0o700 });
}
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
const logPath = path.join(stateDir, "gateway.log");
const config: OpenClawConfig = {
  agents: { entries: { main: { workspace: path.join(stateDir, "workspace") } } },
  cloudWorkers: {
    profiles: {
      synthetic: {
        provider: deviceInspection ? "device" : "synthetic",
        settings: deviceInspection ? { device: "synthetic-node" } : {},
      },
    },
  },
  logging: { level: "info", file: logPath, consoleLevel: "error" },
};
if (!values["open-existing"]) {
  await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
}
const [
  { WORKER_PROTOCOL_FEATURES, WORKER_RPC_SET_VERSION },
  { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES },
  { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE },
  { setRuntimeConfigSnapshot },
  { GatewayScheduler },
  stateDb,
  agentDb,
  { writeSessionEntry },
  { createWorkerEnvironmentStore },
  { createWorkerSessionPlacementStore },
  { createWorkerSessionPlacementGate },
  { createWorkerEnvironmentService },
  { createDeviceWorkerRuntime },
  { createGatewayWorkerPlacementRuntime },
  { createNodeWorkerLaunchAdapter },
  { createNodeWorkerTunnelManager },
  { createNodeWorkspaceTransferService },
  { nodeWorkerPlanHash },
  { startGatewayRestartTrace },
  { runWithProcessCleanupBudget },
  { markGatewayRestartDraining, tryBeginGatewaySuspendAdmission },
] = await Promise.all([
  import("../../packages/gateway-protocol/src/schema/worker-admission.js"),
  import("../../packages/gateway-protocol/src/client-info.js"),
  import("../../src/infra/node-runner-inventory.js"),
  import("../../src/config/config.js"),
  import("../../src/infra/gateway-scheduler.js"),
  import("../../src/state/openclaw-state-db.js"),
  import("../../src/state/openclaw-agent-db.js"),
  import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
  import("../../src/gateway/worker-environments/store.js"),
  import("../../src/gateway/worker-environments/placement-store.js"),
  import("../../src/gateway/worker-environments/placement-worker-gate.js"),
  import("../../src/gateway/worker-environments/service.js"),
  import("../../src/gateway/worker-environments/device-provider.js"),
  import("../../src/gateway/server-worker-placement-startup.js"),
  import("../../src/gateway/worker-environments/node-launch-adapter.js"),
  import("../../src/gateway/worker-environments/node-worker-tunnel.js"),
  import("../../src/gateway/worker-environments/node-workspace-transfer-service.js"),
  import("../../src/worker/node-supervisor-protocol.js"),
  import("../../src/gateway/restart-trace.js"),
  import("../../src/process/supervisor/cleanup-budget.js"),
  import("../../src/process/gateway-work-admission.js"),
]);
setRuntimeConfigSnapshot(config);
if (values["open-existing"]) {
  const prior = JSON.parse(await fs.readFile(path.join(stateDir, "result.json"), "utf8"));
  assert.equal(prior.script, "worker-placement-reconcile-shutdown-measure.ts");
  const admission = await import("../../src/infra/sqlite-database-admission.js");
  const diagnostics = await import("../../src/infra/diagnostic-events.js");
  const gates: Array<Record<string, string | number | boolean>> = [];
  const unsubscribe = diagnostics.onInternalDiagnosticEvent(
    (event) => {
      if (
        event.type === "log.record" &&
        event.message === "agent database integrity gate" &&
        event.attributes?.agentId === "main"
      ) {
        gates.push(event.attributes);
      }
    },
    { include: ["log.record"] },
  );
  const databasePath = agentDb.resolveOpenClawAgentSqlitePath({ agentId: "main" });
  await fs.access(databasePath);
  if (values["start-at"]) {
    const startAt = Number(values["start-at"]);
    assert(Number.isSafeInteger(startAt) && startAt > Date.now());
    await sleep(startAt - Date.now());
  }
  const started = performance.now();
  const sealMatched = admission.readSqliteDatabaseCleanClose(databasePath);
  try {
    agentDb.openOpenClawAgentDatabase({ agentId: "main" });
    const openMs = performance.now() - started;
    await diagnostics.waitForDiagnosticEventsDrained();
    const fullScans = gates.filter((gate) => gate.integrityGateMode === "full").length;
    const result = {
      scenario: "cold-process-agent-open",
      scope: "real agent SQLite admission after the synthetic sidecar fixture; no Gateway or model",
      nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite,
      sameRuntime:
        prior.nodeVersion === process.version && prior.sqliteVersion === process.versions.sqlite,
      sealMatched,
      sealReused: sealMatched && fullScans === 0,
      openMs,
      fullScans,
      integrityGateMode: fullScans > 0 ? "full" : sealMatched ? "seal-reuse" : "not-emitted",
      integrityGateReason: gates.at(-1)?.integrityGateReason ?? null,
      gates,
    };
    await fs.writeFile(
      path.join(stateDir, "restart-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    console.log(JSON.stringify(result));
  } finally {
    unsubscribe();
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
    await (await import("../../src/logging/logger.js")).flushLogger();
  }
  process.exit(0);
}
const database = stateDb.openOpenClawStateDatabase();
const store = await createWorkerEnvironmentStore({ database });
const placements = createWorkerSessionPlacementStore({ database });
const placementGate = createWorkerSessionPlacementGate(placements);
let clockOffsetMs = 0;
let wake: (() => void | Promise<void>) | undefined;
const scheduler = new GatewayScheduler({
  clock: {
    now: () => Date.now() + clockOffsetMs,
    monotonicNow: () => performance.now() + clockOffsetMs,
    arm: (run) => {
      wake = run;
      return () => {
        if (wake === run) {
          wake = undefined;
        }
      };
    },
  },
});
const build = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.10.18",
  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
};
const node: NodeWorkerSupervisorNodeProof = {
  nodeId: "synthetic-node",
  connId: "synthetic-connection",
  pairingIdentity: "synthetic-pairing",
  pairingGeneration: "synthetic-generation",
  clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
  clientMode: GATEWAY_CLIENT_MODES.NODE,
  protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  workerHost: {
    enabled: true,
    capacity: { total: 2, available: 2 },
    environmentSession: 1,
    workspaceQuiescence: 1,
    capturedExecPolicy: true,
    promptContext: 1,
    statusWait: 1,
  },
  commands: ["system.run"],
};
const requests: Array<{ command: string; timeoutMs?: number; elapsedMs: number }> = [];
const launched = new Set<string>();
const cancelled = new Set<string>();
const launchesReady = Promise.withResolvers<void>();
const cancellationsReady = Promise.withResolvers<void>();
const fixtureStarted = performance.now();
let holdDeviceRead = false;
let deviceReadCompleted = false;
const deviceReadEntered = Promise.withResolvers<void>();
const deviceReadCleanup = new AbortController();
const inspectionPort = Number(values.port ?? 40978);
assert(
  Number.isSafeInteger(inspectionPort) && inspectionPort >= 40_000 && inspectionPort <= 65_535,
);
const inspectionServer = remoteInspection
  ? createServer((_request, response) => {
      deviceReadEntered.resolve();
      const timer = setTimeout(() => {
        deviceReadCompleted = true;
        response.end("{}");
      }, 85_000);
      response.once("close", () => clearTimeout(timer));
    })
  : undefined;
if (inspectionServer) {
  await new Promise<void>((resolve, reject) => {
    inspectionServer.once("error", reject);
    inspectionServer.listen(inspectionPort, "127.0.0.1", resolve);
  });
}
const readDevice = async (phase: string) => {
  if (
    holdDeviceRead &&
    (deviceInspection === phase || (slowProviderInspection && phase === "provider"))
  ) {
    // The real device provider must stop awaiting a read whose API has no signal.
    await fetch(`http://127.0.0.1:${inspectionPort}/device`, {
      signal: deviceReadCleanup.signal,
    }).then((response) => response.text());
  }
};
const transport: NodeWorkerSupervisorTransport = {
  getCurrentNode: async () => {
    await readDevice("presence");
    return node;
  },
  listCurrentNodes: async () => [node],
  hasCurrentRunner: () => true,
  isCurrent: () => true,
  invoke: async (request) => {
    assert(request.isDispatchAuthorized(), "Synthetic transport requires live owner authority");
    requests.push({
      command: request.command,
      timeoutMs: request.timeoutMs,
      elapsedMs: performance.now() - fixtureStarted,
    });
    if (idlePlacements) {
      assert(
        request.command === "worker.environment.stop.v1" ||
          request.command === "worker.workspace.exec.v1",
        "Idle fixture must not launch work",
      );
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          workspaceDir: "/synthetic-workspace",
          stdout: "drained\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
        }),
      };
    }
    if (request.command === "worker.launch.v1") {
      const input = request.params as NodeWorkerLaunchInput;
      request.onDispatchReady?.(`synthetic-${input.launchId}`);
      launched.add(input.launchId);
      if (launched.size === placementCount) {
        launchesReady.resolve();
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          launchId: input.launchId,
          planHash: nodeWorkerPlanHash(input),
          environmentId: input.descriptor.admission.environmentId,
          sessionId: input.descriptor.admission.sessionId,
          ownerEpoch: input.descriptor.admission.ownerEpoch,
          placementGeneration: input.placementGeneration,
          runId: input.descriptor.assignment.runId,
          state: "running",
        }),
      };
    }
    if (request.command === "worker.cancel.v1") {
      const identity = request.params as { launchId: string };
      cancelled.add(identity.launchId);
      if (cancelled.size === placementCount) {
        cancellationsReady.resolve();
      }
    }
    // The real adapter/tunnel must bound even a transport that ignores cancellation.
    return await new Promise<never>(() => {});
  },
};
const adapter = createNodeWorkerLaunchAdapter({ getTransport: () => transport });
const manager = createNodeWorkerTunnelManager({
  gatewayDeviceId: "synthetic-gateway",
  getEnvironment: store.get,
  listEnvironments: store.list,
  getTransport: () => transport,
  launchNodeWorker: adapter.launch,
  validateWorkerTurn: (claim) => placementGate.validateWorkerTurn(claim),
  workspaceTransfer: createNodeWorkspaceTransferService({
    getOwner: () => undefined,
    temporaryRoot: path.join(stateDir, "transfers"),
  }),
});
let sharedHost = true;
let providerInspections = 0;
const syntheticProvider: WorkerProvider = {
  id: "synthetic",
  supportedExecutionModes: ["worker-turn"],
  resolveAllocation: async () => {
    throw new Error("Fixture does not allocate remote machines");
  },
  provision: async () => {
    throw new Error("Fixture does not provision remote machines");
  },
  inspect: async () => {
    providerInspections++;
    await readDevice("provider");
    return { status: "active", sharedHost };
  },
  destroy: async () => {
    throw new Error("Fixture must preserve remote recovery ownership");
  },
};
const deviceRuntime = createDeviceWorkerRuntime({
  getPairedDevice: async (deviceId): Promise<PairedDevice> => {
    await readDevice("pairing");
    return {
      deviceId,
      publicKey: "synthetic-public-key",
      role: "node",
      roles: ["node"],
      tokens: {
        node: { token: "synthetic-unused-token", role: "node", scopes: [], createdAtMs: 1 },
      },
      createdAtMs: 1,
      approvedAtMs: 1,
    };
  },
});
deviceRuntime.bindNodeTransport(transport);
const provider = deviceInspection ? deviceRuntime.provider : syntheticProvider;
const warnings: string[] = [];
const environments = createWorkerEnvironmentService({
  store,
  scheduler,
  placementStore: placementGate,
  getConfig: () => config,
  resolveProvider: () => provider,
  prepareInstallation: async () => ({
    ...build,
    install: "bundle",
    tarballPath: path.join(stateDir, "unused.tgz"),
    tarballSha256: build.bundleHash,
    tarballBytes: 0,
  }),
  bootstrapWorker: async () => {
    throw new Error("Fixture must not bootstrap a worker");
  },
  nodeTunnelManager: manager,
  logger: { warn: (message) => warnings.push(message) },
});
const runtime = createGatewayWorkerPlacementRuntime({
  scheduler,
  placements,
  initialPlacements: [],
  getCommittedRuntimeConfig: () => config,
  environments,
  gatewayNamespace: "synthetic-gateway",
  cancelSessionWork: async () => {},
  revokeSessionAuthority: () => {},
  warn: (message) => warnings.push(message),
});
const sidecar = await runtime.startRuntime({
  isClosePreludeStarted: () => false,
  registerSidecar: () => {},
  unregisterSidecar: () => {},
});
assert(sidecar);
// Drain the empty startup sweep before creating the measured active owners.
clockOffsetMs += 60_001;
assert(wake);
await wake();
await environments.reconcileOnce();
const reconcileEntered = Promise.withResolvers<void>();
let activeReconciliations = 0;
const reconcileActive = runtime.dispatchService.reconcileActive;
runtime.dispatchService.reconcileActive = (...args) => {
  activeReconciliations++;
  reconcileEntered.resolve();
  return reconcileActive(...args);
};
const claims: WorkerSessionTurnClaim[] = [];
const turns: Array<Promise<string>> = [];
for (let index = 0; index < placementCount; index++) {
  const sessionId = `synthetic-session-${index}`;
  const sessionKey = `agent:main:${sessionId}`;
  const environmentId = `synthetic-environment-${index}`;
  agentDb.runOpenClawAgentWriteTransaction(
    (agent) => {
      writeSessionEntry(agent, sessionKey, {
        sessionId,
        updatedAt: Date.now(),
        lifecycleRevision: `synthetic-lifecycle-${index}`,
      });
    },
    { agentId: "main" },
  );
  await store.createIntent({
    environmentId,
    providerId: provider.id,
    profileId: "synthetic",
    profileSnapshot: {
      settings: deviceInspection ? { device: node.nodeId } : {},
      executionMode: "worker-turn",
    },
    provisionOperationId: `synthetic-provision-${index}`,
  });
  await store.transition({ environmentId, from: "requested", to: "provisioning" });
  await store.transition({
    environmentId,
    from: "provisioning",
    to: "ready",
    patch: {
      leaseId: `synthetic-lease-${index}`,
      nodeDeviceId: node.nodeId,
      sharedHost: true,
      bootstrapReceipt: { ...build, installKind: "bundle" },
      credential: {
        credentialHash: createHash("sha256").update(`synthetic-ready-${index}`).digest("base64url"),
        sessionId: null,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        expiresAtMs: Date.now() + 3_600_000,
      },
    },
  });
  const environment = await store.transition({
    environmentId,
    from: "ready",
    to: "attached",
    patch: {
      attachedSessionIds: [sessionId],
      credential: {
        credentialHash: createHash("sha256")
          .update(`synthetic-attached-${index}`)
          .digest("base64url"),
        sessionId,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        expiresAtMs: Date.now() + 3_600_000,
      },
    },
  });
  let placement = await placements.startDispatch({ sessionId, sessionKey, agentId: "main" });
  for (const [to, patch] of [
    ["provisioning", { environmentId }],
    ["syncing", { workerBundleHash: build.bundleHash }],
    [
      "starting",
      {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: path.join(stateDir, `workspace-${index}`),
      },
    ],
    ["active", { activeOwnerEpoch: environment.ownerEpoch }],
  ] as const) {
    placement = await placements.transition({
      sessionId,
      from: placement.state,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
  if (idlePlacements) {
    continue;
  }
  const claim = await placements.claimTurn({
    sessionId,
    sessionKey,
    agentId: "main",
    runId: `synthetic-run-${index}`,
    claimId: `synthetic-claim-${index}`,
    owner: { kind: "worker", environmentId, ownerEpoch: environment.ownerEpoch },
  });
  claims.push(claim);
  const tunnel = await manager.start({
    executionMode: "worker-turn",
    environmentId,
    ownerEpoch: environment.ownerEpoch,
    deviceId: node.nodeId,
    sessionId,
    expectedBuild: build,
  });
  turns.push(
    tunnel
      .launchTurn({
        turnClaim: claim,
        timeoutMs: 300_000,
        plan: {
          version: 4,
          admission: {
            environmentId,
            credential: "synthetic-unused-credential",
            sessionId,
            ownerEpoch: environment.ownerEpoch,
            rpcSetVersion: WORKER_RPC_SET_VERSION,
            handshake: build,
          },
          assignment: {
            agentId: "main",
            operationalRunInstance: {
              instanceId: `synthetic-instance-${index}`,
              runId: claim.runId,
            },
            agentRuntimeIdentityToken: "synthetic-unused-runtime-token",
            runId: claim.runId,
            turnId: `synthetic-turn-${index}`,
            prompt: "Hold this synthetic worker turn until shutdown.",
            suppressPromptTranscript: true,
            workspaceDir: path.join(stateDir, `workspace-${index}`),
            modelRef: { provider: "synthetic", model: "synthetic" },
            inferenceOptions: {},
            initialMessages: [],
            transcript: { baseLeafId: null, nextSeq: 1 },
            liveEvents: { ackedSeq: 0, nextSeq: 1 },
            toolAuthority: { allowedToolNames: [] },
          },
        },
      })
      .then(
        () => "completed",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
  );
}
if (!idlePlacements) {
  await launchesReady.promise;
}
const startAt = values["start-at"] === undefined ? Date.now() : Number(values["start-at"]);
assert(Number.isSafeInteger(startAt));
if (values["start-at"]) {
  assert(startAt > Date.now(), "Fixture setup missed the simultaneous start deadline");
  await sleep(startAt - Date.now());
}
startGatewayRestartTrace("synthetic-reconcile-shutdown");
// A changed provider isolation fact stops old tunnel owners before committing the new
// scope. This is a real reconciliation path that holds launch cancellation settlement.
let ownerReads = 0;
let sweep: Promise<unknown>;
let ready: Promise<unknown>;
if (remoteInspection) {
  holdDeviceRead = true;
  sweep = environments.reconcileOnce();
  ready = deviceReadEntered.promise;
} else if (idleOwnerRead) {
  const readsEntered = Promise.withResolvers<void>();
  const readEnvironmentOwner = placements.readEnvironmentOwner.bind(placements);
  placements.readEnvironmentOwner = async (environmentId: string, signal?: AbortSignal) => {
    if (++ownerReads === 2) {
      readsEntered.resolve();
    }
    // Controlled stalled read, not an assertion about the production incident's exact await.
    await sleep(85_000, undefined, { signal });
    return readEnvironmentOwner(environmentId, signal);
  };
  sweep = environments.reconcileOnce();
  ready = readsEntered.promise;
} else {
  sharedHost = false;
  clockOffsetMs += 60_001;
  assert(wake, "Placement maintenance must be scheduled");
  sweep = Promise.resolve(wake());
  ready = Promise.all([cancellationsReady.promise, reconcileEntered.promise]);
}
const keepAlive = setInterval(() => {}, 1_000);
const setupDeadline = new AbortController();
await Promise.race([
  ready,
  sleep(20_000, undefined, { ref: false, signal: setupDeadline.signal }).then(async () => {
    const diagnostic = {
      launched: launched.size,
      cancelled: cancelled.size,
      activeReconciliations,
      providerInspections,
      ownerReads,
      nextWakeAtMs: scheduler.nextWakeAtMs,
      requests,
      warnings,
    };
    await fs.writeFile(
      path.join(stateDir, "setup-failure.json"),
      JSON.stringify(diagnostic, null, 2),
    );
    console.error(JSON.stringify(diagnostic));
    throw new Error("Synthetic reconciliation fixture did not enter its expected wait");
  }),
]).finally(() => setupDeadline.abort());
let reconcileSettledAt: number | undefined;
const observeReconcile = sweep.then(
  () => {
    reconcileSettledAt = performance.now();
  },
  () => {
    reconcileSettledAt = performance.now();
  },
);
let suspendAbortMs: number | null = null;
if (values["suspend-before-stop"]) {
  const suspendStarted = performance.now();
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  assert(suspension, "Synthetic Gateway must accept suspension");
  assert(suspension.drain());
  await Promise.race([observeReconcile, sleep(1_000)]);
  suspendAbortMs = reconcileSettledAt === undefined ? null : reconcileSettledAt - suspendStarted;
}
const reconcileInFlightAtShutdown = reconcileSettledAt === undefined;
const shutdownStartedAtMs = Date.now();
const shutdownStarted = performance.now();
const postShutdownStoreOperations: string[] = [];
if (blockedShutdownTail) {
  // Model a busy shared-store queue without copying production data. This holds
  // only newly submitted work, never an already accepted write's settlement.
  const waitForStore = async (operation: string) => {
    postShutdownStoreOperations.push(operation);
    await sleep(Math.max(0, shutdownStartedAtMs + 35_000 - Date.now()));
  };
  const prune = store.pruneTerminalEnvironments.bind(store);
  store.pruneTerminalEnvironments = async (input) => {
    await waitForStore("retention");
    return prune(input);
  };
  const readCandidates = placements.readRecoveryCandidates.bind(placements);
  placements.readRecoveryCandidates = async () => {
    await waitForStore("candidates");
    return readCandidates();
  };
}
markGatewayRestartDraining();
await runWithProcessCleanupBudget(
  { deadline: shutdownStarted + 85_000, warn: (message) => warnings.push(message) },
  () => sidecar.stop(),
);
const shutdownMs = performance.now() - shutdownStarted;
const deviceReadCompletedBeforeStop = deviceReadCompleted;
holdDeviceRead = false;
deviceReadCleanup.abort();
inspectionServer?.closeAllConnections();
if (inspectionServer) {
  await new Promise<void>((resolve) => {
    inspectionServer.close(() => resolve());
  });
}
await sweep;
const turnResults = await Promise.all(turns);
const retained = await placements.listAsync();
assert.equal(retained.length, placementCount);
if (idlePlacements) {
  assert(retained.every((placement) => placement.turnClaim === null));
}
for (const claim of claims) {
  const placement = retained.find((candidate) => candidate.sessionId === claim.sessionId);
  assert.equal(
    placement?.turnClaim?.claimId,
    claim.claimId,
    "Unconfirmed worker claim must survive",
  );
  assert(placement?.workspaceBaseManifestRef, "Workspace recovery manifest must survive");
}
await (await import("../../src/logging/logger.js")).flushLogger();
const log = await fs.readFile(logPath, "utf8");
const reconcileMatch = log.match(/shutdown\.worker-placement\.reconcile\.active ([\d.]+)ms/u);
if (!idlePlacements) {
  assert(reconcileMatch, "Shutdown must have joined the real active reconciliation phase");
}
const guardMatch = log.match(/shutdown\.worker-environments\.reconcile-guard ([\d.]+)ms/u);
const environmentsMatch = log.match(/shutdown\.worker-placement\.environments ([\d.]+)ms/u);
assert(guardMatch && environmentsMatch, "Shutdown must report the real environment close steps");
const result = {
  script: "worker-placement-reconcile-shutdown-measure.ts",
  scriptSha256: createHash("sha256")
    .update(await fs.readFile(new URL(import.meta.url)))
    .digest("hex"),
  scope: slowProviderInspection
    ? "real placement sidecar, SQLite and environment service; actual slow loopback HTTP-backed provider inspection ignoring cancellation; synthetic node acknowledgements"
    : deviceInspection
      ? "real placement sidecar, SQLite, environment service and device provider; actual slow loopback HTTP-backed pairing/presence read; synthetic node acknowledgements"
      : idleOwnerRead
        ? "real placement sidecar, SQLite and environment service; controlled stalled owner lookup, synthetic provider/node acknowledgements; exact production blocked await unknown"
        : "real placement sidecar, SQLite, environment service, node tunnel and launch adapter; synthetic provider and non-acknowledging node transport",
  scenario: slowProviderInspection
    ? "slow-provider-inspection"
    : deviceInspection
      ? `device-inspection-${deviceInspection}`
      : blockedShutdownTail
        ? "active-worker-cancellation-with-blocked-store-tail"
        : idleOwnerRead
          ? "controlled-stalled-owner-read"
          : "active-worker-cancellation",
  controlledStoreBusyMs: blockedShutdownTail ? 35_000 : null,
  postShutdownStoreOperations,
  controlledOwnerReadDelayMs: idleOwnerRead ? 85_000 : null,
  controlledDeviceReadDelayMs: remoteInspection ? 85_000 : null,
  deviceReadCompletedBeforeStop: remoteInspection ? deviceReadCompletedBeforeStop : null,
  suspendBeforeStop: values["suspend-before-stop"],
  suspendAbortMs,
  reconcileInFlightAtShutdown,
  wholeGatewayRestart: false,
  realModelTurns: false,
  realRemoteWorkerProcesses: false,
  durableDatabase: true,
  nodeVersion: process.version,
  sqliteVersion: process.versions.sqlite,
  shutdownStartedAtMs,
  shutdownMs,
  reconcileActiveMs: reconcileMatch ? Number(reconcileMatch[1]) : null,
  reconcileGuardMs: Number(guardMatch[1]),
  environmentsMs: Number(environmentsMatch[1]),
  ownerReads,
  retainedClaims: retained.filter((placement) => placement.turnClaim).length,
  retainedPlacements: retained.map(({ state, turnClaim, workspaceBaseManifestRef }) => ({
    state,
    turnClaim,
    workspaceBaseManifestRef,
  })),
  turnResults,
  requests,
  warnings,
};
await scheduler.stop();
await store.close();
await agentDb.closeOpenClawAgentDatabasesAsync();
await stateDb.closeOpenClawStateDatabaseAsync();
await (await import("../../src/logging/logger.js")).flushLogger();
const completedResult = {
  ...result,
  cleanCloseReceipts: (await fs.readFile(logPath, "utf8"))
    .split("\n")
    .filter((line) => line.includes("agent database clean-close receipt:")),
};
await fs.writeFile(
  path.join(stateDir, "result.json"),
  `${JSON.stringify(completedResult, null, 2)}\n`,
  { flag: "wx" },
);
clearInterval(keepAlive);
console.log(JSON.stringify(completedResult));
