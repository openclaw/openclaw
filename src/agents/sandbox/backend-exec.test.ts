import { expect, test } from "vitest";
import { buildSandboxExecInvocation } from "./backend-exec.js";

test("opensandbox foreground invocation preserves merged env payload", () => {
  const result = buildSandboxExecInvocation({
    sandbox: {
      backendKind: "opensandbox",
      opensandboxBaseUrl: "https://sandbox.example.test/execd",
      opensandboxAccessToken: "token-1",
      opensandboxTimeoutSec: 60,
      containerName: "unused",
      workspaceDir: "/tmp/ws",
      containerWorkdir: "/workspace",
    },
    command: "printenv",
    workdir: "/workspace",
    env: {
      FOO: "bar",
      PATH: "/usr/local/bin:/usr/bin",
    },
    tty: false,
  });

  expect(result.backendId).toBe("exec-sandbox-opensandbox");
  expect(result.env.OPENCLAW_OPENSANDBOX_ENV_JSON).toBe(
    JSON.stringify({
      FOO: "bar",
      PATH: "/usr/local/bin:/usr/bin",
    }),
  );
});
