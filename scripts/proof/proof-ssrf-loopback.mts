import { fetchWithSsrFGuard } from "../../src/infra/net/fetch-guard.js";
import { ssrfPolicyFromHttpBaseUrlAllowedOrigin, resolveSsrFPolicyForUrl, SsrFBlockedError } from "../../src/infra/net/ssrf.js";

console.log("=== Proof: SSRF Guarded Fetch Loopback / localhost Checks ===\n");

// Mock fetch implementation that returns a successful OK response
const mockFetch = async () => new Response("OK", { status: 200 });

async function runScenario(params: {
  name: string;
  baseUrl: string;
  targetUrl: string;
  resolvedIp: string;
  family: number;
}) {
  const { name, baseUrl, targetUrl, resolvedIp, family } = params;
  console.log(`Scenario: ${name}`);
  console.log(`  Allowed Base URL: ${baseUrl}`);
  console.log(`  Target Request URL: ${targetUrl}`);
  console.log(`  Simulated Resolved IP: ${resolvedIp}`);

  const policy = ssrfPolicyFromHttpBaseUrlAllowedOrigin(baseUrl);
  const policyForUrl = resolveSsrFPolicyForUrl(new URL(targetUrl), policy);

  try {
    const result = await fetchWithSsrFGuard({
      url: targetUrl,
      policy: policyForUrl,
      fetchImpl: mockFetch,
      lookupFn: async () => [{ address: resolvedIp, family }],
    });
    console.log(`  [ALLOWED] Request successfully completed! Response: ${await result.response.text()}`);
    await result.release();
  } catch (err: any) {
    if (err instanceof SsrFBlockedError) {
      console.log(`  [BLOCKED] SSRF Guard successfully blocked request. Error: ${err.message}`);
    } else {
      console.log(`  [ERROR] Unexpected error: ${err.stack || err}`);
      process.exitCode = 1;
    }
  }
  console.log();
}

async function main() {
  // Scenario 1: Blocked non-localhost loopback rebinding (IPv4)
  await runScenario({
    name: "Block non-localhost loopback DNS rebinding (IPv4)",
    baseUrl: "http://lan-llm.corp.internal:11434/v1",
    targetUrl: "http://lan-llm.corp.internal:11434/v1/chat",
    resolvedIp: "127.0.0.1",
    family: 4,
  });

  // Scenario 2: Blocked non-localhost loopback rebinding (IPv6)
  await runScenario({
    name: "Block non-localhost loopback DNS rebinding (IPv6)",
    baseUrl: "http://lan-llm.corp.internal:11434/v1",
    targetUrl: "http://lan-llm.corp.internal:11434/v1/chat",
    resolvedIp: "::1",
    family: 6,
  });

  // Scenario 3: Allowed explicit localhost origin (IPv4)
  await runScenario({
    name: "Allow explicit localhost origin (IPv4)",
    baseUrl: "http://localhost:11434/v1",
    targetUrl: "http://localhost:11434/v1/chat",
    resolvedIp: "127.0.0.1",
    family: 4,
  });

  // Scenario 4: Allowed explicit 127.0.0.1 origin (IPv4)
  await runScenario({
    name: "Allow explicit 127.0.0.1 origin (IPv4)",
    baseUrl: "http://127.0.0.1:11434/v1",
    targetUrl: "http://127.0.0.1:11434/v1/chat",
    resolvedIp: "127.0.0.1",
    family: 4,
  });
}

main().catch((err) => {
  console.error("Unhandled exception:", err);
  process.exit(1);
});
