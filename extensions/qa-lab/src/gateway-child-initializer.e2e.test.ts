import { spawn } from "node:child_process";
import { createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolvePluginNpmPackageDir } from "../../../src/plugins/install-paths.js";
import type { PluginSourceAdmissionReceipt } from "../../../src/plugins/plugin-source-admission.types.js";
import {
  registryPackages,
  startStaticRegistry,
} from "../../../src/plugins/test-helpers/npm-registry-fixtures.js";
import { closeHttpServer } from "../../../test/helpers/gateway-integration-fixtures.js";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { waitForGatewayListening, waitForGatewayReady } from "./gateway-child-readiness.js";
import { prepareQaGatewayChild } from "./gateway-child-setup.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { resolveQaNodeExecPath } from "./node-exec.js";

const servers: http.Server[] = [];
const lifetimes: QaGatewayChildLifecycle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await closeHttpServer(server);
  }
  for (const lifetime of lifetimes.splice(0)) {
    const result = await lifetime.stop({ keepTemp: false });
    expect(result.errors).toEqual([]);
  }
});

it("initializes the same startup facts as real packaged repair", { timeout: 360_000 }, async () => {
  const states = [];
  let registryFixture: { root: string; url: string } | undefined;
  const packageName = "qa-startup-consent-fixture";
  const dependency = "qa-startup-required-runtime";
  const toolName = "qa_startup_fixture_tool";
  const nodeExecutable = await resolveQaNodeExecPath();
  const repoRoot = path.resolve(import.meta.dirname, "../../..");
  for (const initializeCurrentRuntimeState of [false, true]) {
    const lifetime = new QaGatewayChildLifecycle();
    lifetimes.push(lifetime);
    const prepared = await prepareQaGatewayChild(
      {
        repoRoot,
        command: {
          executablePath: nodeExecutable,
          argsPrefix: [
            "--import",
            pathToFileURL(path.join(repoRoot, "scripts/tsx.mjs")).href,
            path.join(repoRoot, "scripts/run-with-env.mts"),
            `OPENCLAW_DEV_SOURCE_ROOT=${repoRoot}`,
            "--",
            nodeExecutable,
            path.join(repoRoot, "openclaw.mjs"),
          ],
          cwd: repoRoot,
          usePackagedPlugins: true,
        },
        initializeCurrentRuntimeState,
        transportBaseUrl: "http://127.0.0.1:43123",
        providerBaseUrl: "http://127.0.0.1:44080/v1",
        providerMode: "mock-openai",
        controlUiEnabled: false,
        enabledPluginIds: ["qa-channel", "telegram", "diagnostics-otel", "llm-task", packageName],
        mutateConfig: (config) => ({
          ...config,
          // Keep external catalog/update maintenance out of this startup admission proof.
          models: { ...config.models, catalogRefresh: { enabled: false } },
          update: { ...config.update, checkOnStart: false },
          gateway: {
            ...config.gateway,
            port: 43124,
            auth: { mode: "token", token: "qa-init-token" },
          },
          hooks: { enabled: true, token: "qa-hook-token", path: "/hooks" },
          channels: {
            ...config.channels,
            "qa-channel": {
              ...config.channels?.["qa-channel"],
              defaultAccount: "default",
              accounts: {
                default: { name: "Default" },
                work: { name: "Work" },
                disabled: { name: "Disabled", enabled: false },
              },
            },
          },
        }),
      },
      lifetime,
    );
    // Missing dependency forces npm replacement; the declared tool requires consent.
    if (!registryFixture) {
      const root = path.join(prepared.tempRoot, "registry-packages");
      await fs.mkdir(root);
      const packageRoot = path.join(root, `package-${packageName}-1.0.0`);
      await fs.mkdir(packageRoot, { recursive: true });
      // Unused bytes exercise source custody without executing a native module.
      await fs.writeFile(path.join(packageRoot, "fixture.bin"), "synthetic admission bytes");
      const packages = await registryPackages(root, [
        {
          packageName,
          dependencies: { [dependency]: "1.0.0" },
          manifest: { contracts: { tools: [toolName] } },
          indexJs: `import "${dependency}/dist/index.js"; export default { id: "${packageName}", register() {} };\n`,
        },
        { packageName: dependency },
      ]);
      registryFixture = { root, url: await startStaticRegistry(packages, servers) };
    }
    const { root: packagesRoot, url: registry } = registryFixture;
    // HOME is also forwarded by the configured launcher; no extra env permissions.
    await fs.writeFile(
      path.join(prepared.tempRoot, "home/.npmrc"),
      "registry=" +
        registry +
        "\ncache=" +
        prepared.tempRoot +
        "/npm-cache\naudit=false\nfund=false\n",
      { mode: 0o600 },
    );
    const installPath = resolvePluginNpmPackageDir({
      packageName,
      npmDir: path.join(prepared.stateDir, "npm"),
    });
    await fs.cp(path.join(packagesRoot, "package-" + packageName + "-1.0.0"), installPath, {
      recursive: true,
    });
    const fixtureConfig = {
      models: { catalogRefresh: { enabled: false } },
      update: { checkOnStart: false },
      plugins: { allow: [packageName], entries: { [packageName]: { enabled: true } } },
    };
    const fixtureEnv = {
      ...process.env,
      HOME: path.join(prepared.tempRoot, "home"),
      OPENCLAW_HOME: path.join(prepared.tempRoot, "home"),
      OPENCLAW_STATE_DIR: prepared.stateDir,
      OPENCLAW_CONFIG_PATH: prepared.configPath,
    };
    await fs.writeFile(prepared.configPath, JSON.stringify(fixtureConfig), { mode: 0o600 });
    // Seed with the existing owner in a separate process, not a second writer
    // retained in the test parent's compiled subprocess dependency graph.
    await runQaGatewayCliCommand({
      lifetime,
      executablePath: nodeExecutable,
      argsPrefix: ["--import", path.join(repoRoot, "scripts/tsx.mjs")],
      args: [
        "--input-type=module",
        "--eval",
        `const { seedInstalledPluginIndex } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "src/plugins/test-helpers/installed-plugin-index.ts")).href)});` +
          `const { closeQaRuntimeStores } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "src/plugin-sdk/qa-runtime.ts")).href)});` +
          `try { await seedInstalledPluginIndex(${JSON.stringify({ [packageName]: { source: "npm", spec: packageName + "@1.0.0", installPath, version: "1.0.0" } })}, { config: ${JSON.stringify(fixtureConfig)}, env: process.env }); }` +
          `finally { await closeQaRuntimeStores(${JSON.stringify(prepared.tempRoot)}); }` +
          `const { openOpenClawAgentDatabase } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "src/state/openclaw-agent-db.ts")).href)});` +
          `const { markCanonicalSessionValidationPending } = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "src/config/sessions/session-canonical-key.ts")).href)});` +
          `try { const db = openOpenClawAgentDatabase({ agentId: "qa", env: process.env }); db.db.exec("BEGIN IMMEDIATE"); db.db.prepare("INSERT INTO session_nodes (session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES (?,?,?,?,?)").run("agent:qa:pending-fixture", "pending-fixture", JSON.stringify({ sessionId: "pending-fixture", updatedAt: 1 }), 1, 1); markCanonicalSessionValidationPending(db); db.db.exec("COMMIT"); }` +
          `finally { await closeQaRuntimeStores(${JSON.stringify(prepared.tempRoot)}); }`,
      ],
      cwd: repoRoot,
      env: fixtureEnv,
    });
    if (!initializeCurrentRuntimeState) {
      // --yes must not silently imply capability acceptance.
      const refusal = await runQaGatewayCliCommand({
        lifetime,
        executablePath: prepared.nodeExecPath,
        argsPrefix: prepared.cliArgsPrefix,
        args: ["update", "repair", "--yes", "--no-restart", "--json"],
        cwd: prepared.gatewayCwd,
        env: { ...fixtureEnv, OPENCLAW_NO_RESPAWN: "1" },
      });
      expect(refusal).toContain("PLUGIN_CAPABILITY_CONSENT_REQUIRED");
      console.info("[qa-initializer] repair refused without capability consent");
    }
    const launch = await prepared.prepareAttempt();
    const { env } = launch;
    const child = spawn(prepared.nodeExecPath, prepared.buildGatewayArgs(), {
      cwd: prepared.gatewayCwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const owned = lifetime.register(child, null);
    let output = "";
    child.stdout.on("data", (bytes) => {
      output = (output + bytes).slice(-16000);
    });
    child.stderr.on("data", (bytes) => {
      output = (output + bytes).slice(-16000);
    });
    const health = {
      baseUrl: launch.baseUrl,
      logs: () => output,
      child,
      getChildFailure: () => null,
      timeoutMs: 120_000,
    };
    await waitForGatewayListening(health);
    await waitForGatewayReady(health);
    lifetime.rpcClient = await startQaGatewayRpcClient({
      wsUrl: launch.wsUrl,
      token: "qa-init-token",
      logs: () => output,
    });
    await lifetime.rpcClient.request("config.get", {}, { timeoutMs: 30_000 });
    owned.ready = true;
    await lifetime.rpcClient.stop();
    lifetime.rpcClient = null;
    expect(await lifetime.stopProcess()).toEqual({ process: "confirmed-stopped", errors: [] });
    const snapshotPath = path.join(prepared.tempRoot, "startup-state.json");
    // The parent staged auth before repair; a fresh reader must own post-repair admissions.
    await runQaGatewayCliCommand({
      lifetime,
      executablePath: nodeExecutable,
      argsPrefix: [],
      args: [
        "--input-type=module",
        "--eval",
        `const runtime = await import(${JSON.stringify(
          pathToFileURL(path.join(repoRoot, "dist/plugin-sdk/qa-runtime.js")).href,
        )});\n` +
          `try { const fs = await import("node:fs/promises"); await fs.writeFile(${JSON.stringify(snapshotPath)}, JSON.stringify(await runtime.snapshotQaStartupState(process.env))); }\n` +
          `finally { await runtime.closeQaRuntimeStores(${JSON.stringify(prepared.tempRoot)}); }`,
      ],
      cwd: repoRoot,
      env,
    });
    const observed = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
    // A fresh empty store needs no durable receipt. Seeded rows require the real
    // certifying owner, so neither empty-store admission nor two false receipts can pass.
    expect(observed.state.agents[0].canonicalEntries).toBe(1);
    expect(observed.state.agents[0].canonicalReceipt).toBe(true);
    const index = observed.state.shared.machineState.find(
      ({ key }: { key: string }) => key === "plugins.installedIndex",
    ).value;
    expect(index.content.installRecords[packageName].acceptedSurface.tools).toContain(toolName);
    const admissions = index.sourceAdmissions.find(
      ({ pluginId }: { pluginId: string }) => pluginId === packageName,
    ).sourceAdmissions;
    expect(Object.keys(admissions ?? {})).not.toHaveLength(0);
    console.info("[qa-initializer] admitted fixture", {
      initializeCurrentRuntimeState,
      acceptedTools: index.content.installRecords[packageName].acceptedSurface.tools,
      sourceAdmissionCount: Object.keys(admissions).length,
    });
    // Receipt inode identities and capture locations belong to this run, not
    // startup policy. Nonempty receipts above prove source admission occurred.
    for (const plugin of index.sourceAdmissions) {
      const receipts: Record<string, PluginSourceAdmissionReceipt> = plugin.sourceAdmissions ?? {};
      plugin.sourceAdmissions = Object.values(receipts).map((admission) => ({
        sourceDigest: admission.sourceDigest,
        nativeArtifacts: Object.entries(admission.nativeArtifacts).map(([file, artifact]) => ({
          file,
          contentHash: artifact.contentHash,
          sizeBytes: artifact.sizeBytes,
        })),
        nativeNamespaces: Object.values(admission.nativeNamespaces).map((namespace) => ({
          managed: namespace.managed,
          members: Object.entries(namespace.members).map(([file, member]) => ({
            file,
            boundaryChecked: member.boundaryChecked,
            contentHash: member.contentHash,
            sizeBytes: member.sizeBytes,
          })),
        })),
      }));
    }
    // Per-fixture generated identity and timing values are not startup policy.
    // Validate the key pair before comparing its stable record shape.
    for (const identity of observed.state.client.identities) {
      expect(
        createPublicKey(identity.private_key_pem).export({ type: "spki", format: "pem" }),
      ).toBe(identity.public_key_pem);
      expect(identity.device_id).toEqual(expect.any(String));
      identity.private_key_pem = "<generated-private-key>";
      identity.public_key_pem = "<generated-public-key>";
      identity.device_id = "<generated-device-id>";
      identity.created_at_ms = "<creation-time>";
      identity.updated_at_ms = "<update-time>";
    }
    for (const row of observed.state.shared.machineState) {
      if (row.value?.active?.bootId) {
        row.value.active.bootId = "<boot-id>";
      }
    }
    for (const record of Object.values(index.content.installRecords) as Array<
      Record<string, unknown>
    >) {
      for (const key of ["installedAt", "acceptedSurfaceAt", "resolvedAt"]) {
        if (record[key] !== undefined) {
          record[key] = "<install-time>";
        }
      }
    }
    // This digest includes the validated installation timestamps above.
    for (const plugin of index.content.plugins) {
      if (plugin.installRecordHash) {
        plugin.installRecordHash = "<install-record-hash>";
      }
    }
    for (const key of ["modelCatalog.remote.v3", "telemetry.updateCheck", "update.checkState"]) {
      expect(
        observed.state.shared.machineState.some((row: { key: string }) => row.key === key),
      ).toBe(false);
    }
    // Workspace CAS sweep epochs schedule garbage collection, not projection
    // authority (local-workspace-cas.kernel.ts). Doctor may advance them before
    // readiness; workspace content and attestation remain strictly compared.
    const sweepKeys = new Set([
      "workspace.manifest.sweepEpoch",
      "workspace.manifest.pendingSweepEpoch",
    ]);
    const sweepState = observed.state.shared.machineState.filter(({ key }: { key: string }) =>
      sweepKeys.has(key),
    );
    for (const row of sweepState) {
      expect(Number.isSafeInteger(row.value)).toBe(true);
      expect(row.value).toBeGreaterThanOrEqual(0);
    }
    console.info("[qa-initializer] workspace sweep diagnostics", sweepState);
    observed.state.shared.machineState = observed.state.shared.machineState.filter(
      ({ key }: { key: string }) => !sweepKeys.has(key),
    );
    states.push(observed);
  }
  // Run provenance and clean-close seals are diagnostic; all startup policy/admission facts match.
  console.info(
    "[qa-initializer] readiness diagnostics",
    states.map(({ diagnostics }) => diagnostics),
  );
  expect(states[1].state).toEqual(states[0].state);
});
