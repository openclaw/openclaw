import { parentPort, workerData } from "node:worker_threads";
import { generateNpmPackageLock } from "./generate-npm-package-lock.mts";

if (!parentPort) {
  throw new Error("npm package-lock worker requires its parent port");
}
const { packageDir }: { packageDir: string } = workerData;
try {
  parentPort.postMessage({ output: generateNpmPackageLock(packageDir) }, []);
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
}
