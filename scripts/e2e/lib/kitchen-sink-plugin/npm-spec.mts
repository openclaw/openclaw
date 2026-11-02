import fs from "node:fs";

type ProcessEnv = Record<string, string | undefined>;

export const BRANCH_KITCHEN_SINK_NPM_VERSION = fs
  .readFileSync(new URL("./npm-version.txt", import.meta.url), "utf8")
  .trim();

if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/.test(BRANCH_KITCHEN_SINK_NPM_VERSION)) {
  throw new Error(
    `Invalid branch-recorded Kitchen Sink npm version: ${BRANCH_KITCHEN_SINK_NPM_VERSION}`,
  );
}

export function resolveKitchenSinkNpmSpec(env: ProcessEnv = process.env): string {
  return (
    env.OPENCLAW_KITCHEN_SINK_NPM_SPEC ||
    `npm:@openclaw/kitchen-sink@${BRANCH_KITCHEN_SINK_NPM_VERSION}`
  );
}
