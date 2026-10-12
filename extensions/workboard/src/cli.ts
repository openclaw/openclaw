import { WORKBOARD_STATUSES, type WorkboardCard } from "@openclaw/workboard-contract";
import type { Command } from "commander";
import { runWithLocalStateOwner } from "openclaw/plugin-sdk/cli-state-owner";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  parseTimeoutMsWithFallback,
  isImplicitLocalGatewayTargetFromCli,
} from "openclaw/plugin-sdk/gateway-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveWorkboardCardByIdOrPrefix } from "./card-lookup.js";
import { redactClaimToken, redactDispatchResult } from "./card-redaction.js";
import type { WorkboardStore } from "./store.js";

type JsonOptions = {
  json?: boolean;
};

type GatewayOptions = JsonOptions & {
  admin?: boolean;
  url?: string;
  token?: string;
  timeout?: string;
  port?: string;
  password?: string;
  expectFinal?: boolean;
  board?: string;
};

type DispatchOptions = GatewayOptions & {
  maxStarts?: number;
};

function parseMaxStarts(value: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw Object.assign(new Error("--max-starts must be a positive integer."), {
      name: "InvalidArgumentError",
      code: "commander.invalidArgument",
      exitCode: 1,
    });
  }
  return parsed;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

function formatCardLine(card: WorkboardCard): string {
  const boardId = card.metadata?.automation?.boardId ?? "default";
  const agent = card.agentId ? ` ${card.agentId}` : "";
  const archived = card.metadata?.archivedAt ? " (archived)" : "";
  return `${card.id.slice(0, 8)}  ${card.status.padEnd(8)}  ${card.priority.padEnd(6)}  ${boardId}${agent}  ${card.title}${archived}`;
}

function writeCards(cards: WorkboardCard[], options: JsonOptions): void {
  if (options.json) {
    writeJson({ cards: cards.map(redactClaimToken) });
    return;
  }
  for (const card of cards) {
    writeLine(formatCardLine(card));
  }
}

function writeCard(card: WorkboardCard, options: JsonOptions): void {
  if (options.json) {
    writeJson({ card: redactClaimToken(card) });
  } else {
    writeLine(formatCardLine(card));
  }
}

export function registerWorkboardCli(params: {
  program: Command;
  withStore: <T>(action: (store: WorkboardStore) => Promise<T>) => Promise<T>;
}): void {
  const local = <T>(
    method: string,
    input: Record<string, unknown>,
    action: (store: WorkboardStore, assertCurrent: () => void) => Promise<T>,
    options?: Pick<
      Parameters<typeof runWithLocalStateOwner>[0],
      "scopes" | "timeoutMs" | "expectFinal"
    >,
  ) =>
    runWithLocalStateOwner<T>({
      method: `${method}.owner`,
      params: input,
      target: "Workboard",
      ...options,
      recoveryCommand: "openclaw workboard list --json",
      runLocal: ({ assertCurrent }) =>
        params.withStore(async (store) => {
          assertCurrent();
          return await action(store, assertCurrent);
        }),
    });
  const list = (boardId?: string) =>
    local("workboard.cards.list", { boardId }, async (store) => ({
      cards: await store.list({ boardId }),
    }));
  const workboard = params.program
    .command("workboard")
    .description("Manage Workboard cards and worker dispatch");

  workboard
    .command("list")
    .description("List Workboard cards")
    .option("--board <id>", "Board id")
    .addOption(
      workboard
        .createOption("--status <status>", "Filter by status")
        .choices([...WORKBOARD_STATUSES]),
    )
    .option("--include-archived", "Include archived cards (default false)")
    .option("--json", "Print JSON", false)
    .action(
      async (
        options: JsonOptions & {
          board?: string;
          status?: string;
          includeArchived?: boolean;
        },
      ) => {
        // Text output hides archived cards like /workboard list, while --json
        // keeps the shipped full-card contract for existing scripts.
        let cards = (await list(options.board)).cards;
        if (!options.json && options.includeArchived !== true) {
          cards = cards.filter((card) => !card.metadata?.archivedAt);
        }
        if (options.status) {
          cards = cards.filter((card) => card.status === options.status);
        }
        writeCards(cards, options);
      },
    );

  workboard
    .command("create")
    .argument("<title...>", "Card title")
    .description("Create a Workboard card")
    .option("--notes <text>", "Card notes")
    .option("--status <status>", "Initial status", "todo")
    .option("--priority <priority>", "Priority", "normal")
    .option("--agent <id>", "Assigned agent id")
    .option("--board <id>", "Board id")
    .option("--labels <items>", "Comma-separated labels")
    .option("--json", "Print JSON", false)
    .action(
      async (
        title: string[],
        options: JsonOptions & {
          notes?: string;
          status?: string;
          priority?: string;
          agent?: string;
          board?: string;
          labels?: string;
        },
      ) => {
        const input = {
          title: title.join(" "),
          notes: options.notes,
          status: options.status,
          priority: options.priority,
          agentId: options.agent,
          boardId: options.board,
          labels: options.labels,
        };
        const { card } = await local(
          "workboard.cards.create",
          input,
          async (store, assertCurrent) => ({
            card: await store.create(
              { ...input, workspaceAccess: { unrestricted: true } },
              undefined,
              assertCurrent,
            ),
          }),
        );
        writeCard(card, options);
      },
    );

  workboard
    .command("show")
    .argument("<id>", "Card id or prefix")
    .description("Show one Workboard card")
    .option("--json", "Print JSON", false)
    .action(async (id: string, options: JsonOptions) => {
      const cards = (await list()).cards;
      const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
      if (!card) {
        throw new Error(error);
      }
      writeCard(card, options);
      if (!options.json && card.notes) {
        writeLine(card.notes);
      }
    });

  workboard
    .command("move")
    .argument("<id>", "Card id or prefix")
    .description("Move a Workboard card to another status")
    .requiredOption("--status <status>", "Target status")
    .option("--json", "Print JSON", false)
    .action(async (id: string, options: JsonOptions & { status: string }) => {
      if (!(WORKBOARD_STATUSES as readonly string[]).includes(options.status)) {
        throw new Error(`--status must be one of: ${WORKBOARD_STATUSES.join(", ")}.`);
      }
      const cards = (await list()).cards;
      const { card, error } = resolveWorkboardCardByIdOrPrefix(cards, id);
      if (!card) {
        throw new Error(error);
      }
      const input = { id: card.id, status: options.status, expectedUpdatedAt: card.updatedAt };
      const { card: updated } = await local(
        "workboard.cards.move",
        input,
        async (store, assertCurrent) => ({
          card: await store.move(card.id, options.status, undefined, undefined, {
            expectedUpdatedAt: card.updatedAt,
            assertOwnerCurrent: assertCurrent,
          }),
        }),
      );
      writeCard(updated, options);
    });

  addGatewayClientOptions(
    workboard
      .command("dispatch")
      .description("Promote ready cards and start worker runs through the Gateway")
      .option("--board <id>", "Dispatch a single board")
      .option(
        "--max-starts <count>",
        "Maximum new worker runs to start in this pass (default 3)",
        parseMaxStarts,
      )
      .option("--admin", "Request full-host workspace access", false)
      .option("--json", "Print JSON", false),
  ).action(async (options: DispatchOptions) => {
    const method =
      options.maxStarts === undefined
        ? "workboard.cards.dispatch"
        : "workboard.cards.dispatchWithOptions";
    const input = {
      boardId: options.board,
      ...(options.maxStarts !== undefined ? { maxStarts: options.maxStarts } : {}),
    };
    const scopes: NonNullable<Parameters<typeof callGatewayFromCli>[3]>["scopes"] = options.admin
      ? ["operator.admin", "operator.write", "operator.read"]
      : ["operator.write", "operator.read"];
    const result = await (!options.token?.trim() &&
    !options.password?.trim() &&
    (await isImplicitLocalGatewayTargetFromCli(options))
      ? local(
          method,
          input,
          async (store, assertCurrent) => ({
            ...redactDispatchResult(
              await store.dispatch({ boardId: options.board, assertOwnerCurrent: assertCurrent }),
            ),
            gatewayUnavailable: true,
            started: [],
            startFailures: [],
          }),
          {
            scopes,
            timeoutMs: parseTimeoutMsWithFallback(options.timeout, 30_000, {
              invalidType: "error",
            }),
            expectFinal: options.expectFinal,
          },
        )
      : callGatewayFromCli(method, options, input, {
          mode: "cli",
          scopes,
        }));
    if (options.json) {
      writeJson(result);
    } else {
      const record = isRecord(result) ? result : {};
      if (record.gatewayUnavailable === true) {
        writeLine(
          `gateway unavailable; data dispatch only: promoted=${Array.isArray(record.promoted) ? record.promoted.length : 0} blocked=${Array.isArray(record.blocked) ? record.blocked.length : 0}`,
        );
        return;
      }
      const started = Array.isArray(record.started) ? record.started.length : 0;
      const failures = Array.isArray(record.startFailures) ? record.startFailures : [];
      writeLine(`dispatch complete: started=${started} failures=${failures.length}`);
      for (const failure of failures) {
        if (
          isRecord(failure) &&
          typeof failure.cardId === "string" &&
          typeof failure.error === "string"
        ) {
          writeLine(`${failure.cardId.slice(0, 8)}: ${failure.error}`);
        }
      }
    }
  });
}
