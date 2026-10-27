/** Seed durable synthetic Usage data, then hand it to a separate built Gateway. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { captureRuntimeConfigAsyncReader } from "../../src/config/config.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../../src/config/sessions/session-accessor.js";
import { promptReport } from "../../src/config/sessions/system-prompt-report.test-support.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

type Setup = { uiRoot: string; sessions: number; port: number };
export type UsageBenchFixture = {
  channel: "usage-volume-fixture";
  action: "seeded";
  root: string;
  home: string;
  stateDir: string;
  configPath: string;
  startDate: string;
  endDate: string;
  sessions: number;
  allTokens: number;
  models: Record<string, { sessions: number; tokens: number }>;
};
const setup = JSON.parse(await readFile(process.argv[2]!, "utf8")) as Setup;
if (!process.send) {
  throw new Error("Proof child requires managed IPC");
}
const token = process.env.OPENCLAW_USAGE_BENCH_TOKEN;
delete process.env.OPENCLAW_USAGE_BENCH_TOKEN;
if (!token) {
  throw new Error("Proof child requires a generated fixture credential");
}
const send = (value: object) =>
  new Promise<void>((resolve, reject) => {
    process.send!(value, (error) => (error ? reject(error) : resolve()));
  });
const state = await createOpenClawTestState({
  label: "usage-model-cohort-volume",
  env: {
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
  },
});
let handedOff = false;
const dayMs = 86_400_000;
const end = Date.parse(new Date().toISOString().slice(0, 10));
const start = end - 179 * dayMs;
const model = (index: number) => `fixture-model-${String(index).padStart(2, "0")}-end`;
const totals = new Map<string, { sessions: number; tokens: number }>();
try {
  await state.writeConfig({
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    gateway: {
      mode: "local",
      port: setup.port,
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: true, root: setup.uiRoot },
      tailscale: { mode: "off" },
    },
    plugins: { enabled: false },
    session: {
      store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
  });
  await captureRuntimeConfigAsyncReader()();
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  let allTokens = 0;
  for (let index = 0; index < setup.sessions; index++) {
    const sessionId = `usage-volume-${index}`;
    const timestamp = start + (index % 180) * dayMs + 12 * 3_600_000;
    const baseModel = index % 96;
    const models = index % 16 === 0 ? [baseModel, (baseModel + 1) % 96] : [baseModel];
    const tokens = 100 + index;
    const sessionTokens = tokens * models.length;
    allTokens += sessionTokens;
    for (const item of models) {
      const previous = totals.get(model(item)) ?? { sessions: 0, tokens: 0 };
      previous.sessions++;
      previous.tokens += sessionTokens;
      totals.set(model(item), previous);
    }
    const scope = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId, storePath };
    replaceSessionEntrySync(scope, {
      sessionId,
      label: `Usage volume ${index}`,
      updatedAt: timestamp,
      ...(index % 8 === 0 ? { systemPromptReport: promptReport(timestamp, 100, 0) } : {}),
    });
    await persistSessionTranscriptTurn(scope, {
      cwd: state.workspaceDir,
      updateMode: "none",
      messages: models.map((item) => ({
        now: timestamp,
        message: {
          role: "assistant" as const,
          content: "Synthetic usage volume proof",
          timestamp,
          provider: "synthetic",
          model: model(item),
          usage: {
            input: tokens,
            output: 0,
            totalTokens: tokens,
            cost: { total: tokens / 10_000 },
          },
        },
      })),
    });
  }
  // Close source-owned writers before the compiled process opens this durable state.
  await state.restoreEnv();
  const fixture: UsageBenchFixture = {
    channel: "usage-volume-fixture",
    action: "seeded",
    root: state.root,
    home: state.home,
    stateDir: state.stateDir,
    configPath: state.configPath,
    startDate: new Date(start).toISOString().slice(0, 10),
    endDate: new Date(end).toISOString().slice(0, 10),
    sessions: setup.sessions,
    allTokens,
    models: Object.fromEntries(totals),
  };
  await send(fixture);
  handedOff = true;
} finally {
  if (!handedOff) {
    await state.cleanup();
  }
  process.disconnect?.();
}
