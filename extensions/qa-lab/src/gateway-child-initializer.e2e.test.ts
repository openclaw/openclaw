import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { prepareQaGatewayChild } from "./gateway-child-setup.js";
import { resolveQaNodeExecPath } from "./node-exec.js";

const lifetimes: QaGatewayChildLifecycle[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) {
    const result = await lifetime.stop({ keepTemp: false });
    expect(result.errors).toEqual([]);
  }
});

it("initializes the same startup facts as real packaged repair", { timeout: 360_000 }, async () => {
  const states = [];
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
        enabledPluginIds: ["qa-channel", "telegram", "diagnostics-otel", "llm-task"],
        mutateConfig: (config) => ({
          ...config,
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
    const { env } = await prepared.prepareAttempt();
    // The parent staged auth before repair; a fresh reader must own post-repair admissions.
    const snapshot = await runQaGatewayCliCommand({
      lifetime,
      executablePath: nodeExecutable,
      argsPrefix: [],
      args: [
        "--input-type=module",
        "--eval",
        `const runtime = await import(${JSON.stringify(
          pathToFileURL(path.join(repoRoot, "dist/plugin-sdk/qa-runtime.js")).href,
        )});\n` +
          `try { process.stdout.write(JSON.stringify(await runtime.snapshotQaStartupState(process.env))); }\n` +
          `finally { await runtime.closeQaRuntimeStores(${JSON.stringify(prepared.tempRoot)}); }`,
      ],
      cwd: repoRoot,
      env,
    });
    states.push(JSON.parse(snapshot));
  }
  // Run provenance and clean-close seals are diagnostic; all startup policy/admission facts match.
  console.info(
    "[qa-initializer] readiness diagnostics",
    states.map(({ diagnostics }) => diagnostics),
  );
  expect(states[1].state).toEqual(states[0].state);
});
