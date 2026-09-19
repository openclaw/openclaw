import { defineCodexBuildState } from "./build-state.js";

export type CodexCatalogSource = { readonly closed: boolean };
const getSources = defineCodexBuildState("openclaw.codexCatalogSources", () => ({
  clients: new WeakMap<object, { closed: boolean }>(),
  values: new WeakMap<object, CodexCatalogSource>(),
}));
// Local rebuilds retain source records created by earlier copies of this published version.
const getEphemeralObservers = defineCodexBuildState(
  "openclaw.codexCatalogEphemeralObservers",
  () => new WeakMap<CodexCatalogSource, (threadId: string) => void>(),
);

/** A passive lifetime fact; the token never retains its client or a lease. */
export function codexCatalogSourceForClient(client: object): CodexCatalogSource {
  const { clients } = getSources();
  let source = clients.get(client);
  if (!source) {
    source = { closed: false };
    clients.set(client, source);
  }
  return source;
}

export function closeCodexCatalogClientSource(client: object): void {
  const { clients } = getSources();
  const source = clients.get(client);
  if (source) {
    source.closed = true;
    getEphemeralObservers().delete(source);
  } else {
    clients.set(client, { closed: true });
  }
}

/** The catalog observer is bound once per physical source and released on closure. */
export function observeCodexCatalogEphemeralThreads(
  source: CodexCatalogSource,
  observer: (threadId: string) => void,
): void {
  getEphemeralObservers().set(source, observer);
}

export function getCodexCatalogSource(value: unknown): CodexCatalogSource | undefined {
  return value !== null && typeof value === "object" ? getSources().values.get(value) : undefined;
}

export function setCodexCatalogSource<T extends object>(
  value: T,
  source: CodexCatalogSource | undefined,
): T {
  if (source) {
    getSources().values.set(value, source);
  }
  return value;
}

/** Source attribution survives projection without becoming serialized row data. */
export function copyCodexCatalogSource<T extends object>(from: object, to: T): T {
  return setCodexCatalogSource(to, getCodexCatalogSource(from));
}

/** Stamp the final decoded objects, including any bounded catalog DTO replacement. */
export function recordCodexCatalogResponseSource(
  method: string,
  result: unknown,
  source: CodexCatalogSource,
): void {
  if (result === null || typeof result !== "object") {
    return;
  }
  if (method === "thread/list" && "data" in result && Array.isArray(result.data)) {
    setCodexCatalogSource(result, source);
    for (const thread of result.data) {
      if (thread !== null && typeof thread === "object") {
        setCodexCatalogSource(thread, source);
      }
    }
  } else if (
    (method === "thread/read" ||
      method === "thread/start" ||
      method === "thread/fork" ||
      method === "thread/resume") &&
    "thread" in result &&
    result.thread !== null &&
    typeof result.thread === "object"
  ) {
    setCodexCatalogSource(result, source);
    setCodexCatalogSource(result.thread, source);
    if (
      "ephemeral" in result.thread &&
      result.thread.ephemeral === true &&
      "id" in result.thread &&
      typeof result.thread.id === "string"
    ) {
      getEphemeralObservers().get(source)?.(result.thread.id);
    }
  }
}
