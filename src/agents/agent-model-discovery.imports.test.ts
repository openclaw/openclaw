import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

describe("agent model discovery imports", () => {
  it("keeps cold catalog preparation independent of full config IO and validation", () => {
    expect(
      findSourceImportBackedges(
        [
          "src/agents/prepared-model-catalog.worker.ts",
          "src/agents/prepared-model-runtime.full-catalog.ts",
          "src/agents/prepared-model-runtime.scoped-catalog.ts",
          "src/agents/models-config.providers.discovery-auth.runtime.ts",
        ],
        ["src/config/io.runtime.ts", "src/config/zod-schema.ts"],
      ),
    ).toEqual([]);
  });

  it("prepares an API-key catalog without loading OAuth or full config runtimes", async () => {
    await withOpenClawTestState(
      { label: "catalog-auth-import", applyEnv: false },
      async (state) => {
        const entry = new URL(
          "./models-config.providers.discovery-auth.runtime.ts",
          import.meta.url,
        );
        const context = new URL("./models-config.providers.catalog-context.ts", import.meta.url);
        const provider = new URL("../../extensions/openai/openai-provider.ts", import.meta.url);
        const loader = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
        const result = await runNodeScript(
          [
            "--import",
            loader,
            "--input-type=module",
            "--eval",
            `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock } from "node:test";
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (["/auth-profiles/oauth", "/config/config", "/config/io.runtime", "/config/zod-schema"].some(
      (owner) => [".ts", ".js"].some((extension) => resolved.url.endsWith(owner + extension)),
    )) throw new Error("API-key catalog loaded unused auth/config owner: " + resolved.url);
    return resolved;
  },
});
const { prepareProviderDiscoveryAuth } = await import(${JSON.stringify(entry.href)});
const { prepareProviderCatalogRun } = await import(${JSON.stringify(context.href)});
const { buildOpenAIProvider } = await import(${JSON.stringify(provider.href)});
const key = "synthetic-catalog-key";
const agentDir = ${JSON.stringify(state.agentDir())};
const env = { CATALOG_KEY: key };
const auth = { apiKey: key, mode: "api_key", source: "config" };
const authStore = { version: 1, profiles: {
  "openai:env": { type: "api_key", provider: "openai", keyRef: { source: "env", provider: "default", id: "CATALOG_KEY" } },
} };
const preparedAuth = await prepareProviderDiscoveryAuth({
  agentDir, authStore, env,
  resolveProviderApiKey: () => ({ profileId: "openai:env" }),
  resolveProviderAuth: () => auth,
}, {});
assert.equal(preparedAuth.resolveProviderApiKey("openai").discoveryApiKey, key);
const requests = [];
globalThis.fetch = mock.fn(async (url, init) => {
  assert.equal(url, "https://api.openai.com/v1/models");
  requests.push(new Headers(init?.headers).get("authorization"));
  return Response.json({ data: [{ id: "gpt-5.5", object: "model" }] });
});
const prepared = await prepareProviderCatalogRun({
  provider: buildOpenAIProvider(), config: {}, agentDir, workspaceDir: agentDir,
  env, authStore, ...preparedAuth, isActive: () => true,
});
const catalog = await prepared.provider.catalog.run(prepared);
assert.deepEqual(catalog.providers.openai.models.map((model) => model.id), ["gpt-5.5"]);
assert.deepEqual(requests, ["Bearer " + key]);
console.log("catalog-auth-cold-import-ok");`,
          ],
          { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...state.envVars },
          30_000,
          { requireProcessTreeExit: process.platform !== "win32" },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("catalog-auth-cold-import-ok");
      },
    );
  });

  it("keeps prepared catalog metadata independent of streaming execution", () => {
    expect(
      findSourceImportBackedges("src/agents/prepared-model-catalog.worker.ts", [
        "src/agents/ai-transport-runtime-host.ts",
        "packages/ai/src/transports.ts",
      ]),
    ).toEqual([]);
  });

  it("keeps model discovery independent of session execution", () => {
    expect(
      findSourceImportBackedges("src/agents/agent-model-discovery.ts", [
        "src/agents/sessions/agent-session.ts",
      ]),
    ).toEqual([]);
  });
});
