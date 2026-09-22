#!/usr/bin/env -S node --import tsx

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseVerifyBetaArgs, verifyBetaRelease } from "./lib/release-beta-verifier.ts";
import { createPluginNpmPublicationReadback } from "./plugin-npm-publication-readback.mjs";

async function main() {
  const args = parseReleaseVerifyBetaArgs(process.argv.slice(2));
  const cacheDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-readback-"));
  try {
    const pluginNpmReadback = await createPluginNpmPublicationReadback({
      repository: args.repo,
      runId: Number(args.workflowRuns.pluginNpm),
      sourceSha: args.releaseSha,
      workflowSha: process.env.GITHUB_WORKFLOW_SHA,
      workflowRef: args.workflowRef,
      sourceRoot: process.cwd(),
      plugins: args.pluginSelection,
      token: process.env.GH_TOKEN,
      cacheDir,
    });
    for (const line of await verifyBetaRelease(args, { pluginNpmReadback })) {
      console.log(line);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[release-verify-publish] FAILED (exit 1)");
  process.exitCode = 1;
});
