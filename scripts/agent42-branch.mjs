#!/usr/bin/env node
import { execSync } from "node:child_process";

const branch = process.argv[2] || "agent42/subscriptions-and-workflow-2026-04";

try {
  execSync(`git show-ref --verify --quiet refs/heads/${branch}`, { stdio: "ignore" });
  execSync(`git checkout ${branch}`, { stdio: "inherit" });
} catch {
  execSync(`git checkout -b ${branch}`, { stdio: "inherit" });
}

console.log(`Active branch: ${branch}`);
