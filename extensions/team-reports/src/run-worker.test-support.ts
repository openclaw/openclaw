import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type { ReportWorkerRequest } from "./run-worker-contract.js";

serveWorkerTasks(async (_input, channel) => {
  if (!channel) {
    throw new Error("Missing fixture channel");
  }
  const request: ReportWorkerRequest = {
    kind: "llm",
    params: { messages: [{ role: "user", content: "Synthetic report" }], purpose: "fixture" },
    logs: [],
  };
  const response = await channel.request(request);
  response.consumed();
  return {};
});
