import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  readLocalAgentAvatarSnapshot,
  type LocalAgentAvatarRead,
  type LocalAgentAvatarSnapshot,
} from "./identity-avatar-file.js";

serveWorkerTasks<LocalAgentAvatarSnapshot, LocalAgentAvatarRead>(readLocalAgentAvatarSnapshot, {
  transferList: (result) =>
    "ok" in result && result.ok && result.file.body ? [result.file.body.buffer] : [],
});
