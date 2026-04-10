import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

type JenniBridgeFields = {
  dbId?: string;
  jobId?: string;
  status?: string;
  log?: string;
};

const JENNI_BRIDGE_LINE_RE = /^(DB_ID|JOB_ID|STATUS|LOG)=(.*)$/;

function parseJenniBridgeFields(text: string): JenniBridgeFields {
  const fields: JenniBridgeFields = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = JENNI_BRIDGE_LINE_RE.exec(line);
    if (!match) {
      continue;
    }
    const [, key, value] = match;
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      continue;
    }
    if (key === "DB_ID") {
      fields.dbId = trimmedValue;
    } else if (key === "JOB_ID") {
      fields.jobId = trimmedValue;
    } else if (key === "STATUS") {
      fields.status = trimmedValue;
    } else if (key === "LOG") {
      fields.log = trimmedValue;
    }
  }
  return fields;
}

export function formatJenniBridgeExecOutput(text: string): string | null {
  const fields = parseJenniBridgeFields(text);
  if (!fields.dbId || !fields.jobId || !fields.status) {
    return null;
  }

  const status = normalizeLowercaseStringOrEmpty(fields.status);
  const lines = [
    status === "success" ? "Jenni Admin job completed." : "Jenni Admin job finished.",
    `DB ID: ${fields.dbId}`,
    `Job ID: ${fields.jobId}`,
    `Status: ${fields.status}`,
  ];

  if (fields.log) {
    lines.push(`${status === "success" ? "Log" : "Output"}: ${fields.log}`);
  }

  return lines.join("\n");
}
