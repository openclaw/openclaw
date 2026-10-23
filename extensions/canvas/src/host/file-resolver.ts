import path from "node:path";
import { root as fsRoot, FsSafeError } from "openclaw/plugin-sdk/security-runtime";

type CanvasOpenResult = Awaited<ReturnType<Awaited<ReturnType<typeof fsRoot>>["open"]>>;

/** Opens a Canvas-hosted file only when the request stays inside the root. */
export async function resolveFileWithinRoot(
  rootReal: string,
  urlPath: string,
): Promise<CanvasOpenResult | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath || "/");
  } catch {
    return null;
  }
  let depth = 0;
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (depth === 0) {
        return null;
      }
      depth--;
      continue;
    }
    depth++;
  }
  const normalizedPath = path.posix.normalize(decoded);
  const normalized = normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`;
  const rel = normalized.replace(/^\/+/, "");
  const root = await fsRoot(rootReal);

  try {
    if (normalized.endsWith("/")) {
      return await root.open(path.posix.join(rel, "index.html"));
    }
    const st = await root.stat(rel);
    if (st.isSymbolicLink) {
      return null;
    }
    return await root.open(st.isDirectory ? path.posix.join(rel, "index.html") : rel);
  } catch (err) {
    if (err instanceof FsSafeError) {
      return null;
    }
    throw err;
  }
}
