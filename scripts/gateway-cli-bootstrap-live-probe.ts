import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeConfigSnapshot, loadConfig } from "../src/config/config.js";
import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { extractPayloadText } from "../src/gateway/test-helpers.agent-results.js";
import { getFreePortBlockWithPermissionFallback } from "../src/test-utils/ports.js";
import { GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";

const DEFAULT_CODEX_ARGS = [
  "exec",
  "--json",
  "--color",
  "never",
  "--sandbox",
  "read-only",
  "--skip-git-repo-check",
];

async function connectClient(params: { url: string; token: string }) {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };
    const client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: "test",
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: (code, reason) =>
        finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) }),
    });
    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      10_000,
    );
    connectTimeout.unref();
    client.start();
  });
}

async function getFreeGatewayPort(): Promise<number> {
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 40_000,
  });
}

async function main() {
  const preservedEnv = new Set(
    JSON.parse(process.env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV ?? "[]") as string[],
  );
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inline-bootstrap-"));
  const workspaceRootDir = path.join(tempDir, "workspace");
  const workspaceDir = path.join(workspaceRootDir, "dev");
  const soulSecret = `SOUL-${randomUUID()}`;
  const identitySecret = `IDENTITY-${randomUUID()}`;
  const userSecret = `USER-${randomUUID()}`;
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "When the user sends a BOOTSTRAP_CHECK token, reply with exactly:",
      `BOOTSTRAP_OK ${soulSecret} ${identitySecret} ${userSecret}`,
      "Do not add any other words or punctuation.",
    ].join("\n"),
  );
  await fs.writeFile(path.join(workspaceDir, "SOUL.md"), `${soulSecret}\n`);
  await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), `${identitySecret}\n`);
  await fs.writeFile(path.join(workspaceDir, "USER.md"), `${userSecret}\n`);

  const cfg = loadConfig();
  const existingBackends = cfg.agents?.defaults?.cliBackends ?? {};
  const codexBackend = existingBackends["codex-cli"] ?? {};
  const cliCommand =
    process.env.OPENCLAW_LIVE_CLI_BACKEND_COMMAND ?? codexBackend.command ?? "codex";
  const cliArgs = codexBackend.args ?? DEFAULT_CODEX_ARGS;
  const cliClearEnv = (codexBackend.clearEnv ?? []).filter((name) => !preservedEnv.has(name));
  const preservedCliEnv = Object.fromEntries(
    [...preservedEnv]
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const nextCfg = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        workspace: workspaceRootDir,
        model: { primary: "codex-cli/gpt-5.4" },
        models: { "codex-cli/gpt-5.4": {} },
        cliBackends: {
          ...existingBackends,
          "codex-cli": {
            ...codexBackend,
            command: cliCommand,
            args: cliArgs,
            clearEnv: cliClearEnv.length > 0 ? cliClearEnv : undefined,
            env: Object.keys(preservedCliEnv).length > 0 ? preservedCliEnv : undefined,
            systemPromptWhen: "first",
          },
        },
        sandbox: { mode: "off" },
      },
    },
  };
  const tempConfigPath = path.join(tempDir, "openclaw.json");
  await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);
  process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

  const port = await getFreeGatewayPort();
  const token = `test-${randomUUID()}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = token;

  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token },
    controlUiEnabled: false,
  });
  const client = await connectClient({ url: `ws://127.0.0.1:${port}`, token });
  try {
    const payload = await client.request(
      "agent",
      {
        sessionKey: `agent:dev:inline-cli-bootstrap-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        message: `BOOTSTRAP_CHECK ${randomUUID()}`,
        deliver: false,
      },
      { expectFinal: true, timeoutMs: 60_000 },
    );
    const text = extractPayloadText(payload?.result);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        text,
        expectedText: `BOOTSTRAP_OK ${soulSecret} ${identitySecret} ${userSecret}`,
        systemPromptReport: payload?.result?.meta?.systemPromptReport ?? null,
      })}\n`,
    );
  } finally {
    await client.stopAndWait();
    await server.close({ reason: "bootstrap live probe done" });
    await fs.rm(tempDir, { recursive: true, force: true });
    clearRuntimeConfigSnapshot();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
}
