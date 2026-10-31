import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { parse } from "yaml";
import {
  buildOpenShellPolicyYaml,
  cleanupOpenShellWorkspace,
  runCommand,
} from "./backend.e2e.test-support.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import {
  createOpenShellWorkerNodeConfig as nodeConfig,
  OPEN_SHELL_WORKER_BOOTSTRAP,
} from "./worker-launch.js";
import { createWorkerFixture } from "./worker.test-support.js";

const sandboxNames = ["first", "second"];
it.each<[string, string[]]>([
  ["  ", ["10.0.0.0/8", "172.0.0.0/8", "192.168.0.0/16", "fc00::/7"]],
  [" 198.51.100.42 ", ["198.51.100.42/32"]],
])("preserves default and trimmed override IP ranges: %j", (hostIp, allowedIps) => {
  const yaml = buildOpenShellPolicyYaml({ port: 17680, binaryPath: "/usr/bin/curl", hostIp });
  expect(parse(yaml)).toMatchObject({
    network_policies: {
      host_echo: {
        endpoints: [
          {
            host: "host.openshell.internal",
            port: 17680,
            protocol: "rest",
            enforcement: "enforce",
            access: "full",
            allowed_ips: allowedIps,
          },
        ],
        binaries: [{ path: "/usr/bin/curl" }],
      },
    },
  });
});

it.runIf(process.platform !== "win32")("reports a signal-killed probe as failure", async () => {
  const result = await runCommand({
    command: process.execPath,
    args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    allowFailure: true,
    timeoutMs: 10_000,
  });
  expect(result.code).not.toBe(0);
});

afterEach(() => vi.restoreAllMocks());

async function createCleanupFixture(options: { mode?: string; inventory?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openshell-cleanup-test-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "state.json");
  const command = path.join(root, "openshell");
  const initial = { names: sandboxNames, deletes: [] as string[], workspaceDeletes: 0, ...options };
  await fs.writeFile(stateFile, JSON.stringify(initial));
  await fs.writeFile(
    command,
    `#!${process.execPath}
const fs = require("node:fs");
const stateFile = process.env.FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
let failure;
if (args[0] === "workspace") {
  state.workspaceDeletes++;
  if (state.names.length) failure = "workspace still contains durable sandbox records";
  if (state.mode === "workspace-failure") failure = "workspace cleanup failed";
} else if (args[3] === "delete") {
  state.pending = args[4];
  state.deletes.push(state.pending);
  state.observations = 0;
  if (state.mode === "delete-failure" && state.pending === "first") failure = "delete failed";
} else if (args[3] === "list") {
  if (state.pending && ++state.observations >= 2 && state.mode !== "stuck") {
    state.names = state.names.filter(name => name !== state.pending);
    state.pending = "";
  }
  if (state.mode === "read-failure" && state.deletes.length) failure = "database is locked";
  const limit = Number(args[args.indexOf("--limit") + 1]);
  console.log(state.inventory ?? JSON.stringify(state.names.slice(0, limit).map(name => ({ name }))));
} else {
  throw new Error("unexpected fixture command");
}
fs.writeFileSync(stateFile, JSON.stringify(state));
if (failure) throw new Error(failure);
if (state.mode === "stuck" && state.observations > 0) fs.writeFileSync(stateFile + ".expired", "");
`,
    { mode: 0o755 },
  );
  return {
    cleanup: () =>
      cleanupOpenShellWorkspace({
        command,
        env: { ...process.env, FIXTURE_STATE: stateFile },
        workspace: "isolated",
        sandboxNames: [...sandboxNames, "never-created"],
      }),
    read: async () => JSON.parse(await fs.readFile(stateFile, "utf8")) as typeof initial,
    deadlineExpired: () => existsSync(stateFile + ".expired"),
  };
}

it.runIf(process.platform !== "win32").each([
  ["invalid-json", "not json", "", []],
  ["unowned", '[{"name":"someone-else"}]', "", []],
  ["read-failure", undefined, "database is locked", sandboxNames],
  ["delete-failure", undefined, "delete failed", sandboxNames],
  ["stuck", undefined, "120 seconds", ["first"]],
  ["workspace-failure", undefined, "workspace cleanup failed", sandboxNames],
] as const)(
  "cleanup reports %s with durable deletion state",
  async (mode, inventory, message, deletes) => {
    const fixture = await createCleanupFixture({ mode, inventory });
    if (mode === "stuck") {
      const startedAt = Date.now();
      // Expire only after the child operation starts, even on a loaded host.
      vi.spyOn(Date, "now").mockImplementation(
        () => startedAt + (fixture.deadlineExpired() ? 120_000 : 0),
      );
    }
    if (inventory !== undefined || mode === "workspace-failure") {
      await expect(fixture.cleanup()).rejects.toThrow(message);
    } else {
      const cleanup = fixture.cleanup();
      const errors = [expect.objectContaining({ message: expect.stringContaining(message) })];
      const expectedErrors = mode === "stuck" ? expect.arrayContaining(errors) : errors;
      await expect(cleanup).rejects.toBeInstanceOf(AggregateError);
      await expect(cleanup).rejects.toHaveProperty("errors", expectedErrors);
    }
    expect(await fixture.read()).toMatchObject({
      deletes,
      workspaceDeletes: mode === "workspace-failure" ? 1 : 0,
      ...(mode === "workspace-failure" ? { names: [] } : {}),
    });
  },
);

it("rejects raw/missing credentials before launch and carries broker auth, CA, and private pairing to the node", async () => {
  await withTempHome(async (home) => {
    const executable = path.join(home, "openclaw-fixture");
    await fs.writeFile(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const target = args.includes("--target-file") ? fs.readFileSync(args[args.indexOf("--target-file") + 1], "utf8") : undefined;
console.log(JSON.stringify({args, target, placeholder: process.env.OPENAI_API_KEY?.startsWith("openshell:resolve:env:"), ca: process.env.NODE_EXTRA_CA_CERTS, unsafe: process.env.OPENCLAW_GATEWAY_TOKEN, config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"))}));
`,
      { mode: 0o700 },
    );
    const worker = resolveOpenShellPluginConfig({ worker: createWorkerFixture() }).worker!;
    worker.nodeCommand = executable;
    worker.stateDir = path.join(home, "node-state");
    const pairingFile = path.join(worker.stateDir, "pairing-target");
    const brokerCredential = "openshell:resolve:env:synthetic-opaque-reference";
    const bootstrap = "delete process.env.NODE_EXTRA_CA_CERTS;" + OPEN_SHELL_WORKER_BOOTSTRAP;
    const expectMissing = (file: string) =>
      expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const invoke = (credential?: string, target?: string) =>
      runUtf8CommandWithTimeout([process.execPath, "-e", bootstrap], {
        input: JSON.stringify({ worker, config: nodeConfig(worker), target }),
        timeoutMs: 5000,
        killProcessTree: true,
        env: {
          OPENAI_API_KEY: credential,
          SSL_CERT_FILE: "/nonexistent-synthetic-ca",
          OPENCLAW_GATEWAY_TOKEN: "must-not-inherit",
        },
      });
    for (const credential of [undefined, "synthetic-raw-api-key"]) {
      const rejected = await invoke(credential, "synthetic-pairing-target");
      expect(rejected).toMatchObject({ code: 1, stdout: "" });
      expect(rejected.stderr).toContain("broker placeholder");
      await expectMissing(worker.stateDir);
    }
    const result = await invoke(brokerCredential, "synthetic-pairing-target");
    expect(result.code, result.stderr).toBe(0);
    const received = JSON.parse(result.stdout);
    expect(received.args).toEqual(["connect", "--target-file", pairingFile, "--session-host"]);
    expect(received).toMatchObject({
      target: "synthetic-pairing-target",
      placeholder: true,
      ca: "/nonexistent-synthetic-ca",
    });
    expect(received.unsafe).toBeUndefined();
    expect(received.config.models.providers.openai.apiKey).toBe("${OPENAI_API_KEY}");
    expect(received.config.nodeHost.workerRuns).toEqual({ enabled: true, isolation: "none" });
    expect(received.config.models.providers.openai.models[0]).not.toHaveProperty("credentialEnv");
    await expectMissing(pairingFile);
    const resumed = await invoke("openshell:resolve:env:synthetic-new-reference");
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).args).toEqual(["node", "run", "--session-host"]);

    worker.agentWorkspace = { agentId: "main", remoteRoot: path.join(home, "agent-files") };
    worker.stateDir = path.join(home, "bound-node-state");
    const absent = await invoke(brokerCredential);
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("Prepare the canonical agent workspace");
    await expectMissing(worker.stateDir);
    await fs.mkdir(worker.agentWorkspace.remoteRoot, { mode: 0o700 });
    const document = path.join(worker.agentWorkspace.remoteRoot, "AGENTS.md");
    await fs.writeFile(document, "Preserve these remote instructions");
    const bound = await invoke(brokerCredential);
    expect(bound.code, bound.stderr).toBe(0);
    const { agents, plugins } = JSON.parse(bound.stdout).config;
    const workspace = worker.agentWorkspace.remoteRoot;
    expect(agents.defaults).toMatchObject({ workspace, skipBootstrap: true });
    expect(agents.entries.main.workspace).toBe(workspace);
    expect(plugins.entries["file-transfer"].enabled).toBe(true);
    await fs.writeFile(document, "Edited by another session");
    expect((await invoke(brokerCredential)).code).toBe(0);
    expect(await fs.readFile(document, "utf8")).toBe("Edited by another session");
    const alias = path.join(home, "agent-alias");
    await fs.symlink(worker.agentWorkspace.remoteRoot, alias);
    worker.agentWorkspace.remoteRoot = alias;
    const redirected = await invoke(brokerCredential);
    expect(redirected.code).toBe(1);
    expect(redirected.stderr).toContain("without symlink aliases");
    worker.agentWorkspace.remoteRoot = worker.stateDir;
    expect((await invoke(brokerCredential)).stderr).toContain("separate from private node state");
  });
});
