import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it } from "vitest";
import { bridgeCodexAppServerStartOptions } from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";

const startOptions: CodexAppServerStartOptions = {
  transport: "stdio",
  command: "codex",
  args: ["app-server"],
  homeScope: "agent",
  headers: {},
};

it("ignores an empty legacy auth object without changing auth ownership", async () => {
  await withTempDir("openclaw-codex-legacy-", async (agentDir) => {
    const codexHome = path.join(agentDir, "codex-home");
    const authPath = path.join(codexHome, "auth.json");
    const contents = " {\n} \n";
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(authPath, contents);
    const result = await bridgeCodexAppServerStartOptions({
      startOptions,
      agentDir,
      authProfileStore: { version: 1, profiles: {} },
    });
    expect(result).toMatchObject({
      args: [
        "-c",
        'cli_auth_credentials_store="ephemeral"',
        "-c",
        "thread_unload_delay_secs=0",
        "app-server",
      ],
      env: { CODEX_HOME: codexHome },
    });
    expect(await fs.readFile(authPath, "utf8")).toBe(contents);
  });
});

it.each([
  ["API key", '{"OPENAI_API_KEY":"synthetic-key"}'],
  ["unknown field", '{"future_credential":"synthetic-value"}'],
  ["malformed JSON", '{"tokens":'],
  ["non-object JSON", "null"],
  ["array", "[]"],
])("preserves the legacy auth diagnostic for %s", async (_label, contents) => {
  await withTempDir("openclaw-codex-legacy-", async (agentDir) => {
    const authPath = path.join(agentDir, "codex-home", "auth.json");
    await fs.mkdir(path.dirname(authPath), { recursive: true });
    await fs.writeFile(authPath, contents);
    await expect(
      bridgeCodexAppServerStartOptions({
        startOptions,
        agentDir,
        authProfileStore: { version: 1, profiles: {} },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
    expect(await fs.readFile(authPath, "utf8")).toBe(contents);
  });
});
