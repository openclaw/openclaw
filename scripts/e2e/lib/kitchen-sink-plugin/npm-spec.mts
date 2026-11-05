import fs from "node:fs";

type ProcessEnv = Record<string, string | undefined>;

export function resolveKitchenSinkNpmSpec(env: ProcessEnv = process.env): string {
  if (env.OPENCLAW_KITCHEN_SINK_NPM_SPEC) {
    return env.OPENCLAW_KITCHEN_SINK_NPM_SPEC;
  }
  const version = fs.readFileSync(new URL("./npm-version.txt", import.meta.url), "utf8").trim();
  if (!/^\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid branch-recorded Kitchen Sink npm version: ${version}`);
  }
  return `npm:@openclaw/kitchen-sink@${version}`;
}
