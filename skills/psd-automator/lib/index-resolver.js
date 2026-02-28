import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ErrorCodes } from "./error-codes.js";
import { expandHome } from "./paths.js";

export const DEFAULT_INDEX = path.join(os.homedir(), ".openclaw", "psd-index.json");

function safeLower(input) {
  return String(input || "").toLowerCase();
}

function scoreEntry(entry, hint) {
  const h = safeLower(hint);
  if (!h) return 0;
  let score = 0;
  const p = safeLower(entry.path);
  if (p.includes(h)) score += 5;
  const project = safeLower(entry.project);
  if (project.includes(h)) score += 2;
  const layers = Array.isArray(entry.layers) ? entry.layers : [];
  if (layers.some((layer) => safeLower(layer).includes(h))) score += 3;
  const texts = Array.isArray(entry.textContents) ? entry.textContents : [];
  if (texts.some((t) => safeLower(t).includes(h))) score += 3;
  return score;
}

function isAmbiguous(ranked) {
  if (ranked.length < 2) return false;
  const top = ranked[0];
  const second = ranked[1];
  if (!top || !second) return false;
  if (top.score === second.score) return true;
  return top.score - second.score <= 1;
}

export function loadIndex(indexPath = DEFAULT_INDEX) {
  const resolved = path.resolve(expandHome(indexPath));
  if (!fs.existsSync(resolved)) {
    return { ok: false, code: ErrorCodes.E_INDEX_MISSING, message: `Index not found: ${resolved}` };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return { ok: true, code: ErrorCodes.OK, index: parsed, path: resolved };
  } catch {
    return {
      ok: false,
      code: ErrorCodes.E_INDEX_CORRUPT,
      message: `Index is invalid JSON: ${resolved}`,
    };
  }
}

export function resolvePsdPath({ exactPath, fileHint, indexPath }) {
  if (exactPath) {
    const full = path.resolve(expandHome(exactPath));
    if (fs.existsSync(full)) return { ok: true, path: full, via: "exactPath", candidates: [full] };
    return { ok: false, code: ErrorCodes.E_FILE_NOT_FOUND, message: `PSD not found at ${full}` };
  }

  const loaded = loadIndex(indexPath);
  if (!loaded.ok) return loaded;
  const files = Array.isArray(loaded.index.files) ? loaded.index.files : [];
  const ranked = files
    .map((entry) => ({ entry, score: scoreEntry(entry, fileHint) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    return {
      ok: false,
      code: ErrorCodes.E_FILE_NOT_FOUND,
      message: `No PSD matched fileHint "${fileHint}".`,
    };
  }

  if (isAmbiguous(ranked)) {
    return {
      ok: false,
      code: ErrorCodes.E_FILE_AMBIGUOUS,
      message: `Multiple PSD files matched "${fileHint}". Confirmation required.`,
      via: "index",
      candidates: ranked.slice(0, 5).map((x) => x.entry.path),
      scores: ranked.slice(0, 5).map((x) => ({ path: x.entry.path, score: x.score })),
      suggestion: "Provide exactPath or a more specific fileHint.",
      indexPath: loaded.path,
    };
  }

  const winner = ranked[0].entry.path;
  return {
    ok: true,
    path: winner,
    via: "index",
    candidates: ranked.slice(0, 5).map((x) => x.entry.path),
    indexPath: loaded.path,
  };
}
