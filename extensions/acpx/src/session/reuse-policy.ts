import path from "node:path";
import type { SessionRecord } from "../runtime-types.js";

export function shouldReuseExistingRecord(
  record: Pick<SessionRecord, "cwd" | "agentCommand" | "acpSessionId">,
  params: {
    cwd: string;
    agentCommand: string;
    resumeSessionId?: string;
  },
): boolean {
  if (path.resolve(record.cwd) !== path.resolve(params.cwd)) {
    return false;
  }
  if (record.agentCommand !== params.agentCommand) {
    return false;
  }
  if (params.resumeSessionId && record.acpSessionId !== params.resumeSessionId) {
    return false;
  }
  return true;
}
