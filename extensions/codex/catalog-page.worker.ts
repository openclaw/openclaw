import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import {
  createCodexCatalogDecoder,
  type CodexCatalogDecodeInput,
} from "./src/app-server/client-catalog-response.js";

const decode = createCodexCatalogDecoder();
serveWorkerTasks((input: unknown) => {
  // SAFETY: The paired client owns this private, transferred-byte task protocol.
  return decode(input as CodexCatalogDecodeInput);
});
