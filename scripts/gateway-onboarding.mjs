#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });

const {
  answerWizardSession,
  cancelWizardSession,
  completePairing,
  getPairingSetup,
  getWizardSessionStatus,
  probeOnboarding,
  startWizardSession,
} = await jiti.import("../src/gateway/onboarding-helper.ts");

const parseJsonBase64 = (value) => {
  const raw = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(raw);
};

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
    if (value === "--session-id") {
      options.sessionId = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--answer-base64") {
      options.answer = parseJsonBase64(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value === "--pairing-url") {
      options.pairingUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--pairing-token") {
      options.pairingToken = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--pairing-password") {
      options.pairingPassword = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--setup-code") {
      options.setupCode = argv[index + 1];
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
  return "onboarding_failed";
};

const toStructuredError = (error, options) => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    ok: false,
    code: getErrorCode(error),
    message,
    details: {
      action: options.action ?? null,
      gatewayUrl: options.url ?? null,
      sessionId: options.sessionId ?? null,
    },
  };
};

const main = async () => {
  const options = parseArgs(process.argv);

  try {
    let result;

    if (options.action === "probe-onboarding") {
      result = await probeOnboarding(options);
    } else if (options.action === "start-wizard") {
      result = await startWizardSession(options);
    } else if (options.action === "answer-wizard") {
      result = await answerWizardSession(options.sessionId, options.answer ?? {}, options);
    } else if (options.action === "get-wizard-status") {
      result = await getWizardSessionStatus(options.sessionId, options);
    } else if (options.action === "cancel-wizard") {
      result = await cancelWizardSession(options.sessionId, options);
    } else if (options.action === "get-pairing-setup") {
      result = await getPairingSetup(options);
    } else if (options.action === "complete-pairing") {
      result = await completePairing(
        {
          url: options.pairingUrl,
          token: options.pairingToken,
          password: options.pairingPassword,
          setupCode: options.setupCode,
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
