/** Synthetic scheduling barrier; production admission and all effects stay unchanged. */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const gate = process.env.OPENCLAW_CONFIG_RELOAD_FIXTURE_GATE;
assert(gate && process.env.OPENCLAW_STATE_DIR);
const source = fileURLToPath(new URL("../../", import.meta.url));
const owner = "src/auto-reply/reply/session-event-policy.ts";
const preparation = "src/agents/embedded-agent-runner/run/attempt-transcript-lifecycle-prepare.ts";
const owners = new Map(
  [
    owner,
    "src/cron/service/jobs-scheduling.ts",
    "src/cron/service/ops-run-preparation.ts",
    "src/cron/service/timer-outcome-finalization.ts",
    "src/cron/service/timer-outcomes.ts",
    "src/cron/store/run-finalization.worker.ts",
    "src/cron/store/runtime-maintenance.worker.ts",
    "src/cron/store/scheduler-actor.types.ts",
  ].map((file) => [new URL(`../../${file}`, import.meta.url).href, path.join(source, file)]),
);
console.log(
  "OWNER_SOURCES",
  JSON.stringify(
    Object.fromEntries(
      [...owners].map(([url, file]) => [url, hash("sha256", readFileSync(file), "hex")]),
    ),
  ),
);
const preparationUrl = new URL(`../../${preparation}`, import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== preparationUrl) {
      return nextLoad(url, context);
    }
    let code = readFileSync(fileURLToPath(url), "utf8");
    {
      const declaration = "export async function prepareEmbeddedAttemptTranscriptLifecycle(";
      assert(code.includes(declaration));
      code = code.replace(declaration, "async function prepareOriginal(");
      code += `\nexport async function prepareEmbeddedAttemptTranscriptLifecycle(...args) {
        const gateResponse = await fetch(${JSON.stringify(gate)}, { method: 'POST', body: args[0].attempt.sessionKey ?? '' });
        if (await gateResponse.text() === 'patched') {
          const { getRuntimeConfig } = await import('../../../config/config.js');
          const { setTimeout: delay } = await import('node:timers/promises');
          const deadline = Date.now() + 30000;
          while (!getRuntimeConfig().mcp?.servers?.unrelated) {
            if (Date.now() > deadline) throw new Error('Fixture did not observe committed MCP config');
            await delay(10);
          }
        }
        return prepareOriginal(...args);
      }\n`;
    }
    return {
      format: "module",
      source: transformSync(code, { loader: "ts", format: "esm", target: "esnext" }).code,
      shortCircuit: true,
    };
  },
});
const { registerInternalHook } = await import("../../src/hooks/internal-hooks.ts");
registerInternalHook("agent:bootstrap", () => {});
process.argv[1] = fileURLToPath(new URL("../../src/entry.ts", import.meta.url));
await import("../../src/entry.ts");
