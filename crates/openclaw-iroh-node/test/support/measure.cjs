#!/usr/bin/env node
// Runs bench.cjs n times per case against one direct peer process and reports medians.
//   node measure.cjs [--n 5] [--binding own] [--cases down:256,streams8:512] [--out file.json]
// Also used by throughput.test.cjs.
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnJsonLine } = require("./procs.cjs");

/** Median (nearest-rank) of numbers. */
function median(values) {
  const s = values.toSorted((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1];
}

/** Measures each { test, mb } case n times over a direct path; resolves a per-case summary. */
async function measure({ cases, n = 3, binding = "own" }) {
  const peer = await spawnJsonLine(path.join(__dirname, "peer.cjs"), []);
  const summary = {};
  try {
    for (const { test, mb } of cases) {
      const runs = [];
      for (let i = 0; i < n; i++) {
        const out = execFileSync(
          process.execPath,
          [
            path.join(__dirname, "bench.cjs"),
            "--binding",
            binding,
            "--peer",
            JSON.stringify(peer.info),
            "--path",
            "direct",
            "--test",
            test,
            "--mb",
            String(mb),
          ],
          { encoding: "utf8", timeout: 180000 },
        );
        runs.push(JSON.parse(out.trim().split("\n").pop()));
      }
      for (const r of runs) {
        r.rssGrowthMB = r.maxRssMB - r.rssBeforeMB;
      }
      const pick = (f) => runs.map((r) => r[f]);
      summary[`${test}:${mb}`] = {
        n,
        mbps: { median: median(pick("mbps")), min: Math.min(...pick("mbps")) },
        maxRssMB: { median: median(pick("maxRssMB")), max: Math.max(...pick("maxRssMB")) },
        rssGrowthMB: { median: median(pick("rssGrowthMB")), max: Math.max(...pick("rssGrowthMB")) },
        cpuSPerMB: { median: median(pick("cpuSPerMB")) },
        runs,
      };
    }
  } finally {
    await peer.stop();
  }
  return summary;
}

/** Parses "down:256,streams8:512" into [{ test, mb }]. */
function parseCases(spec) {
  return spec.split(",").map((c) => {
    const [test, mb] = c.split(":");
    return { test, mb: Number(mb) };
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
  measure({
    cases: parseCases(opt("--cases", "down:256,streams8:512")),
    n: Number(opt("--n", "5")),
    binding: opt("--binding", "own"),
  }).then((summary) => {
    const meta = {
      host: os.hostname(),
      arch: process.arch,
      node: process.version,
      cpus: os.cpus().length,
      date: new Date().toISOString(),
    };
    const json = JSON.stringify({ meta, summary }, null, 2) + "\n";
    if (opt("--out")) {
      fs.writeFileSync(opt("--out"), json);
    }
    for (const [k, v] of Object.entries(summary)) {
      process.stderr.write(
        `${k} mbps=${v.mbps.median.toFixed(0)} maxRssMB=${v.maxRssMB.median.toFixed(0)}/${v.maxRssMB.max.toFixed(0)} growthMB=${v.rssGrowthMB.median.toFixed(0)}/${v.rssGrowthMB.max.toFixed(0)} cpuS/MB=${v.cpuSPerMB.median.toFixed(4)}\n`,
      );
    }
  });
}

module.exports = { measure, parseCases };
