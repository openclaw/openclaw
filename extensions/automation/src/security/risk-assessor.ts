export type SecurityLevel = "read" | "write" | "dangerous" | "critical";

const CRITICAL_PATTERNS = [
  /deploy.*prod/i, /production/i, /rm\s+-rf/i, /drop\s+table/i,
  /force.push/i, /delete.*branch/i, /部署.*正式/i, /刪除.*資料庫/i,
];

const DANGEROUS_PATTERNS = [
  /git\s+push/i, /deploy/i, /delete/i, /rollback/i,
  /npm\s+publish/i, /推送/i, /部署/i, /刪除/i, /回滾/i,
];

const WRITE_PATTERNS = [
  /commit/i, /merge/i, /install/i, /update/i, /modify/i, /edit/i,
  /refactor/i, /create/i, /build/i, /提交/i, /合併/i, /修改/i,
  /重構/i, /建立/i, /安裝/i,
];

export function assessRisk(message: string): SecurityLevel {
  if (CRITICAL_PATTERNS.some((p) => p.test(message))) return "critical";
  if (DANGEROUS_PATTERNS.some((p) => p.test(message))) return "dangerous";
  if (WRITE_PATTERNS.some((p) => p.test(message))) return "write";
  return "read";
}

export function requiresConfirmation(level: SecurityLevel): boolean {
  return level === "dangerous" || level === "critical";
}

export function requiresBiometric(level: SecurityLevel): boolean {
  return level === "critical";
}
