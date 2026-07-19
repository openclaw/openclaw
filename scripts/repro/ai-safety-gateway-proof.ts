#!/usr/bin/env tsx
/** Redacted live-Gateway proof for the AI safety event pipeline. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const proofRoot = await mkdtemp(path.join(tmpdir(), "openclaw-ai-safety-proof-"));
  const workspace = path.join(proofRoot, "workspace");
  const pluginDir = path.join(workspace, ".openclaw", "extensions", "ai-safety-proof");
  const configPath = path.join(proofRoot, "openclaw.json");
  const port = await reserveLoopbackPort();
  const cli = path.resolve("openclaw.mjs");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: proofRoot,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    NO_COLOR: "1",
  };

  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "none" } },
      agents: { defaults: { workspace } },
      plugins: { allow: ["ai-safety-proof"], entries: { "ai-safety-proof": { enabled: true } } },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "ai-safety-proof",
      activation: { onStartup: true },
      safetyEventTypes: ["ai_safety.external_content.consumed"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
      id: "ai-safety-proof",
      register(api) {
        api.registerService({
          id: "ai-safety-proof-emitter",
          start(ctx) {
            const result = ctx.safetyDiagnostics.emit({
              type: "ai_safety.external_content.consumed",
              sessionId: "proof-session-redacted",
              agentId: "proof-agent-redacted",
              channel: "proof",
              sourceType: "api",
              trusted: false
            });
            if (!result.ok) throw new Error(result.reason);
          }
        });
      }
    };\n`,
    { mode: 0o600 },
  );

  const gateway = spawn(
    process.execPath,
    [cli, "gateway", "run", "--allow-unconfigured", "--auth", "none", "--port", String(port)],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let gatewayLog = "";
  gateway.stdout?.on("data", (chunk) => {
    gatewayLog += String(chunk);
  });
  gateway.stderr?.on("data", (chunk) => {
    gatewayLog += String(chunk);
  });

  try {
    let queryText = "";
    let lastError: unknown;
    let matched = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (gateway.exitCode !== null) {
        throw new Error(`Gateway exited before proof query: ${gatewayLog.slice(-1_000)}`);
      }
      try {
        const result = await execFileAsync(
          process.execPath,
          [
            cli,
            "gateway",
            "call",
            "safety.events.list",
            "--params",
            JSON.stringify({ eventType: "ai_safety.external_content.consumed", limit: 10 }),
            "--json",
          ],
          { cwd: process.cwd(), env, timeout: 10_000 },
        );
        queryText = result.stdout;
        const parsed = JSON.parse(queryText) as { events?: unknown[] };
        if (parsed.events?.length) {
          matched = true;
          break;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
    if (!matched) {
      throw new Error(
        `Gateway proof event never became queryable: ${String(lastError)}\n${gatewayLog.slice(-2_000)}`,
      );
    }

    const gatewayResult = JSON.parse(queryText) as {
      events: Array<{ type: string; severity: string; sequence: number; meta?: unknown }>;
    };
    const event = gatewayResult.events.at(-1);
    if (!event) {
      throw new Error("Gateway query returned no plugin-emitted safety event");
    }

    const dbPath = path.join(proofRoot, "state", "openclaw.sqlite");
    const database = new DatabaseSync(dbPath, { readOnly: true });
    const persisted = database
      .prepare(
        "SELECT sequence, event_type, severity, meta_json FROM ai_safety_events WHERE sequence = ?",
      )
      .get(event.sequence) as
      | { sequence: number; event_type: string; severity: string; meta_json: string }
      | undefined;
    database.close();
    if (!persisted) {
      throw new Error("Gateway event was not found in durable SQLite history");
    }

    console.log(
      JSON.stringify(
        {
          proofVersion: 1,
          head: process.env.GITHUB_SHA ?? "local-final-head",
          gateway: {
            process: "production-built openclaw.mjs gateway run",
            transport: "ws-loopback",
            query: "safety.events.list",
          },
          productionBoundary: "external plugin service startup → host-bound safetyDiagnostics.emit",
          emitted: { type: event.type, severity: event.severity },
          persisted: {
            sqlite: true,
            sequenceMatchesGateway: persisted.sequence === event.sequence,
            type: persisted.event_type,
            severity: persisted.severity,
            trustedStoredValue: JSON.parse(persisted.meta_json).trusted,
          },
          redaction: {
            statePath: "[REDACTED_TEMP_STATE]",
            websocketPort: "[REDACTED_LOOPBACK_PORT]",
            sessionId: "[REDACTED_PROOF_SESSION]",
            agentId: "[REDACTED_PROOF_AGENT]",
            token: "none",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await stopChild(gateway);
  }
}

await main();
