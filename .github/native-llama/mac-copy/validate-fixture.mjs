import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const packet = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(process.argv[2]);
const require = createRequire(path.join(source, "packages/gateway-protocol/package.json"));
const { build } = await import(pathToFileURL(require.resolve("esbuild")));
const result = await build({
  stdin: { contents: 'export { SystemAgentSetupDetectResultSchema } from ' + JSON.stringify(path.join(source, "packages/gateway-protocol/src/schema/openclaw.ts")) + '; export { Check } from ' + JSON.stringify(require.resolve("typebox/value")) + ';', resolveDir: source, loader: "ts" },
  alias: { typebox: require.resolve("typebox"), "typebox/value": require.resolve("typebox/value") },
  bundle: true, format: "esm", platform: "node", target: "node24", write: false,
});
const wire = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].contents).toString("base64"));
const fixture = JSON.parse(fs.readFileSync(path.join(packet, "copy-detect.json"), "utf8"));
assert(wire.Check(wire.SystemAgentSetupDetectResultSchema, fixture));
assert.equal(fixture.prepareOptions.length, 2);
assert.equal(fixture.prepareOptions[0].actionLabel, undefined);
assert.equal(fixture.prepareOptions[1].actionLabel, "Provider-owned action");
console.log(JSON.stringify({ status: "PASS", boundary: "production detection wire schema; not native execution" }));
