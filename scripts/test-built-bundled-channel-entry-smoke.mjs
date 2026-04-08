import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const warningFilterKey = Symbol.for("openclaw.warning-filter");

function installProcessWarningFilter() {
  if (globalThis[warningFilterKey]?.installed) {
    return;
  }

  const originalEmitWarning = process.emitWarning.bind(process);
  process.emitWarning = (...args) => {
    const [warningArg, secondArg, thirdArg] = args;
    const warning =
      warningArg instanceof Error
        ? {
            name: warningArg.name,
            message: warningArg.message,
            code: warningArg.code,
          }
        : {
            name: typeof secondArg === "string" ? secondArg : secondArg?.type,
            message: typeof warningArg === "string" ? warningArg : undefined,
            code: typeof thirdArg === "string" ? thirdArg : secondArg?.code,
          };

    if (warning.code === "DEP0040" && warning.message?.includes("punycode")) {
      return;
    }

    return Reflect.apply(originalEmitWarning, process, args);
  };

  globalThis[warningFilterKey] = { installed: true };
}

installProcessWarningFilter();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function importBuiltModule(relativePath) {
  return import(pathToFileURL(path.join(repoRoot, relativePath)).href);
}

function assertSecretContractShape(secrets, context) {
  assert.ok(secrets && typeof secrets === "object", `${context}: missing secrets contract`);
  assert.equal(
    typeof secrets.collectRuntimeConfigAssignments,
    "function",
    `${context}: collectRuntimeConfigAssignments must be a function`,
  );
  assert.ok(
    Array.isArray(secrets.secretTargetRegistryEntries),
    `${context}: secretTargetRegistryEntries must be an array`,
  );
}

const telegramSetupEntry = (await importBuiltModule("dist/extensions/telegram/setup-entry.js"))
  .default;
assert.equal(
  telegramSetupEntry.kind,
  "bundled-channel-setup-entry",
  "telegram setup entry kind mismatch",
);
const telegramSetupPlugin = telegramSetupEntry.loadSetupPlugin();
assert.equal(telegramSetupPlugin?.id, "telegram", "telegram setup plugin failed to load");
assertSecretContractShape(
  telegramSetupEntry.loadSetupSecrets?.(),
  "telegram setup entry packaged secrets",
);

const telegramEntry = (await importBuiltModule("dist/extensions/telegram/index.js")).default;
assert.equal(telegramEntry.kind, "bundled-channel-entry", "telegram entry kind mismatch");
const telegramPlugin = telegramEntry.loadChannelPlugin();
assert.equal(telegramPlugin?.id, "telegram", "telegram channel plugin failed to load");
assertSecretContractShape(
  telegramEntry.loadChannelSecrets?.(),
  "telegram channel packaged secrets",
);

const slackSetupEntry = (await importBuiltModule("dist/extensions/slack/setup-entry.js")).default;
assert.equal(
  slackSetupEntry.kind,
  "bundled-channel-setup-entry",
  "slack setup entry kind mismatch",
);
assertSecretContractShape(
  slackSetupEntry.loadSetupSecrets?.(),
  "slack setup entry packaged secrets",
);

process.stdout.write("[build-smoke] bundled channel entry smoke passed\n");
