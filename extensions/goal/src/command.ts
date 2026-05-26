import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createFileGoalStore,
  createGoalState,
  GOAL_LEASE_KEY,
  GOAL_MAX_CONTINUATIONS,
  updateGoalState,
  type GoalState,
  type GoalStore,
} from "./state.js";
import { applyGoalStatus, buildGoalContinuationMessage } from "./workflow.js";

type GoalCommandDeps = {
  store?: GoalStore;
};

function usage(): string {
  return [
    "/goal help",
    "/goal start <objective>",
    "/goal status",
    "/goal events [n]",
    "/goal pause",
    "/goal resume",
    "/goal done [note]",
    "/goal clear [note]",
  ].join("\n");
}

function requireSession(ctx: PluginCommandContext): string | undefined {
  return typeof ctx.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey : undefined;
}

function formatGoal(state: GoalState): string {
  const note = state.lastNote ? `\nNote: ${state.lastNote}` : "";
  return `Goal: ${state.objective}\nStatus: ${state.status}\nContinuations: ${state.continuationCount}${note}`;
}

function formatEventTime(atMs: number): string {
  return new Date(atMs).toISOString();
}

function formatGoalEvents(state: GoalState, limit: number): string {
  const events = state.events.slice(-limit);
  if (events.length === 0) {
    return `No events for goal: ${state.objective}`;
  }
  return events
    .map((event) => {
      const status = event.status ? ` ${event.status}` : "";
      const note = event.note ? ` - ${event.note}` : "";
      return `${formatEventTime(event.atMs)} ${event.kind}${status}${note}`;
    })
    .join("\n");
}

function parseEventLimit(value: string | undefined): number {
  if (!value) {
    return 10;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return 10;
  }
  return Math.min(parsed, 50);
}

async function startGoal(params: {
  api: OpenClawPluginApi;
  store: GoalStore;
  ctx: PluginCommandContext;
  objective: string;
}): Promise<PluginCommandResult> {
  const sessionKey = requireSession(params.ctx);
  if (!sessionKey) {
    return { text: "/goal needs an active session." };
  }
  const initial = createGoalState({
    sessionKey,
    objective: params.objective,
  });
  await params.store.write(initial);
  const lease = await params.api.session.workflow.requestSessionContinuationLease({
    session: params.ctx,
    leaseKey: GOAL_LEASE_KEY,
    message: buildGoalContinuationMessage(initial),
    delayMs: 1_000,
    deliveryMode: "announce",
  });
  if (lease.scheduled) {
    await params.store.write(
      updateGoalState(initial, {
        status: "continue",
        continuationScheduled: true,
      }),
    );
  }
  return {
    text: `Goal started: ${params.objective}\nContinuation: ${
      lease.scheduled ? "scheduled" : `not scheduled (${lease.reason})`
    }`,
  };
}

export async function handleGoalCommand(
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
  deps: GoalCommandDeps = {},
): Promise<PluginCommandResult> {
  const sessionKey = requireSession(ctx);
  if (!sessionKey) {
    return { text: "/goal needs an active session." };
  }
  const store =
    deps.store ?? createFileGoalStore({ stateDir: api.runtime.state.resolveStateDir() });
  const args = ctx.args?.trim() ?? "";
  const tokens = args.split(/\s+/u).filter(Boolean);
  const actionRaw = tokens.find(Boolean);
  const rest = tokens.slice(actionRaw ? 1 : 0);
  const action = (actionRaw ?? "status").toLowerCase();

  if (action === "help") {
    return { text: usage() };
  }

  if (action === "start") {
    const objective = rest.join(" ").trim();
    if (!objective) {
      return { text: `Usage: /goal start <objective>` };
    }
    return await startGoal({ api, store, ctx, objective });
  }

  const current = await store.read(sessionKey);
  if (!current) {
    return {
      text: action ? `No active goal. Use /goal start <objective>.` : usage(),
    };
  }

  if (action === "status") {
    return { text: formatGoal(current) };
  }

  if (action === "events") {
    return { text: formatGoalEvents(current, parseEventLimit(rest[0])) };
  }

  if (action === "clear") {
    const cleanup = await api.session.workflow.clearSessionContinuationLease({
      session: ctx,
      leaseKey: GOAL_LEASE_KEY,
    });
    if (cleanup.failed > 0) {
      return {
        text:
          "Could not clear the pending goal continuation; keeping the goal active. " +
          `Goal still active: ${current.objective}`,
      };
    }
    await store.delete(sessionKey);
    return { text: `Goal cleared: ${current.objective}` };
  }

  if (action === "pause" || action === "done") {
    const status = action === "pause" ? "paused" : "done";
    const next = await applyGoalStatus({
      store,
      workflow: api.session.workflow,
      session: ctx,
      state: current,
      status,
      note: rest.join(" ").trim() || undefined,
    });
    return { text: formatGoal(next) };
  }

  if (action === "resume") {
    if (
      current.status === "done" ||
      current.status === "blocked" ||
      current.continuationCount >= GOAL_MAX_CONTINUATIONS
    ) {
      return { text: `Goal is ${current.status}; start a new goal to continue.` };
    }
    const next = await applyGoalStatus({
      store,
      workflow: api.session.workflow,
      session: ctx,
      state: current,
      status: "continue",
      note: rest.join(" ").trim() || undefined,
    });
    return { text: formatGoal(next) };
  }

  return { text: `Unknown /goal command: ${action}\n\n${usage()}` };
}

export function createGoalCommand(
  api: OpenClawPluginApi,
  deps: GoalCommandDeps = {},
): OpenClawPluginCommandDefinition {
  return {
    name: "goal",
    description: "Track a session-scoped goal and schedule bounded continuation turns.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleGoalCommand(api, ctx, deps),
  };
}
