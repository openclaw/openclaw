// Serial sqlite-vec queries stay OS-killable even while native SQLite is busy.
import {
  ensureSqliteLibrarySelected,
  loadSqliteVecExtension,
  openNodeSqliteDatabase,
  supportsNodeSqliteExtensionLoading,
} from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import {
  runVectorKnnQuery,
  validateVectorKnnRequest,
  type VectorKnnRequest,
  type VectorKnnResponse,
} from "./manager-search-knn.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

export type VectorKnnChildInput = {
  id: number;
  databasePath: string;
  extensionPath?: string;
  sqliteLibraryPath?: string;
  request: VectorKnnRequest;
};

type VectorKnnChildResult =
  | { status: "ok"; value: VectorKnnResponse }
  | { status: "failed"; error: string };

function isChildInput(value: unknown): value is VectorKnnChildInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  // SAFETY: the object guard above permits explicit validation of every field read below.
  const input = value as Partial<VectorKnnChildInput>;
  return (
    Number.isSafeInteger(input.id) &&
    typeof input.databasePath === "string" &&
    input.databasePath.length > 0 &&
    (input.sqliteLibraryPath === undefined ||
      (typeof input.sqliteLibraryPath === "string" && input.sqliteLibraryPath.trim().length > 0)) &&
    Boolean(input.request) &&
    typeof input.request === "object"
  );
}

async function run(input: VectorKnnChildInput): Promise<VectorKnnChildResult> {
  validateVectorKnnRequest(input.request);
  ensureSqliteLibrarySelected({ explicitPath: input.sqliteLibraryPath });
  const extensionLoadingSupported = supportsNodeSqliteExtensionLoading();
  const db = openNodeSqliteDatabase(input.databasePath, {
    allowExtension: extensionLoadingSupported,
    readOnly: true,
  });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000");
    if (!extensionLoadingSupported) {
      return { status: "ok", value: { rows: [], fallbackScanRequired: true } };
    }
    const loaded = await loadSqliteVecExtension({
      db,
      extensionPath: input.extensionPath,
    });
    if (!loaded.ok) {
      throw new Error(loaded.error ?? "sqlite-vec unavailable in memory search child");
    }
    return { status: "ok", value: runVectorKnnQuery(db, input.request) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    db.close();
  }
}

function writeResult(id: number, result: VectorKnnChildResult): void {
  let payload = Buffer.from(JSON.stringify({ ...result, id }), "utf8");
  if (payload.byteLength > MAX_STDOUT_BYTES) {
    payload = Buffer.from(
      JSON.stringify({
        id,
        status: "failed",
        error: "memory vector KNN child result is too large",
      }),
      "utf8",
    );
  }
  process.stdout.write(Buffer.concat([payload, Buffer.from("\n")]));
}

const chunks: Buffer[] = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.byteLength;
  const newline = chunk.indexOf(10);
  if (inputBytes > MAX_STDIN_BYTES + (newline >= 0 ? 1 : 0)) {
    throw new Error("memory vector KNN child input is too large");
  }
  chunks.push(chunk);
  if (newline < 0) {
    continue;
  }
  // The parent sends one request at a time; coalesced frames violate that contract.
  if (newline !== chunk.length - 1) {
    throw new Error("invalid memory vector KNN child framing");
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  chunks.length = 0;
  inputBytes = 0;
  if (!isChildInput(input)) {
    throw new Error("invalid memory vector KNN child input");
  }
  try {
    // Reopen for each query so publication and path replacement stay visible.
    writeResult(input.id, await run(input));
  } catch (error) {
    writeResult(input.id, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
