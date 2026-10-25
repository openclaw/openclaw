import { loadLanceDbModule } from "./lancedb-runtime.js";
import { runMemoryStatsReader } from "./memory-stats-reader.js";

await runMemoryStatsReader(loadLanceDbModule);
