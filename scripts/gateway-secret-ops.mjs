#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

const {
  applyLiveApiKey,
  clearLiveApiKey,
  probeLiveApiKey,
  reloadSecrets,
} = await jiti.import("../src/gateway/secret-ops-helper.ts");

const parseArgs = (argv) => {
  const options = {};

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--action") {
      options.action = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--agent-id") {
      options.agentId = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--url") {
      options.url = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--timeout-ms") {
      const rawTimeout = Number(argv[index + 1]);
      if (!Number.isFinite(rawTimeout) || rawTimeout < 1) {
        throw new Error("Invalid --timeout-ms value.");
      }
      options.timeoutMs = rawTimeout;
      index += 1;
      continue;
    }

    if (value === "--value") {
      options.value = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--value-env") {
      const envKey = argv[index + 1];
      if (typeof envKey !== "string" || !envKey.trim()) {
        throw new Error("Invalid --value-env value.");
      }
      options.value = process.env[envKey] ?? "";
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  if (typeof options.action !== "string" || !options.action.trim()) {
    throw new Error("--action is required.");
  }

  return options;
};

const getErrorCode = (error) => {
  if (error && typeof error === "object" && "code" in error) {
    const code = Reflect.get(error, "code");
    if (typeof code === "string" && code.trim()) {
      return code;
    }
  }
  return "secret_ops_failed";
};

const toStructuredError = (error, options) => {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error && typeof error === "object" && "details" in error && Reflect.get(error, "details")
      ? Reflect.get(error, "details")
      : {};

  return {
    ok: false,
    code: getErrorCode(error),
    message,
    details: {
      ...details,
      action: options.action ?? null,
      gatewayUrl: options.url ?? null,
      agentId: options.agentId ?? "jarvis-desktop",
    },
  };
};

const main = async () => {
  const options = parseArgs(process.argv);

  try {
    let result;

    if (options.action === "probe-live-api-key") {
      result = await probeLiveApiKey(options);
    } else if (options.action === "apply-live-api-key") {
      if (typeof options.value !== "string" || !options.value.trim()) {
        throw new Error("Live API key value is required for apply-live-api-key.");
      }
      result = await applyLiveApiKey(options);
    } else if (options.action === "clear-live-api-key") {
      result = await clearLiveApiKey(options);
    } else if (options.action === "reload-secrets") {
      result = await reloadSecrets(options);
    } else {
      throw new Error(`Unknown action: ${options.action}`);
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(toStructuredError(error, options), null, 2)}\n`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(toStructuredError(error, {}), null, 2)}\n`);
  process.exitCode = 1;
});
