import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  isValidPluginExternalActionEvidenceRegistration,
  type PluginExternalActionEvidenceRegistration,
} from "../plugins/host-hooks.js";

export type ExternalActionEvidence = {
  actionFamily: string;
  toolName?: string;
  providerId?: string;
  status?: string;
  sender?: string;
  recipient?: string;
  bodyHash?: string;
  dryRun?: boolean;
};

export type ExternalActionEvidenceDeclaration = PluginExternalActionEvidenceRegistration;

const SUCCESS_STATUSES = new Set(["accepted", "queued", "accepted/queued", "sent", "delivered"]);

function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const record = asOptionalRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[part];
  }
  return current;
}

function readFirstString(value: unknown, paths: readonly string[] | undefined): string | undefined {
  for (const path of paths ?? []) {
    const text = normalizeOptionalString(readPath(value, path));
    if (text) {
      return text;
    }
  }
  return undefined;
}

function readFirstStringified(
  value: unknown,
  paths: readonly string[] | undefined,
): string | undefined {
  for (const path of paths ?? []) {
    const text = normalizeStringifiedOptionalString(readPath(value, path));
    if (text) {
      return text;
    }
  }
  return undefined;
}

function readFirstBoolean(value: unknown, paths: readonly string[] | undefined): boolean {
  for (const path of paths ?? []) {
    const raw = readPath(value, path);
    if (raw === true) {
      return true;
    }
    if (typeof raw === "string" && raw.trim().toLowerCase() === "true") {
      return true;
    }
  }
  return false;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export const isValidExternalActionEvidenceDeclaration =
  isValidPluginExternalActionEvidenceRegistration;

export function normalizeExternalActionEvidence(params: {
  declaration: ExternalActionEvidenceDeclaration;
  toolName?: string;
  result: unknown;
}): ExternalActionEvidence | null {
  if (!isValidExternalActionEvidenceDeclaration(params.declaration)) {
    return null;
  }
  const actionFamily = normalizeOptionalString(params.declaration.actionFamily);
  if (!actionFamily) {
    return null;
  }
  const status = readFirstString(params.result, params.declaration.successStatusPaths);
  const providerId = readFirstStringified(params.result, params.declaration.providerIdPaths);
  const dryRun = readFirstBoolean(params.result, params.declaration.dryRunPaths);
  const normalizedStatus = status?.toLowerCase();
  if (normalizedStatus && !SUCCESS_STATUSES.has(normalizedStatus)) {
    return null;
  }
  if (dryRun || (!providerId && (!normalizedStatus || !SUCCESS_STATUSES.has(normalizedStatus)))) {
    return null;
  }
  const body = readFirstString(params.result, params.declaration.bodyPaths);
  const sender = readFirstString(params.result, params.declaration.senderPaths);
  const recipient = readFirstString(params.result, params.declaration.recipientPaths);
  return {
    actionFamily: actionFamily.toLowerCase(),
    ...(params.toolName ? { toolName: params.toolName } : {}),
    ...(providerId ? { providerId } : {}),
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
    ...(body ? { bodyHash: hashBody(body) } : {}),
  };
}
