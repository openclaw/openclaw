#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: /bin/bash scripts/test-macos-app-intents.sh <new-report.json>" >&2
  exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo "App Intents qualification requires macOS with full Xcode." >&2
  exit 1
fi
REPORT="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$1")"
if [[ -e "$REPORT" || -L "$REPORT" || ! -d "$(dirname "$REPORT")" ]]; then
  echo "Choose a new report file in an existing directory." >&2
  exit 2
fi
XCODE_VERSION="$(xcodebuild -version)"
xcrun --find appintentsmetadataprocessor >/dev/null
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/mac-swift-build.sh"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-app-intents.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
SWIFT_WORK_ROOT="$SCRATCH"
prepare_swift_package_root
ARCH="$(uname -m)"
JOBS="$(sysctl -n hw.logicalcpu)"
if [[ ! "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Could not determine the native build concurrency." >&2
  exit 1
fi
if [[ "$JOBS" -gt 8 ]]; then JOBS=8; fi

# Ordinary test products lack these sidecars. Build the real release product
# with packaging's constant-gathering flags in an independently owned tree.
PROTOCOLS="$SCRATCH/app-intents-protocols.json"
write_app_intents_protocols "$PROTOCOLS"
BUILD_ARGS=(
  --package-path "$SWIFT_PACKAGE_ROOT"
  --scratch-path "$SCRATCH/build"
  --configuration release
  --force-resolved-versions
  --product OpenClaw
  --arch "$ARCH"
  --jobs "$JOBS"
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks
  -Xswiftc -emit-const-values
  -Xswiftc -Xfrontend -Xswiftc -const-gather-protocols-file
  -Xswiftc -Xfrontend -Xswiftc "$PROTOCOLS"
)
xcrun swift build "${BUILD_ARGS[@]}"
cmp "$SWIFT_PACKAGE_LOCK_BASELINE" "$SWIFT_PACKAGE_ROOT/Package.resolved"
PRODUCTS="$(xcrun swift build "${BUILD_ARGS[@]}" --show-bin-path)"
RESULTS="$SCRATCH/results"
capture_app_intents_inputs "$PRODUCTS" "$RESULTS/$ARCH/app-intents" OpenClawKit OpenClaw

# This bundle is only an extraction destination, never signed, installed, or run.
APP="$SCRATCH/OpenClaw.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$PRODUCTS/OpenClaw" "$APP/Contents/MacOS/OpenClaw"
cp "$ROOT_DIR/apps/macos/Sources/OpenClaw/Resources/Info.plist" "$APP/Contents/Info.plist"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")"
extract_app_intents_metadata "$RESULTS" "$APP" "$BUNDLE_ID" "$ARCH"

node - "$RESULTS" "$APP" "$ARCH" "$REPORT" "$XCODE_VERSION" <<'NODE'
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [results, app, arch, reportPath, xcodeVersion] = process.argv.slice(2);
const kitRoot = path.join(results, arch, "app-intents");
const entityNames = ["OpenClawSessionEntity", "OpenClawRunEntity"];
const enumName = "OpenClawNativeSessionOperation";
const entity = (typeName, optional = false) => ({ kind: "entity", typeName, optional });
const string = (optional = false) => ({ kind: "string", optional });
const contracts = {
  OpenSessionIntent: {
    target: entity("OpenClawSessionEntity"),
    operation: { kind: "enum", typeName: enumName, optional: true },
    draft: string(true),
  },
  OpenComposeIntent: { target: entity("OpenClawSessionEntity"), draft: string(true) },
  OpenRunIntent: { target: entity("OpenClawRunEntity") },
  SendMessageIntent: { session: entity("OpenClawSessionEntity"), message: string() },
  InspectRunIntent: { run: entity("OpenClawRunEntity") },
};
const shortcutNames = ["OpenSessionIntent", "OpenComposeIntent", "SendMessageIntent", "InspectRunIntent"];
const select = (values, name) => {
  const matches = Object.values(values).filter(
    (value) => value.fullyQualifiedTypeName === `OpenClawKit.${name}`,
  );
  assert.equal(matches.length, 1, `Expected exactly one extracted OpenClawKit.${name}`);
  assert.ok(matches[0].mangledTypeName, `Missing compiled type for ${name}`);
  return matches[0];
};
function validate(file, expectShortcuts) {
  const bytes = fs.readFileSync(file);
  const metadata = JSON.parse(bytes.toString("utf8"));
  // Apple-shipped v1 metadata uses primitive type 0 for String and typed
  // action/entity records. Reject schema drift instead of accepting any nonempty file.
  assert.equal(metadata.version, 1, "Unsupported App Intents metadata schema");
  assert.equal(metadata.generator.name, "xcode-tools");
  assert.ok(Array.isArray(metadata.enums), "Missing extracted enum declarations");
  const entities = Object.fromEntries(
    entityNames.map((name) => [name, select(metadata.entities, name)]),
  );
  const operation = select(metadata.enums, enumName);
  assert.ok(typeof operation.identifier === "string" && operation.identifier.length > 0);
  assert.deepEqual(operation.cases.map((value) => value.identifier).sort(), ["compose", "open"]);
  for (const [name, declaration] of Object.entries(entities)) {
    assert.ok(typeof declaration.typeName === "string" && declaration.typeName.length > 0);
    assert.ok(
      typeof declaration.defaultQueryIdentifier === "string" && declaration.defaultQueryIdentifier.length > 0,
      `Missing default query identifier for ${name}`,
    );
    const queries = Object.values(metadata.queries).filter(
      (query) => query.fullyQualifiedIdentifier === declaration.defaultQueryIdentifier,
    );
    assert.equal(queries.length, 1, `Missing extracted default query for ${name}`);
    assert.equal(queries[0].entityType, declaration.typeName, `Wrong query entity for ${name}`);
  }
  const actions = {};
  for (const [name, contract] of Object.entries(contracts)) {
    const action = select(metadata.actions, name);
    assert.ok(typeof action.identifier === "string" && action.identifier.length > 0);
    assert.equal(action.isDiscoverable, true, `${name} is not discoverable in metadata`);
    assert.deepEqual(
      action.parameters.map((parameter) => parameter.name).sort(),
      Object.keys(contract).sort(),
      `Missing or unexpected parameters for ${name}`,
    );
    for (const parameter of action.parameters) {
      const expected = contract[parameter.name];
      const label = `${name}.${parameter.name}`;
      assert.equal(parameter.isOptional, expected.optional, `Wrong optionality for ${label}`);
      if (expected.kind === "entity") {
        assert.equal(
          parameter.valueType.entity?.wrapper.typeName,
          entities[expected.typeName].typeName,
          `Wrong entity parameter type for ${label}`,
        );
      } else if (expected.kind === "enum") {
        assert.equal(
          parameter.valueType.linkEnumeration?.wrapper.identifier,
          operation.identifier,
          `Wrong enum parameter type for ${label}`,
        );
      } else {
        assert.equal(parameter.valueType.primitive?.wrapper.typeIdentifier, 0, `Expected String for ${label}`);
      }
    }
    actions[name] = action;
  }
  if (expectShortcuts) {
    assert.ok(Array.isArray(metadata.autoShortcuts), "Missing app Shortcut declarations");
    for (const name of shortcutNames) {
      const shortcuts = metadata.autoShortcuts.filter(
        (shortcut) => shortcut.actionIdentifier === actions[name].identifier,
      );
      assert.equal(shortcuts.length, 1, `Missing or duplicate app Shortcut for ${name}`);
      assert.ok(
        shortcuts[0].phraseTemplates.some((phrase) => phrase.key.includes("${applicationName}")),
        `Missing application-name phrase for ${name}`,
      );
      assert.ok(shortcuts[0].shortTitle.key, `Missing Shortcut title for ${name}`);
      assert.ok(shortcuts[0].systemImageName, `Missing Shortcut image for ${name}`);
    }
  }
  // Whitelist evidence fields: raw extraction inputs contain build-machine paths.
  return {
    metadataSha256: createHash("sha256").update(bytes).digest("hex"),
    generator: { name: metadata.generator.name, version: metadata.generator.version },
    intents: Object.entries(contracts).map(([name, parameters]) => ({
      name,
      parameters: Object.entries(parameters).map(([name, type]) => ({ name, ...type })),
    })),
    entities: entityNames,
    enumeration: { name: enumName, cases: operation.cases.map((value) => value.identifier).sort() },
    shortcuts: expectShortcuts ? shortcutNames : [],
  };
}
const report = {
  status: "passed",
  platform: "macOS",
  architecture: arch,
  configuration: "release",
  xcodeVersion: xcodeVersion.trim(),
  sharedPackage: validate(path.join(kitRoot, "OpenClawKit.appintents/Metadata.appintents/extract.actionsdata"), false),
  app: validate(path.join(app, "Contents/Resources/Metadata.appintents/extract.actionsdata"), true),
  installedDiscoveryVerified: false,
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log("App Intents metadata passed: 5 intents, 2 entities/queries, 1 enum, 4 app Shortcuts.");
NODE
