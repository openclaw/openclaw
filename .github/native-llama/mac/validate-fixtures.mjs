import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveFixtures } from "./derive-fixtures.mjs";
const packet = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2]);
const dependencies = path.resolve(process.argv[3] ?? source);
const producer = path.resolve(process.argv[4] ?? source);
const require = createRequire(path.join(dependencies, "packages/gateway-protocol/package.json"));
const { build } = await import(pathToFileURL(require.resolve("esbuild")));
const bundle = await build({
  stdin: { contents: `export * from ${JSON.stringify(path.join(source, "packages/gateway-protocol/src/schema/wizard.ts"))};\nexport { SystemAgentSetupDetectResultSchema } from ${JSON.stringify(path.join(source, "packages/gateway-protocol/src/schema/openclaw.ts"))};\nexport { Check } from ${JSON.stringify(require.resolve("typebox/value"))};`, resolveDir: source, loader: "ts" },
  alias: { typebox: require.resolve("typebox"), "typebox/value": require.resolve("typebox/value") },
  bundle: true, format: "esm", platform: "node", target: "node24", write: false,
});
const wire = await import("data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].contents).toString("base64"));
const expected = deriveFixtures(producer);
const actual = Object.fromEntries(Object.keys(expected).map((name) => [name, JSON.parse(fs.readFileSync(path.join(packet, "fixtures", name), "utf8"))]));
assert.deepEqual(actual, expected, "Fixtures must derive from the pinned producer, not old native metadata");
const note = actual["install-note.json"], endpoint = actual["endpoint.json"], detect = actual["detect.json"];
assert(wire.Check(wire.SystemAgentSetupDetectResultSchema, detect), "Invalid detection wire fixture");
assert(wire.Check(wire.WizardStartResultSchema, { sessionId: "fixture-session", ...note }));
assert(wire.Check(wire.WizardNextResultSchema, endpoint));
assert(wire.Check(wire.WizardNextParamsSchema, { sessionId: "fixture-session", answer: { stepId: note.step.id } }));
console.log(JSON.stringify({ status: "PASS", boundary: "production wire schemas plus all four pinned producer choices/note/endpoint", fixtureActivation: false, choices: detect.prepareOptions.map((choice) => ({ id: choice.id, label: choice.label, action: choice.actionLabel })) }, null, 2));
