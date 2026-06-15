import type { ResultSetHeader } from "mysql2/promise";
import { detectPlatform } from "./detect-platform.js";
import { withWriteTransaction } from "./mysql-client.js";
import type { MySqlConfig } from "./types.js";

export interface CreateCaseInput {
  /** Trusted userId of the creating agent → infringement_case.uid. */
  uid: number;
  /** Owner group (0 when unknown; PHP falls back to 0 too). */
  groupId: number;
  reporter?: string;
  target?: string;
  enterpriseType?: string;
  /** Pre-parsed, non-empty link lines (≥1). */
  links: string[];
}

export interface CreatedCase {
  caseId: number;
  caseNo: string;
  linkCount: number;
  mode: "single" | "cluster";
}

const CASE_NO_MAX_ATTEMPTS = 5;

/** WXB-{year}-{4-digit 1..9999}, matching InfringementController::genCaseNo. */
function genCaseNo(): string {
  const year = new Date().getFullYear();
  const n = 1 + Math.floor(Math.random() * 9999);
  return `WXB-${year}-${String(n).padStart(4, "0")}`;
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ER_DUP_ENTRY"
  );
}

/**
 * Create a case, insert its links, and mark it analyzing — all in one
 * transaction, mirroring InfringementController::analyzeAction's create path.
 * The caller dispatches the returned caseId to the Java TaskWorker queue AFTER
 * this commits (never inside the transaction).
 *
 * case_no is random (non-unique by design in PHP); we still retry on a unique
 * collision in case the column carries a constraint.
 */
export async function createCaseWithLinks(
  config: MySqlConfig,
  input: CreateCaseInput,
): Promise<CreatedCase> {
  const now = Math.floor(Date.now() / 1000);

  return withWriteTransaction(config, async (conn) => {
    let caseId = 0;
    let caseNo = "";
    for (let attempt = 0; attempt < CASE_NO_MAX_ATTEMPTS; attempt++) {
      caseNo = genCaseNo();
      try {
        const [res] = await conn.execute<ResultSetHeader>(
          "INSERT INTO infringement_case " +
            "(case_no, uid, groupId, reporter, enterprise_type, target, status, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
          [
            caseNo,
            input.uid,
            input.groupId,
            input.reporter ?? "",
            input.enterpriseType ?? "",
            input.target ?? "",
            now,
            now,
          ],
        );
        caseId = res.insertId;
        break;
      } catch (error) {
        if (isDuplicateEntry(error) && attempt < CASE_NO_MAX_ATTEMPTS - 1) {
          continue;
        }
        throw error;
      }
    }

    for (const url of input.links) {
      await conn.execute(
        "INSERT INTO infringement_link " +
          "(case_id, url, title, platform, account, analyze_status, score, status, created_at, updated_at) " +
          "VALUES (?, ?, '', ?, '', 'pending', -1, 1, ?, ?)",
        [caseId, url, detectPlatform(url), now, now],
      );
    }

    const linkCount = input.links.length;
    const mode: "single" | "cluster" = linkCount >= 2 ? "cluster" : "single";
    await conn.execute(
      "UPDATE infringement_case SET stage = 'analyzing', link_count = ?, analyze_mode = ?, progress = 0, updated_at = ? WHERE id = ?",
      [linkCount, mode, now, caseId],
    );

    return { caseId, caseNo, linkCount, mode };
  });
}
