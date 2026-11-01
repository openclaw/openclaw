// These process tests boot packaged Gateway/node owners that the import graph cannot follow.
export const NODE_WORKER_E2E_TEST_FILES = [
  "test/e2e/qa-lab/runtime/cloud-worker-midturn-loss.e2e.test.ts",
  "test/e2e/qa-lab/runtime/codex-node-app-server.e2e.test.ts",
  "test/e2e/qa-lab/runtime/codex-node-exec-server.e2e.test.ts",
  "test/e2e/qa-lab/runtime/gateway-node-control-plane.e2e.test.ts",
  "test/e2e/qa-lab/runtime/gateway-node-exec-approvals.e2e.test.ts",
  "test/e2e/qa-lab/runtime/gateway-node-exec-routing.e2e.test.ts",
  "test/e2e/qa-lab/runtime/gateway-node-mcp.stress.e2e.test.ts",
  "test/e2e/qa-lab/runtime/gateway-node-pending-work.e2e.test.ts",
  "test/e2e/qa-lab/runtime/native-worker-slot.e2e.test.ts",
  "test/e2e/qa-lab/runtime/node-worker-launch-wire.e2e.test.ts",
  "test/e2e/qa-lab/runtime/paired-node-worker-lifecycle-wire.e2e.test.ts",
  "test/e2e/qa-lab/runtime/paired-node-worker-upgrade-wire.e2e.test.ts",
  "test/e2e/qa-lab/runtime/required-native-same-session.e2e.test.ts",
  "test/e2e/qa-lab/runtime/skill-library-worker-wire.e2e.test.ts",
] as const;

export const NODE_WORKER_E2E_OWNER_GLOBS = [
  "src/gateway/worker-environments/**",
  "src/node-host/**",
  "src/worker/**",
  "src/gateway/node-*.ts",
  "src/gateway/server-methods/nodes*.ts",
  "src/cli/node-cli.ts",
  "src/cli/node-cli/**",
  "src/infra/node-commands.ts",
  "src/infra/node-runner-inventory*.ts",
  "src/agents/bash-tools.exec-host-node*.ts",
  "src/agents/code-mode-node*.ts",
  "src/agents/openclaw-plugin-tools.ts",
  "packages/gateway-protocol/src/schema/{nodes,worker-admission}.ts",
  "scripts/lib/ci-node-worker-e2e-inventory.mts",
] as const;
