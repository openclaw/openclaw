import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { QA_CHILD_STDERR_TAIL_BYTES } from "./child-output.js";
import { runQaCli } from "./qa-cli-process.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { makeTempDir, cleanup } = createTempDirHarness();
afterEach(cleanup);

async function cliFixture(source: string, staged = false) {
  const repoRoot = await makeTempDir("qa-cli-repo-");
  const tempRoot = await makeTempDir("qa-cli-runtime-");
  const distDir = path.join(repoRoot, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(path.join(distDir, "index.js"), source, "utf8");
  const bundledPluginsDir = path.join(tempRoot, "dist", "extensions");
  const env: Parameters<typeof runQaCli>[0] = {
    repoRoot,
    gateway: {
      tempRoot,
      baseUrl: "http://127.0.0.1:18789",
      workspaceDir: tempRoot,
      call: async () => {
        throw new Error("CLI fixture must not call the gateway");
      },
      runtimeEnv: staged
        ? { ...process.env, OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir }
        : process.env,
    },
  };
  return { env, bundledPluginsDir };
}

it("runs the plugin-owned memory status command with staged CLI metadata", async () => {
  const { env, bundledPluginsDir } = await cliFixture(
    [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const [command, subcommand] = process.argv.slice(2);",
      "const metadataPath = path.join(process.env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? '', 'memory-core', 'cli-metadata.js');",
      "if (command === 'memory' && subcommand === 'status' && fs.existsSync(metadataPath)) {",
      `  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ command, subcommand, status: 'ok', payload: 'x'.repeat(${QA_CHILD_STDERR_TAIL_BYTES + 1}) }) + '\\n', error => error ? reject(error) : resolve()));`,
      "  process.exit(0);",
      "}",
      "console.error(\"error: unknown command 'memory'\");",
      "process.exit(1);",
      "",
    ].join("\n"),
    true,
  );
  await mkdir(path.join(bundledPluginsDir, "memory-core"), { recursive: true });
  await writeFile(
    path.join(bundledPluginsDir, "memory-core", "cli-metadata.js"),
    "export default { id: 'memory-core' };\n",
    "utf8",
  );

  await expect(runQaCli(env, ["memory", "status", "--json"], { json: true })).resolves.toEqual({
    command: "memory",
    subcommand: "status",
    status: "ok",
    payload: "x".repeat(QA_CHILD_STDERR_TAIL_BYTES + 1),
  });
});

it("retains real child output when the qa cli times out", async () => {
  const { env } = await cliFixture(
    [
      'process.stdout.write("timeout stdout marker\\n");',
      'process.stderr.write("timeout stderr marker\\n");',
      "setInterval(() => {}, 60_000);",
      "",
    ].join("\n"),
  );

  const error = await runQaCli(env, ["qa", "suite"], { timeoutMs: 1_000 }).catch(
    (value: unknown) => value,
  );

  expect(error).toMatchObject({ code: "qa_cli_timeout" });
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain("qa cli timed out: openclaw qa suite");
  expect(message).toContain("stdout:\ntimeout stdout marker");
  expect(message).toContain("stderr:\ntimeout stderr marker");
});
