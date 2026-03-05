#!/usr/bin/env node
import { flattenPnpmStandaloneDeps } from "../dist/flatten-standalone-deps.js";

const STANDALONE = "apps/web/.next/standalone";
const result = flattenPnpmStandaloneDeps(STANDALONE);

if (result.skipped) {
  console.log("flatten-standalone-deps: no pnpm store found, skipping.");
} else {
  console.log(
    `flatten-standalone-deps: ${result.copied} packages → standalone app node_modules`,
  );
}
