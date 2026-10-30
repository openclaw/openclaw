import { expect, it } from "vitest";
import { resolveCodexAppServerSpawnIdentity } from "./spawn-identity.js";

it("fingerprints argv without exposing secret-shaped config overrides", () => {
  const identity = resolveCodexAppServerSpawnIdentity({
    transport: "stdio",
    headers: {},
    homeScope: "agent",
    command: "/usr/local/bin/codex",
    commandSource: "config",
    args: ["-c", "provider.api_key=super-secret-value", "app-server"],
  });

  expect(identity.argsFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(identity)).not.toContain("super-secret-value");
});
