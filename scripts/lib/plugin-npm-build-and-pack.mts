// Preserve the single-plugin CLI used by older registry harnesses.
import { buildAndPackPlugin } from "./plugin-npm-build-and-pack-core.mts";

try {
  const [packageDir, outputDir, extra] = process.argv.slice(2);
  if (!packageDir || !outputDir || extra !== undefined) {
    throw new Error("usage: plugin-npm-build-and-pack.mts <package-dir> <output-dir>");
  }
  process.exitCode = await buildAndPackPlugin(packageDir, outputDir);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
