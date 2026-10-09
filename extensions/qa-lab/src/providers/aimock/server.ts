import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type Journal,
  LLMock,
  type ChatCompletionRequest,
  type Fixture,
  getTextContent,
  isChatCompletionBody,
  type JournalEntry,
  type Mountable,
} from "@copilotkit/aimock";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveQaDebugRequestCursor } from "../shared/debug-request-cursor.js";
import { writeJson } from "../shared/http-json.js";
import { resolveMockProviderVariant } from "../shared/mock-provider-variant.js";
import { isInternalRuntimeContextCarrierText } from "../shared/runtime-context.js";
import type { QaMockRequestSnapshot } from "../shared/types.js";

const AIMOCK_DEBUG_REQUEST_LIMIT = 1_000;
const AIMOCK_DEBUG_FACTS_MAX_BYTES = 64 * 1024;

type AimockRequestFacts = Omit<QaMockRequestSnapshot, "raw" | "body">;
type AimockRequestProjection =
  | { complete: true; facts: AimockRequestFacts }
  | {
      complete: false;
      facts: Partial<AimockRequestFacts>;
      omittedFields: Array<keyof AimockRequestFacts>;
    };
type AimockToolFacts = Pick<
  AimockRequestFacts,
  "plannedToolName" | "plannedToolCallId" | "toolOutputCallId"
>;
type AimockChatJournalEntry = Pick<JournalEntry, "response"> & {
  body: ChatCompletionRequest;
};
type AimockJournalAdd = (
  entry: Omit<JournalEntry, "id" | "timestamp">,
  matchedFixture?: Fixture,
) => JournalEntry;
type AimockRequestObservation =
  | { kind: "retained-body"; body: ChatCompletionRequest; tools: AimockToolFacts }
  | { kind: "projected"; projection: AimockRequestProjection };

function requestMessages(body: ChatCompletionRequest | null | undefined) {
  return Array.isArray(body?.messages) ? body.messages : [];
}

function countImageInputs(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countImageInputs(entry), 0);
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const imageLikeType =
    type === "input_image" || type === "image" || type === "image_url" || type === "media";
  const nested =
    countImageInputs(record.content) +
    countImageInputs(record.image_url) +
    countImageInputs(record.source);
  return (imageLikeType ? 1 : 0) + nested;
}

function extractToolFacts(entry: AimockChatJournalEntry): AimockToolFacts {
  const response = entry.response.fixture?.response as
    | {
        toolCalls?: Array<{ name?: unknown; id?: unknown; callId?: unknown; toolCallId?: unknown }>;
      }
    | undefined;
  const call = response?.toolCalls?.[0];
  const callId = call?.id ?? call?.callId ?? call?.toolCallId;
  const output = requestMessages(entry.body).findLast(
    (message) => message?.role === "tool" && typeof message.tool_call_id === "string",
  );
  return {
    plannedToolName: typeof call?.name === "string" && call.name.length > 0 ? call.name : undefined,
    plannedToolCallId: typeof callId === "string" && callId.length > 0 ? callId : undefined,
    toolOutputCallId: output?.tool_call_id || undefined,
  };
}

function extractRequestFacts(
  body: ChatCompletionRequest,
  tools: AimockToolFacts,
): AimockRequestFacts {
  const model = typeof body?.model === "string" ? body.model : "";
  const messages = requestMessages(body);
  const user = messages.findLast(
    (message) =>
      message?.role === "user" &&
      !isInternalRuntimeContextCarrierText(getTextContent(message.content) ?? ""),
  );
  const output = messages.findLast((message) => message?.role === "tool");
  const outputRecord = asOptionalObjectRecord(output);
  return {
    ...tools,
    model,
    prompt: user ? (getTextContent(user.content) ?? "") : "",
    providerVariant: resolveMockProviderVariant(model, "aimock"),
    imageInputCount: countImageInputs(messages),
    ...(outputRecord?.isError === true || outputRecord?.is_error === true
      ? { toolOutputStructuredError: true }
      : {}),
    toolOutput: output ? (getTextContent(output.content) ?? "") : "",
    allInputText: messages
      .map((message) => getTextContent(message.content) ?? "")
      .filter(Boolean)
      .join("\n"),
  };
}

function boundRequestFacts(projection: AimockRequestProjection): AimockRequestProjection {
  if (Buffer.byteLength(JSON.stringify(projection)) <= AIMOCK_DEBUG_FACTS_MAX_BYTES) {
    return projection;
  }
  const { facts } = projection;
  const retained: Partial<AimockRequestFacts> = {};
  const fields = Object.keys(facts) as Array<keyof AimockRequestFacts>;
  const omittedFields = projection.complete ? [] : [...projection.omittedFields];
  const reservedOmissions = [...omittedFields, ...fields];
  // Reserve correlation facts before text: an older overflowing prompt must not
  // redirect its tool result to a newer plan. Omission names share the byte budget.
  for (const field of fields) {
    const candidate = { ...retained, [field]: facts[field] };
    const diagnostic = {
      complete: false,
      cursor: Number.MAX_SAFE_INTEGER,
      facts: candidate,
      omittedFields: reservedOmissions,
    };
    if (Buffer.byteLength(JSON.stringify(diagnostic)) <= AIMOCK_DEBUG_FACTS_MAX_BYTES) {
      Object.assign(retained, { [field]: facts[field] });
    } else {
      omittedFields.push(field);
    }
  }
  return { complete: false, facts: retained, omittedFields };
}

function resolvePlannedToolCallIds(snapshots: AimockToolFacts[]): Map<number, string> {
  const callIds = new Map<number, string>();
  const pendingPlannedIndexes: number[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    if (snapshot.toolOutputCallId && pendingPlannedIndexes.length > 0) {
      const plannedIndex = pendingPlannedIndexes.shift();
      if (plannedIndex !== undefined) {
        callIds.set(plannedIndex, snapshot.toolOutputCallId);
      }
    }
    if (snapshot.plannedToolName && !snapshot.plannedToolCallId) {
      pendingPlannedIndexes.push(index);
    }
  }
  return callIds;
}

function createDebugMount(): Mountable {
  let journal: Journal | undefined;
  let nextRequestCursor = 1;
  const requestCursors = new Map<string, number>();
  const observations = new WeakMap<JournalEntry, AimockRequestObservation>();

  return {
    setJournal(nextJournal) {
      if (journal === nextJournal) {
        return;
      }
      if (journal) {
        throw new Error("AIMock debug request cursor journal changed unexpectedly");
      }
      journal = nextJournal;
      const addJournalEntry: AimockJournalAdd = journal.add.bind(journal);
      // AIMock evicts its request journal FIFO. Assign cursors at insertion time
      // so the debug boundary remains monotonic after retained entries rotate.
      journal.add = (entry, matchedFixture?: Fixture) => {
        const recorded = addJournalEntry(entry, matchedFixture);
        const body = entry.body;
        if (!isChatCompletionBody(body)) {
          return recorded;
        }
        const tools = extractToolFacts({ response: entry.response, body });
        // Upstream keeps <=64 KiB bodies intact; only discarded bodies need an
        // extra bounded projection. Weak entry ownership follows eviction/reset.
        observations.set(
          recorded,
          recorded.body === entry.body
            ? { kind: "retained-body", body, tools }
            : {
                kind: "projected",
                projection: boundRequestFacts({
                  complete: true,
                  facts: extractRequestFacts(body, tools),
                }),
              },
        );
        requestCursors.set(recorded.id, nextRequestCursor++);
        if (requestCursors.size > AIMOCK_DEBUG_REQUEST_LIMIT) {
          const oldestRequestId = requestCursors.keys().next().value;
          if (oldestRequestId !== undefined) {
            requestCursors.delete(oldestRequestId);
          }
        }
        return recorded;
      };
    },
    async handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string) {
      if (pathname === "/request-cursor") {
        writeJson(res, 200, { cursor: nextRequestCursor - 1 });
        return true;
      }
      const entries = journal?.getAll() ?? [];
      if (pathname === "/image-generations") {
        writeJson(
          res,
          200,
          entries
            .filter((entry) => entry.path === "/v1/images/generations")
            .map((entry) => entry.body ?? {}),
        );
        return true;
      }
      if (pathname !== "/last-request" && pathname !== "/requests") {
        return false;
      }
      let selected = entries
        .filter((entry) => observations.has(entry))
        .map((entry, index) => {
          const cursor = requestCursors.get(entry.id);
          const observation = observations.get(entry);
          if (cursor === undefined || observation === undefined) {
            throw new Error(`AIMock debug request observation missing for ${entry.id}`);
          }
          return { cursor, entry, observation, index };
        });
      // Pair against retained tool facts before selecting a window: a result
      // inside the window may belong to a plan before its cursor.
      const plannedToolCallIds = resolvePlannedToolCallIds(
        selected.map(({ observation }) =>
          observation.kind === "retained-body" ? observation.tools : observation.projection.facts,
        ),
      );
      if (pathname === "/requests") {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const afterText = url.searchParams.get("after");
        if (afterText !== null) {
          const after = resolveQaDebugRequestCursor(
            afterText,
            selected[0]?.cursor ?? nextRequestCursor,
            nextRequestCursor - 1,
          );
          if (typeof after !== "number") {
            writeJson(res, after.status, after.body);
            return true;
          }
          selected = selected.filter((request) => request.cursor > after);
        }
      } else {
        selected = selected.slice(-1);
      }
      const snapshots: QaMockRequestSnapshot[] = [];
      const incomplete: Array<
        { cursor: number } & Extract<AimockRequestProjection, { complete: false }>
      > = [];
      for (const { cursor, entry, observation, index } of selected) {
        const plannedToolCallId = plannedToolCallIds.get(index);
        let projection: AimockRequestProjection =
          observation.kind === "retained-body"
            ? { complete: true, facts: extractRequestFacts(observation.body, observation.tools) }
            : observation.projection;
        if (plannedToolCallId) {
          projection = projection.complete
            ? { complete: true, facts: { ...projection.facts, plannedToolCallId } }
            : { ...projection, facts: { ...projection.facts, plannedToolCallId } };
          if (observation.kind === "projected") {
            projection = boundRequestFacts(projection);
          }
        }
        if (!projection.complete) {
          incomplete.push({ cursor, ...projection });
          continue;
        }
        const body = observation.kind === "retained-body" ? observation.body : (entry.body ?? {});
        snapshots.push({ raw: JSON.stringify(body), body, ...projection.facts });
      }
      if (incomplete.length > 0) {
        writeJson(res, 413, {
          code: "QA_DEBUG_SNAPSHOT_INCOMPLETE",
          error:
            "Semantic facts exceeded the retained byte limit; omitted fields cannot prove presence or absence. Use /debug/request-cursor for request count deltas, or /debug/requests?after=<cursor> for a later window.",
          maxBytes: AIMOCK_DEBUG_FACTS_MAX_BYTES,
          requests: incomplete,
        });
        return true;
      }
      writeJson(
        res,
        200,
        pathname === "/requests"
          ? snapshots
          : (snapshots[0] ?? { ok: false, error: "no request recorded" }),
      );
      return true;
    },
  };
}

export async function startQaAimockServer(params?: { host?: string; port?: number }) {
  const mock = new LLMock({
    host: params?.host ?? "127.0.0.1",
    port: params?.port ?? 0,
    strict: false,
    logLevel: "silent",
    journalMaxEntries: AIMOCK_DEBUG_REQUEST_LIMIT,
  });

  mock.mount("/debug", createDebugMount());
  mock.onMessage(/.*/, { content: "AIMOCK_QA_OK" });

  await mock.start();
  return {
    baseUrl: mock.baseUrl,
    addFixture(fixture: Fixture): void {
      mock.addFixture(fixture);
    },
    async stop() {
      await mock.stop();
    },
  };
}
