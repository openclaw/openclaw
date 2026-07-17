#!/usr/bin/env node
// Proof: setEncoding("utf8") prevents split-byte corruption in spawned pipes.
//
// Run: node scripts/proof-setencoding-utf8.mjs
//
// This script spawns a real child process that writes a 4-byte UTF-8 code
// point (U+1F60A 😊) split across two writes. It reads the output twice:
// 1. WITHOUT setEncoding — String(Buffer) per chunk → U+FFFD per partial seq
// 2. WITH    setEncoding — stateful stream decoder  → clean 😊

import { spawn } from "node:child_process";

const CHILD_SCRIPT = `
const smiley = Buffer.from([0xf0, 0x9f, 0x98, 0x8a]);
process.stdout.write(smiley.subarray(0, 2));
setTimeout(() => {
  process.stdout.write(smiley.subarray(2));
  process.stdout.end();
}, 20);
`;

function testWithoutSetEncoding() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // OLD behaviour: each Buffer chunk decoded independently
    const strings = /* string[] */ [];
    const hexes = /* string[] */ [];
    child.stdout.on("data", (chunk) => {
      hexes.push(Buffer.from(chunk).toString("hex"));
      strings.push(String(chunk)); // <-- same as old production code
    });

    child.on("close", () => {
      const result = strings.join("");
      console.log(`\n❌ WITHOUT setEncoding (old behaviour)`);
      console.log(`    per-chunk hex:              ${hexes.join("  ")}`);
      console.log(
        `    per-chunk String():          ${strings.map((s) => JSON.stringify(s)).join(" + ")}`,
      );
      console.log(`    joined result:              ${JSON.stringify(result)}`);
      console.log(`    has U+FFFD (�):              ${result.includes("�")}`);
      resolve();
    });
  });
}

function testWithSetEncoding() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // FIX: stateful decoder reassembles across chunks
    child.stdout.setEncoding("utf8");

    const strings = /* string[] */ [];
    child.stdout.on("data", (chunk) => {
      strings.push(chunk);
    });

    child.on("close", () => {
      const result = strings.join("");
      console.log(`\n✅ WITH setEncoding (fix)`);
      console.log(
        `    per-chunk strings:           ${strings.map((s) => JSON.stringify(s)).join(" + ")}`,
      );
      console.log(`    joined result:              ${JSON.stringify(result)}`);
      console.log(`    has U+FFFD (�):              ${result.includes("�")}`);
      resolve();
    });
  });
}

await testWithoutSetEncoding();
await testWithSetEncoding();
console.log();
