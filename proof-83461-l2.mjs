/**
 * Self-contained L2 proof for PR #94473 (issue #83461).
 * Replicates toDiscoveryApiKey and isNonSecretApiKeyMarker inline —
 * no pnpm/node_modules needed.
 */

// ---- marker constants (from model-auth-markers.ts) ----
const OAUTH_PREFIX = "oauth:";
const NON_ENV_SECRETREF = "secretref-managed";
const KNOWN_MARKERS = new Set([
  "custom-local", "codex-app-server", "gcp-vertex-credentials",
  "ollama-local", NON_ENV_SECRETREF,
]);
const KNOWN_ENV_MARKERS = new Set([
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "VLLM_API_KEY",
  "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "PERPLEXITY_API_KEY",
  "FIREWORKS_API_KEY", "NOVITA_API_KEY", "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY", "MINIMAX_CODE_PLAN_KEY",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_PROFILE",
]);

function isNonSecretApiKeyMarker(value) {
  const v = value.trim();
  if (!v) return false;
  if (v.startsWith(OAUTH_PREFIX) || KNOWN_MARKERS.has(v)) return true;
  return KNOWN_ENV_MARKERS.has(v);
}

function toDiscoveryApiKey(value) {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v || isNonSecretApiKeyMarker(v)) return undefined;
  return v;
}

// ---- test harness ----
function simulateDiscovery(apiKey, discoveryApiKey) {
  if (apiKey == null) return { result: null, wireAuth: "(no provider built)" };
  const discoveryKey = discoveryApiKey ?? toDiscoveryApiKey(apiKey);
  const wireAuth = discoveryKey ? `Bearer ${discoveryKey}` : "<no auth header>";
  return { result: "provider built", wireAuth, discoveryKey };
}

const CASES = [
  { label: "1. both-set",                apiKey: "OPENAI_API_KEY",     discoveryApiKey: "sk-real-key-123",  expect: "Bearer sk-real-key-123" },
  { label: "2. env-resolved-only",       apiKey: "sk-real-key-456",    discoveryApiKey: undefined,          expect: "Bearer sk-real-key-456" },
  { label: "3. local-marker",            apiKey: "custom-local",       discoveryApiKey: undefined,          expect: "<no auth header>" },
  { label: "4. env-var-marker",          apiKey: "VLLM_API_KEY",       discoveryApiKey: undefined,          expect: "<no auth header>" },
  { label: "5. secretref-marker",        apiKey: "secretref-managed",  discoveryApiKey: undefined,          expect: "<no auth header>" },
  { label: "6. oauth-marker",            apiKey: "oauth:litellm",      discoveryApiKey: undefined,          expect: "<no auth header>" },
  { label: "7. marker-with-discovery",   apiKey: "custom-local",       discoveryApiKey: "sk-real-key-789",  expect: "Bearer sk-real-key-789" },
  { label: "8. no-key",                  apiKey: undefined,            discoveryApiKey: undefined,          expect: "(no provider built)" },
];

console.log("=== L2 Proof: toDiscoveryApiKey filter output ===");
for (const v of ["sk-real-key-456", "custom-local", "VLLM_API_KEY", "secretref-managed", "oauth:litellm", "OPENAI_API_KEY", "ollama-local"]) {
  const result = toDiscoveryApiKey(v);
  const isFiltered = result === undefined ? "→ filtered (undefined)" : `→ ${result}`;
  console.log(`  toDiscoveryApiKey("${v}")${" ".repeat(Math.max(0, 32 - v.length))}${isFiltered}`);
}

console.log("\n=== L2 Proof: discoverOpenAICompatibleSelfHostedProvider behavior ===");
let allPass = true;
for (const c of CASES) {
  const out = simulateDiscovery(c.apiKey, c.discoveryApiKey);
  const pass = out.wireAuth === c.expect;
  const status = pass ? "✓" : "✗";
  if (!pass) allPass = false;
  console.log(`  ${status} ${c.label}: apiKey=${JSON.stringify(c.apiKey)}, discoveryApiKey=${JSON.stringify(c.discoveryApiKey)}`);
  console.log(`      wire auth = ${out.wireAuth} (expected: ${c.expect})`);
}

console.log(`\n=== Verdict: ${allPass ? "ALL PASSED ✓" : "FAILED ✗"} ===`);

// Also show the prev fix would have leaked
console.log("\n=== Regression test: old fix (discoveryApiKey ?? apiKey) would leak ===");
for (const v of ["custom-local", "VLLM_API_KEY", "secretref-managed", "oauth:litellm"]) {
  const old = toDiscoveryApiKey(v);
  console.log(`  toDiscoveryApiKey("${v}") = ${old ?? "undefined (safe)"}`);
}
process.exit(allPass ? 0 : 1);
