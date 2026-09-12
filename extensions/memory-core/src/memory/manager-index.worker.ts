import { serveWorkerTasks } from "openclaw/plugin-sdk/process-runtime";
import {
  prepareMemoryIndexChunks,
  type MemoryIndexPreparationInput,
} from "./manager-index-preparation.js";

serveWorkerTasks((input) => {
  // SAFETY: The paired runtime sends immutable content and provider limits, never a provider or database handle.
  return prepareMemoryIndexChunks(input as MemoryIndexPreparationInput);
});
