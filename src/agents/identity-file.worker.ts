import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { readIdentityFileSnapshot } from "./identity-file.js";

serveWorkerTasks((input) => {
  if (
    !isRecord(input) ||
    typeof input.identityPath !== "string" ||
    (input.knownRevision !== undefined && typeof input.knownRevision !== "string")
  ) {
    throw new Error("Invalid identity file read request");
  }
  return readIdentityFileSnapshot({
    identityPath: input.identityPath,
    knownRevision: input.knownRevision,
  });
});
