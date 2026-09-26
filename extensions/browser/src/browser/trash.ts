/**
 * Trash helpers for data under the Browser-owned config subtree.
 */
import path from "node:path";
import { CONFIG_DIR } from "openclaw/plugin-sdk/text-utility-runtime";

/** Moves a path to trash only when it lives under allowed Browser roots. */
export async function movePathToTrash(targetPath: string): Promise<string> {
  const { canonicalPathFromExistingAncestor, isPathInside } =
    await import("openclaw/plugin-sdk/file-access-runtime");
  const { movePathToTrash: movePathToTrashWithAllowedRoots } =
    await import("openclaw/plugin-sdk/browser-config");
  const browserRoot = path.join(CONFIG_DIR, "browser");
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalPathFromExistingAncestor(browserRoot),
    canonicalPathFromExistingAncestor(targetPath),
  ]);
  // fs-safe admits the moved entry's parent; Browser also confines its profile data.
  if (!isPathInside(canonicalRoot, canonicalTarget)) {
    throw new Error(`Refusing to trash path outside allowed roots: ${targetPath}`);
  }
  return await movePathToTrashWithAllowedRoots(targetPath, {
    // Managed browser data follows OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH, which
    // may intentionally live outside the OS home. Limit authority to Browser's
    // owned subtree; fs-safe also checks target identity, realpaths, and symlinks.
    allowedRoots: [browserRoot],
  });
}
