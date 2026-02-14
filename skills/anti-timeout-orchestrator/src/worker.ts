import process from "node:process";
import { createDefaultDeps } from "../../../src/cli/deps.js";
import { agentCommand } from "../../../src/commands/agent.js";
import { defaultRuntime } from "../../../src/runtime.js";

interface WorkerMessage {
  type: "execute";
  task: {
    id: string;
    command: string;
    label?: string;
  };
}

interface WorkerResponse {
  type: "result";
  taskId: string;
  status: "done" | "failed";
  error: string | null;
}

function log(msg: string) {
  console.log(`[Worker ${process.pid}] ${msg}`);
}

async function runAgentTask(task: { id: string; command: string; label?: string }) {
  log(`Processing task ${task.id}: ${task.label || "No label"}`);

  try {
    const args = task.command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const messageIdx = args.indexOf("--message");
    const sessionIdx = args.indexOf("--session");

    let message = "";
    if (messageIdx !== -1 && messageIdx + 1 < args.length) {
      message = args[messageIdx + 1].replace(/^"|"$/g, "");
    }

    let sessionKey = "";
    if (sessionIdx !== -1 && sessionIdx + 1 < args.length) {
      sessionKey = args[sessionIdx + 1].replace(/^"|"$/g, "");
    }

    if (!message) {
      throw new Error("Could not parse --message from command");
    }

    await agentCommand(
      {
        message: message,
        sessionKey: sessionKey || undefined,
        verbose: "off",
      },
      defaultRuntime,
      createDefaultDeps(),
    );

    return { status: "done", error: null };
  } catch (err: any) {
    console.error(`[Worker ${process.pid}] Task ${task.id} failed:`, err);
    return { status: "failed", error: err.message || String(err) };
  }
}

process.on("message", async (msg: WorkerMessage) => {
  if (msg.type === "execute") {
    const result = await runAgentTask(msg.task);

    const response: WorkerResponse = {
      type: "result",
      taskId: msg.task.id,
      status: result.status as "done" | "failed",
      error: result.error,
    };

    if (process.send) {
      process.send(response);
    }

    log(`Task ${msg.task.id} complete. Exiting.`);
    process.exit(0);
  }
});

log("Ready and waiting for IPC task.");
if (process.send) {
  process.send({ type: "ready", pid: process.pid });
}
