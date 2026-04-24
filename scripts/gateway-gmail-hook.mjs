#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

const { applyGmailSetup, probeGmailHook } = await jiti.import(
  "../src/gateway/gmail-hook-helper.ts",
);

const parseArgs = (argv) => {
  const options = {};

  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--action") {
      options.action = argv[index + 1];
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

    if (value === "--account") {
      options.account = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--project") {
      options.project = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--label") {
      options.label = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--topic") {
      options.topic = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--subscription") {
      options.subscription = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--tailscale-mode") {
      options.tailscaleMode = argv[index + 1];
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
  return "gmail_hook_failed";
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
    },
  };
};

const main = async () => {
  const options = parseArgs(process.argv);

  try {
    let result;

    if (options.action === "probe-gmail-hook") {
      result = await probeGmailHook(options);
    } else if (options.action === "apply-gmail-setup") {
      result = await applyGmailSetup(
        {
          account: options.account,
          project: options.project,
          label: options.label,
          topic: options.topic,
          subscription: options.subscription,
          tailscaleMode: options.tailscaleMode,
        },
        options,
      );
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
