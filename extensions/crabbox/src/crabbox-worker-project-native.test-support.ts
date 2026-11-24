import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import * as tar from "tar";
import { expect, vi } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { SCRUB_WORKER_STATE } from "./crabbox-worker-warm-image-scrub.js";
import {
  createProjectOptions as projectOptions,
  createWarmProvider,
  tempDirs,
} from "./crabbox-worker-warm-image.test-support.js";

// Compile the real installed CLI/cache/prewarm owners with task-local dependencies.
const workerSource =
  'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nif (process.argv[2] !== "--internal-worker-prewarm") throw new Error("Unexpected worker execution");\nfs.appendFileSync(path.join(os.homedir(), "worker-prewarm-count"), "ready\\n");\n';
const bundleHash = "d9e9544399bb6f84cad341cfc113524f63b858efc5db30df9f42a188ebed97f2";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
let nativeCli: Uint8Array | undefined;
type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

export async function createCrabboxProjectNativeVerificationFixture(corrupt: boolean) {
  if (!nativeCli) {
    const repo = process.cwd();
    const compiled = await build({
      stdin: {
        contents:
          "import " +
          JSON.stringify(path.join(repo, "src/infra/sealed-runtime-bootstrap.ts")) +
          '; import { Command } from "commander"; import { registerNodeCli } from ' +
          JSON.stringify(path.join(repo, "src/cli/node-cli/register.ts")) +
          '; const program = new Command().name("openclaw").version("OpenClaw 2026.8.1"); registerNodeCli(program); try { await program.parseAsync(process.argv); } catch (error) { console.error(error.message); process.exitCode = 1; }',
        resolveDir: repo,
        sourcefile: "project-native-verification-cli.ts",
      },
      write: false,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
      plugins: [
        {
          name: "installed-dependencies",
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (args.pluginData?.resolving || args.path.startsWith("node:")) {
                return undefined;
              }
              if (args.path.startsWith("bun:")) {
                return { path: args.path, external: true };
              }
              const resolved = await builder.resolve(args.path, {
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: { resolving: true },
              });
              return resolved.path.includes("/node_modules/")
                ? { path: resolved.path, external: true }
                : undefined;
            });
          },
        },
      ],
    });
    nativeCli = compiled.outputFiles[0]!.contents;
  }
  const home = fs.realpathSync(tempDirs.make("crabbox-project-native-"));
  const source = path.join(home, "worker-source");
  fs.mkdirSync(source);
  const files = {
    "github-exec-launcher.mjs": "export {};\n",
    "worker.mjs": workerSource,
    "workspace-rsync-receiver.mjs": "export {};\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(source, name), contents, { mode: 0o700 });
  }
  const archive = path.join(home, "worker.tgz");
  tar.create(
    { cwd: source, file: archive, gzip: true, sync: true, noDirRecurse: true },
    Object.keys(files),
  );
  const bytes = fs.readFileSync(archive);
  const nodeBootstrap = createNodeBootstrapFixture();
  const workerBundle = {
    url: "https://gateway.example.test/worker",
    token: "synthetic-worker-token",
    sha256: digest(bytes),
    bytes: bytes.length,
    packageRelativePath: "worker-artifacts/" + digest(bytes) + ".tgz",
    bundleHash,
    protocolFeatures: [],
  };
  const packageDir = path.join(
    home,
    ".openclaw-worker/node-runtimes",
    nodeBootstrap.sha256,
    "node_modules/openclaw",
  );
  fs.mkdirSync(path.join(packageDir, "worker-artifacts"), { recursive: true });
  fs.copyFileSync(archive, path.join(packageDir, workerBundle.packageRelativePath));
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.8.1", type: "module" }),
  );
  fs.writeFileSync(path.join(packageDir, "openclaw.mjs"), nativeCli);
  for (const name of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
    fs.copyFileSync(path.resolve("src/state", name), path.join(packageDir, name));
  }
  const expandedWorker = path.join(
    packageDir,
    "worker-artifacts/expanded",
    bundleHash,
    "worker.mjs",
  );
  const events: string[] = [];
  const fixture = projectOptions([]);
  let verifications = 0;
  const { provider, calls } = createWarmProvider((call) => {
    fixture.observe(call);
    if (call.argv[2] === "create") {
      events.push("checkpoint");
    }
    if (
      call.argv[1] !== "run" ||
      call.options.input === "project-checkout" ||
      call.argv.includes("CRABBOX_WORKER_SETUP_CODE")
    ) {
      return undefined;
    }
    const preparing = call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN");
    if (!preparing) {
      verifications++;
      expect(call.argv).not.toContain("--allow-env");
      expect(call.argv).toContain("--no-hydrate");
    } else {
      expect(call.argv).not.toContain("--no-hydrate");
    }
    // Scrubbing has separate proof; never run the guest's /tmp cleanup on this host.
    const script = String(call.options.input).replace(SCRUB_WORKER_STATE, "true");
    const result = spawnSync("/bin/sh", ["-c", script], {
      cwd: home,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        OPENCLAW_LOG_LEVEL: "silent",
        CRABBOX_WORKER_BOOTSTRAP_TOKEN: preparing
          ? JSON.stringify({
              nodeBootstrap: nodeBootstrap.token,
              workerBundle: workerBundle.token,
            })
          : undefined,
      },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    if (preparing && result.status === 0) {
      events.push("prepared");
      expect(fs.readFileSync(expandedWorker, "utf8")).toBe(workerSource);
      if (corrupt) {
        fs.writeFileSync(expandedWorker, "corrupt expanded worker");
      }
    } else if (!preparing && result.status === 0) {
      events.push("native-verified");
    }
    return commandResult({
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  });
  const preparation = {
    key: "c".repeat(64),
    cacheKey: "d".repeat(64),
    purpose: "reserve" as const,
    demandAtMs: Date.now(),
  };
  const inspectPreparedWorkspace = vi.fn(
    async (
      transport: Parameters<NonNullable<ProjectPreparation["inspectPreparedWorkspace"]>>[0],
    ) => {
      if (transport.snapshot) {
        events.push("core-prune");
      }
    },
  );
  const options = {
    ...fixture.options,
    nodeRuntimeIdentity: {
      ...fixture.options.nodeRuntimeIdentity,
      workerBundleSha256: workerBundle.sha256,
    },
    prepareNodeRuntime: async () => ({
      nodeBootstrap,
      workerBundle,
      signal: fixture.options.project.signal,
    }),
    project: { ...fixture.options.project, preparation, inspectPreparedWorkspace },
  };

  return {
    provider,
    calls,
    events,
    options,
    inspectPreparedWorkspace,
    expandedWorker,
    prewarmMarker: path.join(home, "worker-prewarm-count"),
    get verifications() {
      return verifications;
    },
  };
}
