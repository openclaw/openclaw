import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import * as tar from "tar";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readCrabboxRuntimeInstallation } from "../cli-runtime-api.js";
import { createCrabboxNodeRuntimeSetup } from "./crabbox-worker-node-enrollment.js";

const run = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const workerSource =
  'import fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\nif (process.argv[2] !== "--internal-worker-prewarm") throw new Error("Unexpected worker execution");\nfs.appendFileSync(path.join(os.homedir(), "worker-prewarm-count"), "ready\\n");\n';
// Fixed identity of the ordinary three-file installer fixture, produced by the
// canonical worker-manifest owner. Corruption must fail its real validation.
const bundleHash = "d9e9544399bb6f84cad341cfc113524f63b858efc5db30df9f42a188ebed97f2";
let nativeCli: Buffer;
let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close(() => resolve());
    });
  }
  server = undefined;
});

beforeAll(async () => {
  const output = tempDirs.make("crabbox-native-command-");
  const repo = process.cwd();
  // Compile the actual installed node command registration and cache/prewarm
  // owners. External dependencies use this checkout's own frozen installation.
  await build({
    stdin: {
      contents:
        'import { Command } from "commander"; import { registerNodeCli } from ' +
        JSON.stringify(path.join(repo, "src/cli/node-cli/register.ts")) +
        '; const program = new Command().name("openclaw").version("OpenClaw 2026.8.1"); registerNodeCli(program); if (["CRABBOX_WORKER_BOOTSTRAP_TOKEN", "CRABBOX_WORKER_SETUP_CODE", "CRABBOX_WORKER_CODEX_CONFIG"].some((key) => process.env[key])) throw new Error("Transport credentials reached native CLI"); try { await program.parseAsync(process.argv); } catch (error) { console.error(error.message); process.exitCode = 1; }',
      resolveDir: repo,
      sourcefile: "native-preparation-cli.ts",
    },
    outfile: path.join(output, "openclaw.mjs"),
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
  nativeCli = await fs.readFile(path.join(output, "openclaw.mjs"));
});

describe.skipIf(process.platform === "win32")("native package worker preparation", () => {
  it("expands and prewarms before receipt, then verifies without execution or repair", async () => {
    const home = await fs.realpath(tempDirs.make("crabbox-expanded-runtime-"));
    const source = path.join(home, "source");
    const packageDir = path.join(source, "package");
    const workerDir = path.join(home, "worker-source");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.mkdir(workerDir);
    const metadata = JSON.stringify({
      install: "bundle",
      buildId: "native-command-fixture",
      openclawVersion: "2026.8.1",
      platforms: [{ platform: process.platform, arch: process.arch }],
    });
    const files = {
      "openclaw.mjs": nativeCli,
      "package.json": Buffer.from(
        JSON.stringify({ name: "openclaw", version: "2026.8.1", type: "module" }),
      ),
      "node-runtime.json": Buffer.from(metadata),
    };
    for (const [name, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(packageDir, name), contents);
    }
    for (const name of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      await fs.copyFile(path.resolve("src/state", name), path.join(packageDir, name));
    }
    const inventory = JSON.stringify(
      await Promise.all(
        (await fs.readdir(packageDir)).map(async (name) => {
          const contents = await fs.readFile(path.join(packageDir, name));
          const stat = await fs.stat(path.join(packageDir, name));
          return {
            path: "package/" + name,
            size: contents.length,
            mode: stat.mode & 0o777,
            sha256: digest(contents),
          };
        }),
      ),
    );
    await fs.writeFile(path.join(packageDir, "node-runtime.manifest.json"), inventory);
    const nodeArchive = path.join(home, "node.tgz");
    await tar.create({ cwd: source, file: nodeArchive, gzip: true }, ["package"]);
    const workerFiles = {
      "github-exec-launcher.mjs": "export {};\n",
      "worker.mjs": workerSource,
      "workspace-rsync-receiver.mjs": "export {};\n",
    };
    for (const [name, contents] of Object.entries(workerFiles)) {
      await fs.writeFile(path.join(workerDir, name), contents, { mode: 0o700 });
    }
    const workerArchive = path.join(home, "worker.tgz");
    await tar.create(
      { cwd: workerDir, file: workerArchive, gzip: true, noDirRecurse: true },
      Object.keys(workerFiles),
    );
    const nodeBytes = await fs.readFile(nodeArchive);
    const workerBytes = await fs.readFile(workerArchive);
    const requests: string[] = [];
    server = http.createServer((request, response) => {
      if (request.headers.authorization !== "Bearer synthetic-artifact-token") {
        response.writeHead(403).end();
        return;
      }
      const bytes = request.url === "/node" ? nodeBytes : workerBytes;
      requests.push(request.url!);
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected fixture server");
    }
    const nodeBootstrap = {
      url: "http://127.0.0.1:" + address.port + "/node",
      token: "synthetic-artifact-token",
      sha256: digest(nodeBytes),
      bytes: nodeBytes.length,
      install: "bundle" as const,
      buildId: "native-command-fixture",
      manifestSha256: digest(inventory),
      openclawVersion: "2026.8.1",
      enabledPluginIds: [],
      linuxToolchainSetup: 'printf applied > "$HOME/toolchain-ran"\n',
    };
    const workerBundle = {
      url: "http://127.0.0.1:" + address.port + "/worker",
      token: "synthetic-artifact-token",
      sha256: digest(workerBytes),
      bytes: workerBytes.length,
      packageRelativePath: "worker-artifacts/" + digest(workerBytes) + ".tgz",
      bundleHash,
      protocolFeatures: [],
    };
    const params = { leaseId: "cbx_preparation_fixture", nodeBootstrap, workerBundle };
    const identity = {
      nodeBootstrap: {
        sha256: nodeBootstrap.sha256,
        bytes: nodeBootstrap.bytes,
        manifestSha256: nodeBootstrap.manifestSha256,
        buildId: nodeBootstrap.buildId,
        openclawVersion: nodeBootstrap.openclawVersion,
        enabledPluginIds: [],
      },
      workerBundle: {
        sha256: workerBundle.sha256,
        bytes: workerBundle.bytes,
        packageRelativePath: workerBundle.packageRelativePath,
      },
    };
    const execute = (
      setup: ReturnType<typeof createCrabboxNodeRuntimeSetup>,
      env: NodeJS.ProcessEnv = {},
    ) =>
      run("bash", ["-c", setup.command], {
        env: {
          HOME: home,
          PATH: process.env.PATH,
          NODE_COMPILE_CACHE: path.join(home, "compile-cache"),
          ...env,
          ...setup.forwardedEnv,
        },
        timeout: 60000,
      });
    const setup = createCrabboxNodeRuntimeSetup(params);
    const installed = await execute(setup);
    expect(readCrabboxRuntimeInstallation(installed.stdout, identity).disposition).toBe(
      "installed",
    );
    const installedPackage = path.join(
      home,
      ".openclaw-worker/node-runtimes",
      nodeBootstrap.sha256,
      "node_modules/openclaw",
    );
    const expanded = path.join(installedPackage, "worker-artifacts/expanded", bundleHash);
    expect(await fs.readFile(path.join(expanded, "worker.mjs"), "utf8")).toBe(workerSource);
    expect(
      JSON.parse(await fs.readFile(path.join(expanded, "bootstrap-receipt.json"), "utf8")),
    ).toEqual({ bundleHash, openclawVersion: "2026.8.1", protocolFeatures: [] });
    const marker = path.join(home, "worker-prewarm-count");
    expect(await fs.readFile(marker, "utf8")).toBe("ready\n");
    await fs.unlink(marker);
    await fs.unlink(path.join(home, "toolchain-ran"));
    await fs.rm(path.join(home, ".openclaw-worker/runtime-node"), { recursive: true });
    await fs.writeFile(
      path.join(installedPackage, "worker-artifacts", "e".repeat(64) + ".tgz"),
      "retained image archive",
    );
    const verify = createCrabboxNodeRuntimeSetup({ ...params, verifyOnly: true });
    expect(verify.forwardedEnv).toEqual({});
    expect(verify.command).not.toContain(nodeBootstrap.token);
    const snapshot = async () =>
      Promise.all(
        (await listDirectoryTreeStrict(home)).map(async ({ relativePath }) => {
          const file = path.join(home, relativePath);
          const stat = await fs.lstat(file);
          return [
            relativePath,
            stat.mode,
            stat.mtimeMs,
            stat.isFile() ? digest(await fs.readFile(file)) : null,
          ];
        }),
      );
    const before = await snapshot();
    const verified = await execute(verify, {
      CRABBOX_WORKER_BOOTSTRAP_TOKEN: "synthetic-not-json",
      CRABBOX_WORKER_SETUP_CODE: "synthetic-enrollment",
      CRABBOX_WORKER_CODEX_CONFIG: "synthetic-codex-settings",
    });
    expect(readCrabboxRuntimeInstallation(verified.stdout, identity).disposition).toBe(
      "existing-verified",
    );
    expect(await snapshot()).toEqual(before);
    await fs.writeFile(path.join(expanded, "worker.mjs"), "corrupt code");
    const corrupt = await snapshot();
    await expect(execute(verify)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("missing or invalid"),
    });
    expect(await snapshot()).toEqual(corrupt);
    await execute(setup);
    expect(await fs.readFile(path.join(expanded, "worker.mjs"), "utf8")).toBe(workerSource);
    expect(await fs.readFile(marker, "utf8")).toBe("ready\n");
    await execute(setup);
    expect(await fs.readFile(marker, "utf8")).toBe("ready\nready\n");
    expect(requests.toSorted()).toEqual(["/node", "/worker"]);
    await expect(
      fs.stat(path.join(home, ".openclaw/cloud-workers", params.leaseId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
