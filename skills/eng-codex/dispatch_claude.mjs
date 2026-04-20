#!/usr/bin/env node
/**
 * dispatch_claude.mjs — skeletal Claude Code backend
 *
 * Not wired. Exits 2 so the pipeline can distinguish config errors
 * (exit 2) from task failures (exit 1).
 */

const SENTINEL = "@@DISPATCH_RESULT@@";
process.stdout.write(
  `${SENTINEL} ${JSON.stringify({
    schema: 1,
    ok: false,
    errorCode: "not_implemented",
    error:
      "claude-code backend not wired — set PIPELINE_DISPATCH_BACKEND=acp to use the ACP gateway",
  })}\n`,
);
process.exit(2);
