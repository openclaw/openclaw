#!/usr/bin/env -S node --import tsx

import { parseReleaseVerifyBetaArgs, verifyBetaRelease } from "./lib/release-beta-verifier.ts";

async function main() {
  const args = parseReleaseVerifyBetaArgs(process.argv.slice(2));
  for (const line of await verifyBetaRelease(args)) {
    console.log(line);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
