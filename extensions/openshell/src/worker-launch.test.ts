import fs from "node:fs/promises";
import path from "node:path";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { resolveOpenShellPluginConfig } from "./config.js";
import { createOpenShellWorkerNodeConfig, OPEN_SHELL_WORKER_BOOTSTRAP } from "./worker-launch.js";

it("rejects raw/missing credentials before launch and carries broker auth, CA, and private pairing to the node", async () => {
  await withTempHome(async (home) => {
    const executable = path.join(home, "openclaw-fixture");
    await fs.writeFile(
      executable,
      "#!" +
        process.execPath +
        "\n" +
        String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const target = args.includes("--target-file") ? fs.readFileSync(args[args.indexOf("--target-file") + 1], "utf8") : undefined;
console.log(JSON.stringify({args, target, placeholder: process.env.OPENAI_API_KEY?.startsWith("openshell:resolve:env:"), ca: process.env.NODE_EXTRA_CA_CERTS, unsafe: process.env.OPENCLAW_GATEWAY_TOKEN, config: JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"))}));
`,
      { mode: 0o700 },
    );
    const worker = resolveOpenShellPluginConfig({
      worker: {
        model: {
          provider: "openai",
          id: "worker-model",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          credentialEnv: "OPENAI_API_KEY",
          contextWindow: 8192,
          maxTokens: 1024,
        },
      },
    }).worker!;
    worker.nodeCommand = executable;
    worker.stateDir = path.join(home, "node-state");
    const config = createOpenShellWorkerNodeConfig(worker);
    const input = JSON.stringify({ worker, config, target: "synthetic-pairing-target" });
    const invoke = (credential?: string, body = input) =>
      runUtf8CommandWithTimeout(
        [
          process.execPath,
          "-e",
          "delete process.env.NODE_EXTRA_CA_CERTS;" + OPEN_SHELL_WORKER_BOOTSTRAP,
        ],
        {
          input: body,
          timeoutMs: 5000,
          killProcessTree: true,
          env: {
            OPENAI_API_KEY: credential,
            SSL_CERT_FILE: "/nonexistent-synthetic-ca",
            OPENCLAW_GATEWAY_TOKEN: "must-not-inherit",
          },
        },
      );
    for (const credential of [undefined, "synthetic-raw-api-key"]) {
      const rejected = await invoke(credential);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("broker placeholder");
      expect(rejected.stdout).toBe("");
      await expect(fs.stat(worker.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const result = await invoke("openshell:resolve:env:synthetic-opaque-reference");
    expect(result.code, result.stderr).toBe(0);
    const received = JSON.parse(result.stdout);
    expect(received.args).toEqual([
      "connect",
      "--target-file",
      path.join(worker.stateDir, "pairing-target"),
      "--session-host",
    ]);
    expect(received.target).toBe("synthetic-pairing-target");
    expect(received.placeholder).toBe(true);
    expect(received.ca).toBe("/nonexistent-synthetic-ca");
    expect(received.unsafe).toBeUndefined();
    expect(received.config.models.providers.openai.apiKey).toBe("${OPENAI_API_KEY}");
    expect(received.config.nodeHost.workerRuns).toEqual({ enabled: true, isolation: "none" });
    await expect(fs.stat(path.join(worker.stateDir, "pairing-target"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const resumed = await invoke(
      "openshell:resolve:env:synthetic-new-reference",
      JSON.stringify({ worker, config }),
    );
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout).args).toEqual(["node", "run", "--session-host"]);

    worker.agentWorkspace = { agentId: "main", remoteRoot: path.join(home, "agent-files") };
    worker.stateDir = path.join(home, "bound-node-state");
    const invokeBound = () =>
      invoke(
        "openshell:resolve:env:synthetic-opaque-reference",
        JSON.stringify({ worker, config: createOpenShellWorkerNodeConfig(worker) }),
      );
    const absent = await invokeBound();
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("Prepare the canonical agent workspace");
    await expect(fs.stat(worker.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.mkdir(worker.agentWorkspace.remoteRoot, { mode: 0o700 });
    const document = path.join(worker.agentWorkspace.remoteRoot, "AGENTS.md");
    await fs.writeFile(document, "Preserve these remote instructions");
    const bound = await invokeBound();
    expect(bound.code, bound.stderr).toBe(0);
    expect(JSON.parse(bound.stdout).config).toMatchObject({
      agents: {
        defaults: { workspace: worker.agentWorkspace.remoteRoot, skipBootstrap: true },
        entries: { main: { workspace: worker.agentWorkspace.remoteRoot } },
      },
      plugins: { entries: { "file-transfer": { enabled: true } } },
    });
    await fs.writeFile(document, "Edited by another session");
    expect((await invokeBound()).code).toBe(0);
    expect(await fs.readFile(document, "utf8")).toBe("Edited by another session");
    const alias = path.join(home, "agent-alias");
    await fs.symlink(worker.agentWorkspace.remoteRoot, alias);
    worker.agentWorkspace.remoteRoot = alias;
    const redirected = await invokeBound();
    expect(redirected.code).toBe(1);
    expect(redirected.stderr).toContain("without symlink aliases");
    worker.agentWorkspace.remoteRoot = worker.stateDir;
    expect((await invokeBound()).stderr).toContain("separate from private node state");
  });
});
