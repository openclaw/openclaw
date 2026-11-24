// A distinct entrypoint lets registry harnesses detect support in frozen source roots.
import { buildAndPackPlugin } from "./plugin-npm-build-and-pack-core.mts";

try {
  const [outputDir, ...packageDirs] = process.argv.slice(2);
  if (!outputDir || packageDirs.length === 0) {
    throw new Error("usage: plugin-npm-build-and-pack-batch.mts <output-dir> <package-dir>...");
  }
  for (const packageDir of packageDirs) {
    const status = await buildAndPackPlugin(packageDir, outputDir);
    if (status !== 0) {
      process.exitCode = status;
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
