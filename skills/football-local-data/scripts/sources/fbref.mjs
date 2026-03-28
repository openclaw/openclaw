/**
 * FBref (Sports Reference) — data via Python soccerdata (see ../fbref-fetch.py).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ID = "fbref";
export const SOURCE_LABEL = "FBref (Sports Reference)";
export const MANIFEST_SOURCE = "fbref-soccerdata";
export const NOTES_URL = "https://fbref.com/";
export const DEFAULT_USER_AGENT =
  "OpenClaw-football-local-data/1.0 (+https://github.com/openclaw/openclaw; fbref)";

/**
 * @param {object} args
 */
export function validateArgs(args) {
  if (args.urls?.length) {
    throw new Error(
      "fbref: do not use --urls; use --preset / --leagues / --season-range (see SKILL.md)",
    );
  }
}

/**
 * @param {object} args
 * @param {string} outRoot
 * @param {{ dryRun: boolean, delayMs: number, fbrefDepth?: string, fbrefProxy?: string }} ctx
 */
export async function runFetch(args, outRoot, ctx) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const py = path.join(scriptDir, "..", "fbref-fetch.py");
  const pyArgs = [py, "--out", outRoot, "--delay-ms", String(ctx.delayMs ?? 400)];

  const preset = args.preset?.trim() || "big5";
  pyArgs.push("--preset", preset);

  if (args.leagues?.length) {
    pyArgs.push("--leagues", args.leagues.join(","));
  }
  if (args.seasonRange) {
    pyArgs.push("--season-range", args.seasonRange);
  } else if (args.season) {
    pyArgs.push("--season", args.season);
  } else if (args.seasonsList?.length) {
    pyArgs.push("--seasons", args.seasonsList.join(","));
  }

  const depth = ctx.fbrefDepth || process.env.FBREF_DEPTH || "core";
  pyArgs.push("--depth", depth);

  if (ctx.dryRun) {
    pyArgs.push("--dry-run");
  }

  const proxyRaw =
    (typeof ctx.fbrefProxy === "string" && ctx.fbrefProxy.trim()) ||
    (process.env.FBREF_PROXY && process.env.FBREF_PROXY.trim()) ||
    (process.env.HTTPS_PROXY && process.env.HTTPS_PROXY.trim()) ||
    (process.env.ALL_PROXY && process.env.ALL_PROXY.trim()) ||
    "";
  if (proxyRaw) {
    pyArgs.push("--proxy", proxyRaw);
  }

  await new Promise((resolve, reject) => {
    const proc = spawn("python3", pyArgs, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(undefined);
      } else {
        reject(new Error(`fbref-fetch.py exited with code ${code}`));
      }
    });
  });

  return { sourceId: SOURCE_ID, summaries: [] };
}
