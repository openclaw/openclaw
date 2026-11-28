import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import {
  decodeCodexCatalogFrame,
  type CodexCatalogDecodeInput,
} from "./src/app-server/client-catalog-response.js";

serveWorkerTasks((input: unknown) => {
  // SAFETY: The paired client owns this private, transferred-byte task protocol.
  return decodeCodexCatalogFrame(input as CodexCatalogDecodeInput);
});
