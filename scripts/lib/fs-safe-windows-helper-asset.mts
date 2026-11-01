import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";

const NATIVE_MANIFEST_REQUIRE = 'require("../package.json")';

export function resolveFsSafePackageManifest(rootDir = process.cwd()): string {
  return fs.realpathSync(path.resolve(rootDir, "node_modules/@openclaw/fs-safe/package.json"));
}

/** The fs-safe command runtime resolves this executable beside its bundled module. */
export function resolveFsSafeWindowsHelper(rootDir = process.cwd()): string {
  return fs.realpathSync(
    path.resolve(rootDir, "node_modules/@openclaw/fs-safe/dist/windows-security-helper.exe"),
  );
}

export function createFsSafeWindowsHelperAssetPlugin(
  rootDir = process.cwd(),
  fileName = "windows-security-helper.exe",
  recordInput?: (file: string) => void,
) {
  const manifestPath = resolveFsSafePackageManifest(rootDir);
  const nativePath = fs.realpathSync(path.join(path.dirname(manifestPath), "dist/native.js"));
  return {
    name: "openclaw:fs-safe-windows-helper",
    buildStart() {
      const source = resolveFsSafeWindowsHelper(rootDir);
      for (const input of [source, manifestPath]) {
        recordInput?.(input);
        this.addWatchFile(input);
      }
      this.emitFile({ type: "asset", fileName, source: fs.readFileSync(source) });
    },
    transform(this: { error(message: string): never }, code: string, id: string) {
      let resolvedId: string;
      try {
        resolvedId = fs.realpathSync(id);
      } catch {
        return null;
      }
      if (resolvedId !== nativePath) {
        return null;
      }
      // Fallback diagnostics need the pinned manifest even when no native addon loads.
      // Embed it before relocation; a runtime package lookup would escape the sealed bundle.
      if (code.split(NATIVE_MANIFEST_REQUIRE).length !== 2) {
        this.error("fs-safe native manifest lookup changed; update the sealed build transform");
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        optionalDependencies: Record<string, string>;
      };
      return code.replace(NATIVE_MANIFEST_REQUIRE, () =>
        JSON.stringify({ optionalDependencies: manifest.optionalDependencies }),
      );
    },
  } satisfies TsdownPlugin;
}
