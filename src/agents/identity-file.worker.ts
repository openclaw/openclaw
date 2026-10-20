import { serveWorkerTasks } from "../infra/worker-task-server.js";
import {
  readIdentityFileSnapshot,
  type IdentityFileRead,
  type IdentityFileSnapshot,
} from "./identity-file.js";

serveWorkerTasks<IdentityFileSnapshot, IdentityFileRead>(readIdentityFileSnapshot);
