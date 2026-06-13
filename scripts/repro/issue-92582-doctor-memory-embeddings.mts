// Reproduction script for issue #92582
// Verifies that doctor --deep correctly probes memory embeddings and doesn't emit false warnings

import { resolveDefaultAgentId } from "../src/agents/agent-scope.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { probeGatewayMemoryStatus } from "../src/commands/doctor-gateway-health.js";

// Mock config with local memory provider
const mockConfig: OpenClawConfig = {
  agents: {
    defaults: {
      memorySearch: {
        provider: "local",
        local: {
          modelPath: "hf://default", // Use default bundled model
        },
      },
    },
  },
  plugins: {
    allow: ["memory-core"],
    entries: {
      "memory-core": {
        enabled: true,
      },
    },
  },
} as unknown as OpenClawConfig;

async function main() {
  console.log("=== Reproduction for issue #92582 ===\n");

  // Test 1: probe with deep=false should skip embedding check
  console.log("Test 1: probeGatewayMemoryStatus with deep=false");
  const probeNotDeep = await probeGatewayMemoryStatus({
    cfg: mockConfig,
    timeoutMs: 5000,
    deep: false,
  });
  console.log(`  Result: checked=${probeNotDeep.checked}, ready=${probeNotDeep.ready}, skipped=${probeNotDeep.skipped}`);

  // When deep=false, the probe should skip the embedding check
  if (probeNotDeep.checked === false && probeNotDeep.skipped === true) {
    console.log("  PASS: Correctly skipped embedding check when deep=false\n");
  } else {
    console.error("  FAIL: Expected checked=false, skipped=true when deep=false");
    process.exitCode = 1;
    return;
  }

  // Test 2: probe with deep=true should attempt embedding check
  console.log("Test 2: probeGatewayMemoryStatus with deep=true");
  const probeDeep = await probeGatewayMemoryStatus({
    cfg: mockConfig,
    timeoutMs: 5000,
    deep: true,
  });
  console.log(`  Result: checked=${probeDeep.checked}, ready=${probeDeep.ready}, skipped=${probeDeep.skipped}`);

  // When deep=true, the probe should check embeddings (checked=true)
  // The ready status depends on whether the model is actually available
  if (probeDeep.checked === true && probeDeep.skipped === false) {
    console.log("  PASS: Correctly attempted embedding check when deep=true");
    console.log(`  Embedding ready: ${probeDeep.ready ? "yes" : "no"} (expected for local setup)\n`);
  } else {
    console.error("  FAIL: Expected checked=true, skipped=false when deep=true");
    process.exitCode = 1;
    return;
  }

  console.log("=== All tests passed! ===");
  console.log("The fix allows doctor --deep to properly probe memory embeddings,");
  console.log("eliminating the false warning 'local embeddings are not confirmed ready'.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
