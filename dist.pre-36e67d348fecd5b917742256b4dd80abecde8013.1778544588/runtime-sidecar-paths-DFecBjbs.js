//#region scripts/lib/bundled-runtime-sidecar-paths.json
var bundled_runtime_sidecar_paths_default = [
	"dist/extensions/browser/runtime-api.js",
	"dist/extensions/copilot-proxy/runtime-api.js",
	"dist/extensions/google/runtime-api.js",
	"dist/extensions/imessage/runtime-api.js",
	"dist/extensions/irc/runtime-api.js",
	"dist/extensions/lmstudio/runtime-api.js",
	"dist/extensions/matrix/helper-api.js",
	"dist/extensions/matrix/runtime-api.js",
	"dist/extensions/matrix/runtime-setter-api.js",
	"dist/extensions/matrix/thread-bindings-runtime.js",
	"dist/extensions/mattermost/runtime-api.js",
	"dist/extensions/memory-core/runtime-api.js",
	"dist/extensions/ollama/runtime-api.js",
	"dist/extensions/open-prose/runtime-api.js",
	"dist/extensions/signal/runtime-api.js",
	"dist/extensions/slack/runtime-api.js",
	"dist/extensions/slack/runtime-setter-api.js",
	"dist/extensions/telegram/runtime-api.js",
	"dist/extensions/telegram/runtime-setter-api.js",
	"dist/extensions/tokenjuice/runtime-api.js",
	"dist/extensions/webhooks/runtime-api.js",
	"dist/extensions/zai/runtime-api.js"
];
//#endregion
//#region src/plugins/runtime-sidecar-paths.ts
function assertUniqueValues(values, label) {
	const seen = /* @__PURE__ */ new Set();
	const duplicates = /* @__PURE__ */ new Set();
	for (const value of values) {
		if (seen.has(value)) {
			duplicates.add(value);
			continue;
		}
		seen.add(value);
	}
	if (duplicates.size > 0) throw new Error(`Duplicate ${label}: ${Array.from(duplicates).join(", ")}`);
	return values;
}
const BUNDLED_RUNTIME_SIDECAR_PATHS = assertUniqueValues(bundled_runtime_sidecar_paths_default, "bundled runtime sidecar path");
//#endregion
export { assertUniqueValues as n, BUNDLED_RUNTIME_SIDECAR_PATHS as t };
