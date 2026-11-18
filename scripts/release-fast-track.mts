#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exchangeFastTrackApproval } from "./lib/release-fast-track-approval.mts";
import { parseFastTrackRequest } from "./lib/release-fast-track-contract.mts";

/** Preparation/status only. Publisher admission is deliberately a separate authority. */
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { request: { type: "string" } },
  });
  const operation = positionals[0];
  if (
    positionals.length !== 1 ||
    (operation !== "request" && operation !== "status") ||
    !values.request
  ) {
    throw new Error(
      "Usage: release-fast-track.mts <request|status> --request <immutable-request.json>. There is no machine approval operation.",
    );
  }
  const serviceOrigin = process.env.FAST_TRACK_APPROVAL_SERVICE_ORIGIN;
  const identityToken = process.env.FAST_TRACK_APPROVAL_ID_TOKEN;
  if (!serviceOrigin || !identityToken) {
    throw new Error(
      "Set FAST_TRACK_APPROVAL_SERVICE_ORIGIN and FAST_TRACK_APPROVAL_ID_TOKEN. Never put credentials in request files or command arguments.",
    );
  }
  const request = parseFastTrackRequest(JSON.parse(readFileSync(values.request, "utf8")));
  const approval = await exchangeFastTrackApproval({
    serviceOrigin,
    identityToken,
    request,
    operation,
  });
  process.stdout.write(
    `${JSON.stringify({
      requestId: approval.requestId,
      digest: approval.digest,
      state: approval.state,
      expiresAt: approval.expiresAt,
      approver: approval.approver,
      decidedAt: approval.decidedAt,
      publicationAuthorized: false,
    })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fast-track approval operation failed.");
    process.exitCode = 1;
  });
}
