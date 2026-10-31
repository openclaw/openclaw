import { runExecProcess } from "./bash-tools.exec-runtime.js";

export function runExecFixture(overrides: Partial<Parameters<typeof runExecProcess>[0]> = {}) {
  return runExecProcess({
    command: "test-command",
    workdir: "/tmp",
    env: {},
    usePty: false,
    warnings: [],
    maxOutput: 1000,
    pendingMaxOutput: 1000,
    notifyOnExit: false,
    timeoutSec: null,
    ...overrides,
  });
}
