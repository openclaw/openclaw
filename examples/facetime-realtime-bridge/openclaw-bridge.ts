import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config/io.runtime.js";
import { coerceSecretRef } from "../../src/config/types.secrets.js";
import { resolveSecretRefString } from "../../src/secrets/resolve.js";

function readValue(value: unknown, pathSegments: string[]): unknown {
  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

async function main() {
  const sourceConfig = loadConfig({ pin: false });
  const candidates = [
    ["talk", "realtime", "providers", "openai", "apiKey"],
    ["plugins", "entries", "voice-call", "config", "realtime", "providers", "openai", "apiKey"],
    ["models", "providers", "openai", "apiKey"],
  ];
  let apiKey: string | undefined;
  let resolvedEnvSecretId: string | undefined;
  for (const candidate of candidates) {
    if (apiKey) {
      break;
    }
    const configured = readValue(sourceConfig, candidate);
    const ref = coerceSecretRef(configured, sourceConfig.secrets?.defaults);
    if (ref) {
      apiKey = await resolveSecretRefString(ref, {
        config: sourceConfig,
        env: process.env,
      });
      if (ref.source === "env") {
        resolvedEnvSecretId = ref.id;
      }
      break;
    }
    if (typeof configured === "string" && configured.trim()) {
      apiKey = configured.trim();
      break;
    }
  }
  apiKey ??= process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "No OpenAI Platform API key was found in OpenClaw talk, voice-call, or model provider config.",
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const bridgeEnv = { ...process.env, OPENAI_API_KEY: apiKey };
  if (resolvedEnvSecretId && resolvedEnvSecretId !== "OPENAI_API_KEY") {
    delete bridgeEnv[resolvedEnvSecretId];
  }
  const child = spawn(process.execPath, [path.join(here, "bridge.mjs"), ...process.argv.slice(2)], {
    env: bridgeEnv,
    stdio: "inherit",
  });
  const forwardSignal = (signal: NodeJS.Signals) => {
    child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
  });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
