import { parentPort, workerData } from "node:worker_threads";
import { scanSourceFacts, type SourceScan } from "./test-selector-source-facts.mts";

if (!parentPort) {
  throw new Error("test selector source worker requires its parent port");
}
const { scan }: { scan: SourceScan } = workerData;
parentPort.postMessage(await scanSourceFacts(scan), []);
