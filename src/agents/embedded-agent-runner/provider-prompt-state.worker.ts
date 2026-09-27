import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { serveWorkerTasks } from "../../infra/worker-task-server.js";

serveWorkerTasks((payload) => sha256StableValue(payload));
