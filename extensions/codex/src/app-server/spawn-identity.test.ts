import { expect, it } from "vitest";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveCodexAppServerSpawnIdentity } from "./spawn-identity.js";

it("fingerprints argv without exposing secret-shaped config overrides", () => {
  const startOptions: CodexAppServerStartOptions = {
    transport: "stdio",
    headers: {},
    homeScope: "agent",
    command: "/usr/local/bin/codex",
    commandSource: "config",
    args: ["-c", "provider.api_key=super-secret-value", "app-server"],
  };
  const identity = resolveCodexAppServerSpawnIdentity(startOptions);
  const otherArgsIdentity = resolveCodexAppServerSpawnIdentity({
    ...startOptions,
    args: ["app-server"],
  });

  expect(identity.argsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(otherArgsIdentity.argsFingerprint).not.toBe(identity.argsFingerprint);
  expect(JSON.stringify(identity)).not.toContain("super-secret-value");
});
