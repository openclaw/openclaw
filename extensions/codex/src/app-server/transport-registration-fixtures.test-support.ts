import { vi, type TestContext } from "vitest";
import { RegistrationTestChildProcess } from "./transport-process-registration.test-support.js";

export const registrationStoreOptions = {
  namespace: "app-server-processes",
  maxEntries: 512,
  overflowPolicy: "reject-new",
} as const;

export function createRegistrationChild(ctx: TestContext, pid = 500002) {
  const child = new RegistrationTestChildProcess(pid);
  ctx.onTestFinished(() => {
    [child.stdin, child.stdout, child.stderr].forEach((stream) => stream.destroy());
    child.removeAllListeners();
  });
  return child;
}

export function registrationServiceContext(stateDir: string, warn = vi.fn()) {
  return { config: {}, stateDir, logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } };
}
