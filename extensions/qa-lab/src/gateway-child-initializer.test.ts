import { expect, it, vi } from "vitest";
import { initializeQaGatewayChildState } from "./gateway-child-initializer.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(async () => "") }));
vi.mock("./gateway-child-command.js", () => ({ runQaGatewayCliCommand: mocks.run }));

it("initializes through the exact configured CLI and isolated environment", async () => {
  const lifetime = new QaGatewayChildLifecycle();
  const env = { HOME: "/isolated/home", OPENCLAW_STATE_DIR: "/isolated/state" };
  const params = {
    executablePath: "/configured/launcher",
    argsPrefix: ["--configured-prefix"],
    cwd: "/isolated/cwd",
    env,
    lifetime,
  };
  await initializeQaGatewayChildState(params);
  expect(mocks.run).toHaveBeenCalledExactlyOnceWith({
    executablePath: "/configured/launcher",
    argsPrefix: ["--configured-prefix"],
    args: ["qa", "initialize"],
    cwd: "/isolated/cwd",
    env: { ...env, OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1" },
    lifetime,
  });
  expect(env).not.toHaveProperty("OPENCLAW_ENABLE_PRIVATE_QA_CLI");
});
