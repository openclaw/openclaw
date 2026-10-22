import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileHandleBounded } from "openclaw/plugin-sdk/file-access-runtime";
import {
  handleA2uiHttpRequestWithRootResolver,
  type A2uiHttpRequest,
  type A2uiHttpResponse,
} from "./a2ui-route.js";
import { A2UI_PATH } from "./a2ui-shared.js";
import { resolveFileWithinRoot } from "./file-resolver.js";

export { A2UI_PATH, CANVAS_HOST_PATH } from "./a2ui-shared.js";

let cachedA2uiRootReal: Promise<string | null> | undefined;

async function resolveA2uiRoot(): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const entryDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : null;
  const candidates = [
    // Running from source (bun) or a copied dist asset chunk.
    path.resolve(here, "a2ui"),
    // Running from dist root chunk (common launchd path).
    path.resolve(here, "canvas-host/a2ui"),
    // Entry path fallbacks (helps when cwd is not the repo root).
    ...(entryDir
      ? [path.resolve(entryDir, "a2ui"), path.resolve(entryDir, "canvas-host/a2ui")]
      : []),
    // Running from dist without copied assets (fallback to source).
    path.resolve(here, "../../extensions/canvas/src/host/a2ui"),
    path.resolve(here, "../extensions/canvas/src/host/a2ui"),
    // Running from repo root.
    path.resolve(process.cwd(), "extensions/canvas/src/host/a2ui"),
    path.resolve(process.cwd(), "dist/canvas-host/a2ui"),
  ];
  if (process.execPath) {
    candidates.unshift(path.resolve(path.dirname(process.execPath), "a2ui"));
  }

  for (const dir of candidates) {
    try {
      const bundlePath = path.join(dir, "a2ui.bundle.js");
      const v09BundlePath = path.join(dir, "a2ui-v0.9.bundle.js");
      await fs.stat(bundlePath);
      await fs.stat(v09BundlePath);
      return dir;
    } catch {
      // try next
    }
  }
  return null;
}

function resolveA2uiRootReal(): Promise<string | null> {
  return (cachedA2uiRootReal ??= resolveA2uiRoot().then((root) =>
    root ? fs.realpath(root) : null,
  ));
}

export async function handleA2uiHttpRequest(
  req: A2uiHttpRequest,
  res: A2uiHttpResponse,
): Promise<boolean> {
  return await handleA2uiHttpRequestWithRootResolver(req, res, resolveA2uiRootReal);
}

/** Read an explicitly registered public renderer bundle without request or Gateway authority. */
export async function readPublicA2uiResource(
  resourcePath: string,
): Promise<{ body: Uint8Array; contentType: string } | undefined> {
  const root = await resolveA2uiRootReal();
  await using opened = root
    ? await resolveFileWithinRoot(root, resourcePath.slice(A2UI_PATH.length))
    : null;
  if (!opened) {
    return undefined;
  }
  return {
    body: await readFileHandleBounded(opened.handle, Infinity),
    contentType: "application/javascript; charset=utf-8",
  };
}
