import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, expect, it } from "vitest";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

const dirs = useSessionStoreTempDirs(afterAll, "codex-catalog-disposal-");

it("cancels a cold catalog before client admission when its harness is disposed", async ({
  signal,
}) => {
  const root = dirs.make();
  const executable = path.join(root, "catalog.mjs");
  const receipts = path.join(root, "requests.jsonl");
  await fs.writeFile(
    executable,
    `
import fs from "node:fs";
import { createInterface } from "node:readline";
const receipt = (method) => fs.appendFileSync(${JSON.stringify(receipts)}, JSON.stringify({ pid: process.pid, method }) + "\\n");
receipt("started");
let account = null;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  receipt(message.method);
  let result = {};
  if (message.method === "initialize") {
    result = { userAgent: "codex-cli/${CODEX_APP_SERVER_VERSION}", codexHome: process.env.CODEX_HOME };
  } else if (message.method === "account/login/start") {
    account = { type: "apiKey" };
    result = { type: "apiKey" };
  } else if (message.method === "account/read") {
    result = { account, requiresOpenaiAuth: true };
  } else if (message.method === "model/list") {
    result = { data: [{ id: "synthetic-model", model: "synthetic-model", displayName: "Synthetic model", description: "Fixture", hidden: false, isDefault: true, defaultReasoningEffort: "medium", inputModalities: ["text"], supportedReasoningEfforts: [] }], nextCursor: null };
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  const { stdout } = await promisify(execFile)(
    resolveTestNodeExecPath(),
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "--eval",
      `
        import assert from "node:assert/strict";
        import fs from "node:fs/promises";
        import path from "node:path";
        import { registerHooks } from "node:module";
        import { pathToFileURL } from "node:url";
        const root = ${JSON.stringify(root)};
        process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
        process.env.CODEX_HOME = path.join(root, "native-home");
        process.env.OPENAI_API_KEY = "synthetic-catalog-key";
        process.env.CODEX_API_KEY = "";
        process.env.CODEX_ACCESS_TOKEN = "";
        globalThis.fetch = async () => { throw new Error("Catalog fixture must not access the network"); };
        const sourceURL = (file) => pathToFileURL(path.join(process.cwd(), "extensions/codex", file)).href;
        const owner = sourceURL("src/app-server/request.ts");
        const sharedURL = sourceURL("src/app-server/shared-client.ts");
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const acquired = [];
        globalThis.catalogImportGate = { entered, release, acquired };
        // Hold evaluation, then forward to the real client, startup, auth, and transport owners.
        const fixture = "data:text/javascript," + encodeURIComponent(\`
          const gate = globalThis.catalogImportGate;
          gate.entered.resolve();
          await gate.release.promise;
          const shared = await import(\${JSON.stringify(sharedURL)});
          export const createIsolatedCodexAppServerClient = shared.createIsolatedCodexAppServerClient;
          export const releaseLeasedSharedCodexAppServerClient = shared.releaseLeasedSharedCodexAppServerClient;
          export function getLeasedSharedCodexAppServerClient(options) {
            gate.acquired.push(options.agentDir);
            return shared.getLeasedSharedCodexAppServerClient(options);
          }
        \`);
        const hooks = registerHooks({
          resolve(specifier, context, next) {
            if (context.parentURL === owner && specifier === "./shared-client.js") {
              return { url: fixture, shortCircuit: true };
            }
            return next(specifier, context);
          },
        });
        const harnesses = [];
        let loading;
        try {
          const { createCodexAppServerAgentHarness } = await import(sourceURL("harness.ts"));
          const { codexBuildSymbol } = await import(sourceURL("src/build-state.ts"));
          const disposer = codexBuildSymbol("openclaw.codexAppServerClientDisposer");
          const pluginConfig = { appServer: { command: process.execPath, args: [${JSON.stringify(executable)}, "app-server"] } };
          const makeHarness = () => {
            const harness = createCodexAppServerAgentHarness({
              bindingStore: {},
              pluginConfig,
              runtime: { modelAuth: {
                ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
                resolveAuthProfileOrder: () => [],
              } },
            });
            harnesses.push(harness);
            return harness;
          };
          const params = { config: {}, agentId: "main", agentDir: path.join(root, "retired"), workspaceDir: root };
          const readiness = { ...params, provider: "openai", modelId: "synthetic-model" };
          const retired = makeHarness();
          loading = retired.loadModelCatalog(params);
          void loading.then(
            () => entered.reject(new Error("Catalog completed before the held client import")),
            (error) => entered.reject(error),
          );
          await entered.promise;
          assert.equal(globalThis[disposer], undefined, "shared client must still be cold");
          await retired.dispose();
          assert.equal(globalThis[disposer], undefined, "disposal completed before client evaluation");
          release.resolve();
          await assert.rejects(loading, /Codex model catalog is disposed/);
          await import(fixture);
          assert.equal(retired.readModelCatalogReadiness(readiness), undefined);
          assert.deepEqual(acquired, []);
          await assert.rejects(fs.stat(${JSON.stringify(receipts)}), { code: "ENOENT" });

          const current = makeHarness();
          const freshParams = { ...params, agentDir: path.join(root, "current") };
          const catalog = await current.loadModelCatalog(freshParams);
          assert.deepEqual(catalog.entries.map((entry) => entry.id), ["synthetic-model"]);
          assert.equal(catalog.outcomes[0].status, "ready");
          assert.equal(current.readModelCatalogReadiness({ ...readiness, ...freshParams }).accountType, "apiKey");
          assert.deepEqual(acquired, [freshParams.agentDir]);
          const rows = (await fs.readFile(${JSON.stringify(receipts)}, "utf8")).trim().split("\\n").map(JSON.parse);
          assert.equal(rows.filter((row) => row.method === "started").length, 1);
          assert.equal(rows.filter((row) => row.method === "account/login/start").length, 1);
          assert.equal(rows.filter((row) => row.method === "model/list").length, 1);
          await current.dispose();
          assert.equal(current.readModelCatalogReadiness({ ...readiness, ...freshParams }), undefined);
          for (const pid of new Set(rows.map((row) => row.pid))) {
            assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
          }
          console.log("cold catalog disposal and fresh admission passed");
        } finally {
          release.resolve();
          await loading?.catch(() => {});
          await Promise.all(harnesses.map((harness) => harness.dispose()));
          hooks.deregister();
          delete globalThis.catalogImportGate;
        }
      `,
    ],
    { cwd: process.cwd(), signal, timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  expect(stdout).toContain("cold catalog disposal and fresh admission passed");
});
