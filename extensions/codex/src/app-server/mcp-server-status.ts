import type { CodexListMcpServerStatusResponse, CodexMcpServerStatus } from "./protocol.js";

type ReadPage = (cursor?: string) => Promise<CodexListMcpServerStatusResponse>;
type PaginationErrors = { repeatedCursor: string; pageLimit: string };

async function* readCodexMcpServerStatusPages(
  readPage: ReadPage,
  errors: PaginationErrors,
): AsyncGenerator<readonly CodexMcpServerStatus[]> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const response = await readPage(cursor);
    yield response.data;
    if (!response.nextCursor) {
      return;
    }
    cursor = response.nextCursor;
    if (seenCursors.has(cursor)) {
      throw new Error(errors.repeatedCursor);
    }
    seenCursors.add(cursor);
  }
  throw new Error(errors.pageLimit);
}

export async function findCodexMcpServerStatus(
  readPage: ReadPage,
  name: string,
  errors: PaginationErrors,
): Promise<CodexMcpServerStatus | undefined> {
  for await (const statuses of readCodexMcpServerStatusPages(readPage, errors)) {
    const found = statuses.find((status) => status.name === name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export async function listCodexMcpServerStatuses(
  readPage: ReadPage,
  errors: PaginationErrors,
): Promise<CodexMcpServerStatus[]> {
  const statuses: CodexMcpServerStatus[] = [];
  for await (const page of readCodexMcpServerStatusPages(readPage, errors)) {
    statuses.push(...page);
  }
  return statuses;
}
