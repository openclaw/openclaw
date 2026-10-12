import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../infra/worker-task-server.js";
import { readLocalAgentAvatarSnapshot } from "./identity-avatar-file.js";

serveWorkerTasks(
  (input) => {
    if (
      !isRecord(input) ||
      typeof input.workspaceDir !== "string" ||
      typeof input.source !== "string" ||
      typeof input.readBody !== "boolean" ||
      (input.knownRevision !== undefined && typeof input.knownRevision !== "string")
    ) {
      throw new Error("Invalid local avatar read request");
    }
    return readLocalAgentAvatarSnapshot({
      workspaceDir: input.workspaceDir,
      source: input.source,
      readBody: input.readBody,
      knownRevision: input.knownRevision,
    });
  },
  {
    transferList: (result) =>
      "ok" in result && result.ok && result.file.body ? [result.file.body.buffer] : [],
  },
);
