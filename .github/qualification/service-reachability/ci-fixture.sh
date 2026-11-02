#!/usr/bin/env bash
set -euo pipefail

# Run only after candidate acceptance, in the ordinary prepared CI checkout.
# No credentials, provider completion, proxy override, or network-policy override.
test -f src/gateway/setup-inference.local-services.integration.test.ts
OPENCLAW_BUNDLED_PLUGIN_BUILD_IDS=llama-cpp node --import ./scripts/tsx.mjs scripts/build-external-plugin-local-dist.mts
exec node scripts/run-vitest.mjs src/gateway/setup-inference.local-services.integration.test.ts --maxWorkers=1
