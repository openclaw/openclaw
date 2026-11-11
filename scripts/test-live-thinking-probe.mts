// Runs the live thinking probe for one model across provider routes. Local use only, never CI.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isCiEnvironment, requirePinnedBun } from "./lib/pinned-bun.mts";
import { resolveTestRuntime } from "./lib/test-runtime.mts";
import { main as runTestLive } from "./test-live.mts";

const usage =
  "Usage: pnpm test:live:thinking-probe -- --provider <id> --model <id> [--routes <id,id>]";

function parseThinkingProbeArgs(argv: string[]) {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      routes: { type: "string" },
    },
  });
  if (!values.provider || !values.model) {
    throw new Error(usage);
  }
  return { model: values.model, routes: values.routes ?? values.provider };
}

if (import.meta.main) {
  if (isCiEnvironment(process.env)) {
    throw new Error("the thinking probe spends personal API keys and never runs in CI");
  }
  const { model, routes } = parseThinkingProbeArgs(process.argv.slice(2));
  // Live setup copies auth stores and credentials from HOME. An empty HOME keeps
  // the probe on exported env keys only.
  const home = mkdtempSync(path.join(os.tmpdir(), "openclaw-thinking-probe-home-"));
  const env = { ...process.env };
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  // Resolve the runtime and pinned Bun under the real HOME, before the swap hides it.
  const runtime = resolveTestRuntime(env);
  try {
    await runTestLive(["--no-quiet", "--", "src/gateway/gateway-thinking-probe.live.test.ts"], {
      ...env,
      OPENCLAW_VITEST_RUNTIME: runtime,
      ...(runtime === "bun" ? { OPENCLAW_BUN_PATH: requirePinnedBun(env) } : {}),
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_LIVE_THINKING_PROBE_MODEL: model,
      OPENCLAW_LIVE_THINKING_PROBE_ROUTES: routes,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
