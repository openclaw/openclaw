import { resolveHermesBridgeConfig } from "../src/config.js";
import { createMockHermesClient, createMockOpenClawBridge } from "../src/mock-hermes-client.js";

const config = resolveHermesBridgeConfig({
  enabled: true,
  mode: "mock",
  allowedTasks: [
    "status.echo",
    "status.health",
    "message.preview",
    "tasks.organize_today",
    "agents.ask_team",
  ],
  allowedTools: [],
});

const bridge = createMockOpenClawBridge(config);
const hermes = createMockHermesClient({ bridge });

const result = await hermes.delegateTask({
  taskId: "tasks.organize_today",
  idempotencyKey: "demo-tasks-organize-today",
  intent: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
  allowedTools: [],
  dryRun: true,
  input: {
    request: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
  },
});

console.log(JSON.stringify(result, null, 2));
