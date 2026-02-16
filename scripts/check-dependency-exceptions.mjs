#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const filePath = path.resolve("docs/security/dependency-exceptions.md");
const content = fs.readFileSync(filePath, "utf8");
const lines = content.split(/\r?\n/);

const entries = [];
let current = null;

for (const line of lines) {
  const headingMatch = /^###\s+(.+)$/.exec(line.trim());
  if (headingMatch) {
    if (current) entries.push(current);
    current = { id: headingMatch[1], status: "", nextReviewDue: "" };
    continue;
  }
  if (!current) continue;

  const statusMatch = /^-\s+Status:\s+(.+)$/.exec(line.trim());
  if (statusMatch) {
    current.status = statusMatch[1].trim().toLowerCase();
    continue;
  }

  const dueMatch = /^-\s+Next review due:\s+(\d{4}-\d{2}-\d{2})$/.exec(line.trim());
  if (dueMatch) {
    current.nextReviewDue = dueMatch[1];
  }
}
if (current) entries.push(current);

const today = new Date().toISOString().slice(0, 10);
const problems = [];

for (const entry of entries) {
  if (entry.status !== "active") continue;
  if (!entry.nextReviewDue) {
    problems.push(`${entry.id}: missing "Next review due" date`);
    continue;
  }
  if (entry.nextReviewDue < today) {
    problems.push(`${entry.id}: review expired on ${entry.nextReviewDue} (today: ${today})`);
  }
}

if (problems.length > 0) {
  console.error("Dependency exception review check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(
  `Dependency exception review check passed (${entries.length} entries scanned, date: ${today}).`
);
