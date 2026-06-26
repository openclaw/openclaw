// Workboard plugin module implements command behavior.
import type { OpenClawPluginApi } from "../api.js";
import { resolveWorkboardCardByIdOrPrefix } from "./card-lookup.js";
import { dispatchAndStartWorkboardCards, type WorkboardSubagentRuntime } from "./dispatcher.js";
import type { WorkboardStore } from "./store.js";
import type { WorkboardCard } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const WRITE_SCOPE = "operator.write";

type WorkboardCommandApi = {
  runtime: {
    subagent: WorkboardSubagentRuntime;
  };
};

function splitArgs(input: string | undefined): string[] {
  return (input ?? "").trim().split(/\s+/).filter(Boolean);
}

function formatCardLine(card: WorkboardCard): string {
  const boardId = card.metadata?.automation?.boardId ?? "default";
  const agent = card.agentId ? ` @${card.agentId}` : "";
  return `${card.id.slice(0, 8)} ${card.status.padEnd(8)} ${card.priority.padEnd(6)} [${boardId}]${agent} ${card.title}`;
}

function formatCardDetails(card: WorkboardCard): string {
  const lines = [
    card.title,
    `id: ${card.id}`,
    `status: ${card.status}`,
    `priority: ${card.priority}`,
    `board: ${card.metadata?.automation?.boardId ?? "default"}`,
  ];
  if (card.agentId) {
    lines.push(`agent: ${card.agentId}`);
  }
  if (card.sessionKey) {
    lines.push(`session: ${card.sessionKey}`);
  }
  if (card.runId) {
    lines.push(`run: ${card.runId}`);
  }
  if (card.notes) {
    lines.push("", card.notes);
  }
  return lines.join("\n");
}

function normalizeTitle(tokens: string[]): string {
  return tokens.join(" ").trim();
}

function canMutateWorkboard(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): boolean {
  const scopes = params.gatewayClientScopes;
  if (scopes) {
    return scopes.includes(ADMIN_SCOPE) || scopes.includes(WRITE_SCOPE);
  }
  return params.senderIsOwner === true;
}

function requireWriteAccess(params: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): { text: string; isError: true } | undefined {
  if (canMutateWorkboard(params)) {
    return undefined;
  }
  return {
    text: `This command requires gateway scope: ${WRITE_SCOPE}.`,
    isError: true,
  };
}

export async function handleWorkboardCommand(params: {
  api: WorkboardCommandApi;
  store: WorkboardStore;
  args?: string;
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): Promise<{ text: string; isError?: boolean }> {
  const [action = "list", ...rest] = splitArgs(params.args);
  if (action === "help") {
    return {
      text: [
        "/workboard list",
        "/workboard show <card-id>",
        "/workboard create <title>",
        "/workboard move <card-id> --status <status>",
        "/workboard dispatch",
      ].join("\n"),
    };
  }
  if (action === "list") {
    const cards = (await params.store.list()).filter((card) => !card.metadata?.archivedAt);
    const rows = cards.slice(0, 12).map(formatCardLine);
    return { text: rows.length ? rows.join("\n") : "No Workboard cards." };
  }
  if (action === "show" || action === "read") {
    const id = rest[0];
    if (!id) {
      return { text: "Usage: /workboard show <card-id>", isError: true };
    }
    const cards = await params.store.list();
    const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
    return card ? { text: formatCardDetails(card) } : { text: error, isError: true };
  }
  if (action === "create") {
    const accessError = requireWriteAccess(params);
    if (accessError) {
      return accessError;
    }
    const title = normalizeTitle(rest);
    if (!title) {
      return { text: "Usage: /workboard create <title>", isError: true };
    }
    const card = await params.store.create({ title });
    return { text: `Created ${card.id.slice(0, 8)} ${card.title}` };
  }
  if (action === "dispatch") {
    const accessError = requireWriteAccess(params);
    if (accessError) {
      return accessError;
    }
    const result = await dispatchAndStartWorkboardCards({
      store: params.store,
      subagent: params.api.runtime.subagent,
    });
    return {
      text: [
        `dispatch: started=${result.started.length} failures=${result.startFailures.length} promoted=${result.promoted.length} blocked=${result.blocked.length}`,
        ...result.started.map((run) => `started ${run.cardId.slice(0, 8)} run=${run.runId}`),
        ...result.startFailures.map(
          (failure) => `failed ${failure.cardId.slice(0, 8)} ${failure.error}`,
        ),
      ].join("\n"),
    };
  }
  if (action === "move") {
    const accessError = requireWriteAccess(params);
    if (accessError) {
      return accessError;
    }
    const id = rest[0];
    const statusIndex = rest.indexOf("--status");
    const status = statusIndex >= 0 ? rest[statusIndex + 1] : undefined;
    if (!id) {
      return { text: "Usage: /workboard move <card-id> --status <status>", isError: true };
    }
    if (!status) {
      return { text: "Usage: /workboard move <card-id> --status <status>", isError: true };
    }
    const cards = await params.store.list();
    const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
    if (!card) {
      return { text: error, isError: true };
    }
    const validStatuses = [
      "triage",
      "backlog",
      "todo",
      "scheduled",
      "ready",
      "running",
      "review",
      "blocked",
      "done",
    ];
    if (!validStatuses.includes(status)) {
      return {
        text: `status must be one of: ${validStatuses.join(", ")}.`,
        isError: true,
      };
    }
    const updated = await params.store.move(card.id, status, undefined);
    return { text: formatCardLine(updated) };
  }
  return { text: `Unknown Workboard action: ${action}`, isError: true };
}

export function registerWorkboardCommand(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
}): void {
  params.api.registerCommand({
    name: "workboard",
    description: "List, create, inspect, and dispatch Workboard cards.",
    acceptsArgs: true,
    exposeSenderIsOwner: true,
    handler: async (ctx) =>
      await handleWorkboardCommand({
        api: params.api,
        store: params.store,
        args: ctx.args,
        senderIsOwner: ctx.senderIsOwner,
        gatewayClientScopes: ctx.gatewayClientScopes,
      }),
  });
}
