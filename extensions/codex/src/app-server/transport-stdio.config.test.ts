import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { withEphemeralCodexAuthStore } from "./auth-start-options.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { createCodexNativeTestState } from "./native-app-server.test-support.js";
import type { CodexInitializeResponse } from "./protocol.js";
import { createStdioTransport } from "./transport-stdio.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.unmock("node:child_process");

const baseUrl = "http://127.0.0.1:9/config-override-probe";
const rootOverrides = [
  "-c",
  `openai_base_url=${JSON.stringify(baseUrl)}`,
  "--config",
  "model_reasoning_effort=high",
];
const mixedArgs = [
  `-copenai_base_url=${JSON.stringify(baseUrl)}`,
  "--config=model_reasoning_effort=low",
  "--config=model_context_window=8192",
  "-cmodel_auto_compact_token_limit=6000",
  "--config=model_auto_compact_token_limit_scope=total",
  "--disable",
  "fast_mode",
  "app-server",
  "-c=model_reasoning_effort=high",
  "--config",
  'cli_auth_credentials_store="file"',
  "--listen",
  "stdio://",
];
const expectedConfig = {
  openai_base_url: baseUrl,
  model_reasoning_effort: "high",
  cli_auth_credentials_store: "ephemeral",
};
const expectedMixedConfig = {
  ...expectedConfig,
  model_context_window: 8192,
  model_auto_compact_token_limit: 6000,
  model_auto_compact_token_limit_scope: "total",
  features: { fast_mode: false },
};

const cases = [
  "managed package",
  "root overrides",
  "mixed overrides",
  "node wrapper",
  "shell wrapper",
  "shell marker values",
  "native auth",
] as const;
type NativeConfigCase = (typeof cases)[number];

function invocation(mode: NativeConfigCase, command: string, launcher: string) {
  switch (mode) {
    case "managed package":
      return { command: "codex", args: [...mixedArgs] };
    case "root overrides":
      return { command, args: [...rootOverrides, "app-server", "--listen", "stdio://"] };
    case "node wrapper":
      return { command: process.execPath, args: [launcher, ...mixedArgs, "--"] };
    case "shell wrapper":
      return { command: "/bin/sh", args: ["-c", 'exec "$@"', "--", command, ...mixedArgs, "--"] };
    case "shell marker values":
      return {
        command: "/bin/sh",
        args: [
          "-c",
          'exec "$@" app-server --listen stdio://',
          "--",
          command,
          "--model",
          "app-server",
          "--image",
          "photo.png",
          "app-server",
          ...rootOverrides,
        ],
      };
    default:
      return { command, args: [...mixedArgs] };
  }
}

async function readNativeConfig(startOptions: CodexAppServerStartOptions, env: NodeJS.ProcessEnv) {
  const child = await createStdioTransport(startOptions, env);
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const client = CodexAppServerClient.fromTransportForTests(child);
  try {
    const deadline = performance.now() + 60_000;
    const initialized = await client.request<CodexInitializeResponse>(
      "initialize",
      {
        clientInfo: { name: "openclaw_config_test", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: Math.max(1, deadline - performance.now()) },
    );
    expect(initialized.userAgent).toContain(`/${CODEX_APP_SERVER_VERSION} `);
    client.notify("initialized", {});
    return await client.request(
      "config/read",
      { includeLayers: false, cwd: startOptions.cwd },
      { timeoutMs: Math.max(1, deadline - performance.now()) },
    );
  } finally {
    expect(await client.closeAndWait()).toMatchObject({ exited: true });
    await closed;
  }
}

describe("Codex stdio effective configuration", () => {
  it.for(cases)("preserves %s", { timeout: 75_000 }, async (mode, context) => {
    if (mode.startsWith("shell") && process.platform === "win32") {
      context.skip();
    }
    await withTempDir("openclaw-codex-config-", async (dir) => {
      const root = await fs.realpath(dir);
      const { command, launcher, cwd, codexHome, env } = await createCodexNativeTestState(root);
      if (mode === "managed package") {
        // Exercise the real package launcher without any alternate Node on PATH.
        env.PATH = path.join(root, "no-path-executables");
      }
      // No auth, inference, model discovery, or operator-home access is needed.
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        'cli_auth_credentials_store="file"\n[features]\nrespect_system_proxy=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n',
      );
      const options: CodexAppServerStartOptions = {
        ...invocation(mode, command, launcher),
        transport: "stdio",
        commandSource: mode === "managed package" ? "managed" : "config",
        cwd,
        headers: {},
      };
      const start = withEphemeralCodexAuthStore({
        startOptions: await resolveManagedCodexAppServerStartOptions(options, {
          pluginRoot: fileURLToPath(new URL("../../", import.meta.url)),
        }),
        authProfileId: mode === "native auth" ? null : undefined,
      });
      const { config } = await readNativeConfig(start, env);
      const expected =
        mode === "root overrides" || mode === "shell marker values"
          ? expectedConfig
          : expectedMixedConfig;
      expect(config).toMatchObject(
        mode === "native auth" ? { ...expected, cli_auth_credentials_store: "file" } : expected,
      );
      await expect(fs.access(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
