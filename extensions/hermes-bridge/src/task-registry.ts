import type { HermesBridgeRequest, HermesBridgeTask } from "./types.js";

function readString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeRequestInput(request: HermesBridgeRequest): Record<string, unknown> {
  return request.input && typeof request.input === "object" && !Array.isArray(request.input)
    ? request.input
    : {};
}

const HERMES_BRIDGE_TASKS: readonly HermesBridgeTask[] = [
  {
    taskId: "status.echo",
    description: "Return the supplied message without side effects.",
    dangerous: false,
    mockOnly: true,
    requiredTools: [],
    execute({ request }) {
      const input = normalizeRequestInput(request);
      return { message: readString(input, "message") ?? "" };
    },
  },
  {
    taskId: "status.health",
    description: "Return local bridge health metadata without touching external systems.",
    dangerous: false,
    mockOnly: true,
    requiredTools: [],
    execute({ request, mode }) {
      return {
        status: "ok",
        bridge: "hermes-bridge",
        mode,
        dryRun: request.dryRun,
      };
    },
  },
  {
    taskId: "message.preview",
    description: "Build a message preview only; it never sends messages.",
    dangerous: false,
    mockOnly: true,
    requiredTools: [],
    execute({ request }) {
      const input = normalizeRequestInput(request);
      return {
        preview: {
          channel: readString(input, "channel") ?? null,
          recipient: readString(input, "recipient") ?? null,
          body: readString(input, "body") ?? "",
          wouldSend: false,
        },
      };
    },
  },
  {
    taskId: "tasks.organize_today",
    description: "Dry-run template for organizing today's tasks without touching external systems.",
    dangerous: false,
    mockOnly: true,
    requiresDryRun: true,
    requiredTools: [],
    successSummary: "Dry-run completed. No external side effects were performed.",
    execute({ request }) {
      const input = normalizeRequestInput(request);
      return {
        request: readString(input, "request") ?? request.intent,
        organizedTasks: [],
        dryRun: true,
        sideEffectsPerformed: false,
      };
    },
  },
  {
    taskId: "agents.ask_team",
    description:
      "Dry-run template for delegating a question to an OpenClaw agent team without starting agents.",
    dangerous: false,
    mockOnly: true,
    requiresDryRun: true,
    requiredTools: [],
    successSummary: "Dry-run completed. No OpenClaw agents were started.",
    execute({ request }) {
      const input = normalizeRequestInput(request);
      return {
        team: readString(input, "team") ?? "openclaw",
        question: readString(input, "question") ?? request.intent,
        dryRun: true,
        agentsStarted: false,
        sideEffectsPerformed: false,
      };
    },
  },
  {
    taskId: "message.send",
    description:
      "Mock-only future message send template; returns a preview and never sends messages.",
    dangerous: true,
    mockOnly: true,
    requiredTools: ["telegram.send"],
    execute({ request }) {
      const input = normalizeRequestInput(request);
      return {
        preview: {
          channel: readString(input, "channel") ?? "telegram",
          recipient: readString(input, "recipient") ?? null,
          body: readString(input, "body") ?? "",
          wouldSend: false,
        },
      };
    },
  },
];

const TASKS_BY_ID = new Map(HERMES_BRIDGE_TASKS.map((task) => [task.taskId, task]));

export function listHermesBridgeTasks(): readonly HermesBridgeTask[] {
  return HERMES_BRIDGE_TASKS;
}

export function getHermesBridgeTask(taskId: string): HermesBridgeTask | undefined {
  return TASKS_BY_ID.get(taskId);
}
