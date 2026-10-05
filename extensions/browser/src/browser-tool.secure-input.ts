import crypto from "node:crypto";
import { domainToASCII } from "node:url";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserProxyRequest } from "./browser-node-proxy.js";
import {
  browserAct,
  browserSnapshot,
  browserTabs,
  normalizeOptionalString,
  readStringValue,
} from "./browser-tool.runtime.js";
import { getDocumentIdentitiesViaCdp } from "./browser/cdp.js";
import type { SnapshotAriaNode } from "./browser/client.types.js";

export const SECURE_INPUT_REDACTION_PLACEHOLDER = "••••••(redacted)";
export const DEFAULT_SECURE_INPUT_REQUEST_TTL_MS = 5 * 60_000;

export const BROWSER_SECURE_INPUT_FIELD_ROLES = ["username", "password", "otp", "email"] as const;

export type SecureInputFieldRole = (typeof BROWSER_SECURE_INPUT_FIELD_ROLES)[number];

export type SecureInputLoginHint = {
  fieldRoles: SecureInputFieldRole[];
};

export type SecureInputRequest = {
  requestId: string;
  tabId: string;
  documentId: string;
  origin: string;
  fields: Array<{ fieldId: string; role: SecureInputFieldRole }>;
  expiresAt: string;
};

export type SecureInputTabState = {
  tabId: string;
  documentId: string;
  origin: string;
  url: string;
};

export type SecureInputFailureReason = "page_changed" | "expired" | "not_found";

export type SecureInputFulfillmentResult =
  | { filled: true }
  | { filled: false; reason: SecureInputFailureReason };

export type SecureInputFieldAnswerMap = Record<string, string>;

export type DomFieldCandidate = {
  domFieldId: string;
  role: SecureInputFieldRole;
};

export interface DomFieldInspector {
  inspectFields(params: {
    tabId: string;
    loginHint: SecureInputLoginHint;
  }): Promise<{ tab: SecureInputTabState; candidates: DomFieldCandidate[] }>;
  fillFields(params: {
    tab: SecureInputTabState;
    fields: Array<{ domFieldId: string; value: string }>;
  }): Promise<{ filled: boolean }>;
  readCurrentFieldValues(params: {
    tab: SecureInputTabState;
    domFieldIds: string[];
  }): Promise<Map<string, string>>;
}

type PendingSecureInputRequest = SecureInputRequest & {
  pending: true;
  fieldBindings: Map<string, { domFieldId: string; role: SecureInputFieldRole }>;
};

type FulfilledSecureInputField = {
  fieldId: string;
  domFieldId: string;
  role: SecureInputFieldRole;
  documentId: string;
};

type SecureInputRegistry = {
  pendingByRequestId: Map<string, PendingSecureInputRequest>;
  pendingByTabId: Map<string, string>;
  fulfilledByTabId: Map<string, FulfilledSecureInputField[]>;
};

const secureInputRegistry: SecureInputRegistry = {
  pendingByRequestId: new Map(),
  pendingByTabId: new Map(),
  fulfilledByTabId: new Map(),
};

function normalizeRequestedRoles(loginHint: SecureInputLoginHint): SecureInputFieldRole[] {
  const roles = Array.isArray(loginHint.fieldRoles) ? loginHint.fieldRoles : [];
  const unique = new Set<SecureInputFieldRole>();
  for (const role of roles) {
    if (role === "username" || role === "password" || role === "otp" || role === "email") {
      unique.add(role);
    }
  }
  return [...unique];
}

function cleanupPendingRequest(requestId: string) {
  const request = secureInputRegistry.pendingByRequestId.get(requestId);
  if (!request) {
    return undefined;
  }
  secureInputRegistry.pendingByRequestId.delete(requestId);
  if (secureInputRegistry.pendingByTabId.get(request.tabId) === requestId) {
    secureInputRegistry.pendingByTabId.delete(request.tabId);
  }
  return request;
}

function hashFallbackDocumentIdentity(url: string, nodes: SnapshotAriaNode[]): string {
  return `snapshot:${crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        url,
        nodes: nodes.map((node) => ({
          ref: node.ref,
          role: node.role,
          name: node.name,
          value: node.value,
          description: node.description,
        })),
      }),
    )
    .digest("hex")}`;
}

function normalizeTabOrigin(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Secure input requires a live tab URL.");
  }
  const protocol = parsed.protocol.toLowerCase();
  const hostname = domainToASCII(parsed.hostname).toLowerCase();
  if (!hostname) {
    throw new Error("Secure input requires a live tab origin.");
  }
  const host = parsed.port ? `${hostname}:${parsed.port}` : hostname;
  return `${protocol}//${host}`;
}

function matchTabReference(tab: Record<string, unknown>, requestedTabId: string): boolean {
  return [tab.targetId, tab.suggestedTargetId, tab.tabId, tab.label].some(
    (candidate) => readStringValue(candidate) === requestedTabId,
  );
}

function candidateLabel(node: SnapshotAriaNode): string {
  return `${node.name ?? ""} ${node.description ?? ""}`.toLowerCase();
}

function inferFieldRoles(node: SnapshotAriaNode): Set<SecureInputFieldRole> {
  const roles = new Set<SecureInputFieldRole>();
  const role = String(node.role ?? "").toLowerCase();
  if (!["textbox", "searchbox", "combobox", "input"].includes(role)) {
    return roles;
  }
  const label = candidateLabel(node);
  if (/\bpassword|passcode|secret\b/.test(label)) {
    roles.add("password");
  }
  if (/\bemail|e-mail\b/.test(label)) {
    roles.add("email");
  }
  if (/\botp\b|\bone[-\s]*time\b|\bverification\b|\b2fa\b|\bcode\b/.test(label)) {
    roles.add("otp");
  }
  if (/\buser(name)?\b|\blogin\b|\bsign[-\s]*in\b|\baccount\b/.test(label)) {
    roles.add("username");
  }
  if (roles.has("email")) {
    roles.add("username");
  }
  return roles;
}

function selectCandidateFields(
  nodes: SnapshotAriaNode[],
  requestedRoles: SecureInputFieldRole[],
): DomFieldCandidate[] {
  const selected: DomFieldCandidate[] = [];
  const usedRefs = new Set<string>();
  for (const requestedRole of requestedRoles) {
    const node = nodes.find((candidate) => {
      const ref = normalizeOptionalString(candidate.ref);
      return Boolean(ref) && !usedRefs.has(ref!) && inferFieldRoles(candidate).has(requestedRole);
    });
    const ref = normalizeOptionalString(node?.ref);
    if (!ref) {
      continue;
    }
    usedRefs.add(ref);
    selected.push({ domFieldId: ref, role: requestedRole });
  }
  return selected;
}

function readTabSnapshotNodes(snapshot: unknown): SnapshotAriaNode[] {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    (snapshot as { format?: unknown }).format !== "aria"
  ) {
    throw new Error("Secure input inspection requires an ARIA snapshot.");
  }
  return Array.isArray((snapshot as { nodes?: unknown[] }).nodes)
    ? ((snapshot as { nodes: SnapshotAriaNode[] }).nodes ?? [])
    : [];
}

async function buildLiveTabState(params: {
  tabId: string;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  signal?: AbortSignal;
}) {
  const tabs = await browserTabs(params.proxyRequest ?? params.baseUrl, {
    profile: params.profile,
    signal: params.signal,
  });
  const tab = tabs.tabs.find(
    (candidate) =>
      candidate && typeof candidate === "object" && matchTabReference(candidate, params.tabId),
  ) as Record<string, unknown> | undefined;
  if (!tab) {
    throw new Error(`Tab ${JSON.stringify(params.tabId)} was not found.`);
  }
  const canonicalTabId =
    readStringValue(tab.targetId) ??
    readStringValue(tab.suggestedTargetId) ??
    readStringValue(tab.tabId) ??
    params.tabId;
  const url = readStringValue(tab.url);
  if (!url) {
    throw new Error("Secure input requires a tab with a readable current URL.");
  }
  const snapshot = await browserSnapshot(params.proxyRequest ?? params.baseUrl, {
    targetId: canonicalTabId,
    format: "aria",
    profile: params.profile,
    signal: params.signal,
  });
  const nodes = readTabSnapshotNodes(snapshot);
  const wsUrl = readStringValue(tab.wsUrl);
  const documentId = wsUrl
    ? ((await getDocumentIdentitiesViaCdp({ wsUrl, timeoutMs: 5_000 })
        .then((identities) => identities.mainFrame)
        .catch(() => undefined)) ?? hashFallbackDocumentIdentity(url, nodes))
    : hashFallbackDocumentIdentity(url, nodes);
  return {
    tab: {
      tabId: canonicalTabId,
      url,
      origin: normalizeTabOrigin(url),
      documentId,
    } satisfies SecureInputTabState,
    nodes,
  };
}

export async function readBrowserSecureInputTabState(params: {
  tabId: string;
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  signal?: AbortSignal;
}): Promise<SecureInputTabState> {
  return (await buildLiveTabState(params)).tab;
}

export function createBrowserDomFieldInspector(params: {
  baseUrl?: string;
  profile?: string;
  proxyRequest: BrowserProxyRequest | null;
  signal?: AbortSignal;
}): DomFieldInspector {
  return {
    inspectFields: async ({ tabId, loginHint }) => {
      const requestedRoles = normalizeRequestedRoles(loginHint);
      if (requestedRoles.length === 0) {
        throw new Error("requestSecureInput requires at least one field role.");
      }
      const { tab, nodes } = await buildLiveTabState({ ...params, tabId });
      const candidates = selectCandidateFields(nodes, requestedRoles);
      if (candidates.length === 0) {
        throw new Error("No secure-input field candidates were found on the current tab.");
      }
      return { tab, candidates };
    },
    fillFields: async ({ tab, fields }) => {
      const filledFields = fields.map(({ domFieldId, value }) => ({
        ref: domFieldId,
        type: "text",
        value,
      }));
      await browserAct(
        params.proxyRequest ?? params.baseUrl,
        {
          kind: "fill",
          targetId: tab.tabId,
          fields: filledFields,
        },
        {
          profile: params.profile,
          signal: params.signal,
        },
      );
      // Phase 1 intentionally stops after filling verified fields; form submit
      // stays a separate, explicit step with its own origin check.
      return { filled: true };
    },
    readCurrentFieldValues: async ({ tab, domFieldIds }) => {
      const { nodes } = await buildLiveTabState({ ...params, tabId: tab.tabId });
      const allowed = new Set(domFieldIds);
      const values = new Map<string, string>();
      for (const node of nodes) {
        const ref = normalizeOptionalString(node.ref);
        if (!ref || !allowed.has(ref)) {
          continue;
        }
        const value =
          typeof node.value === "string"
            ? node.value
            : typeof node.value === "number" || typeof node.value === "boolean"
              ? String(node.value)
              : undefined;
        if (value) {
          values.set(ref, value);
        }
      }
      return values;
    },
  };
}

export function resetSecureInputRegistryForTests() {
  secureInputRegistry.pendingByRequestId.clear();
  secureInputRegistry.pendingByTabId.clear();
  secureInputRegistry.fulfilledByTabId.clear();
}

export function hasSecureInputRedactions(tabId: string): boolean {
  return (secureInputRegistry.fulfilledByTabId.get(tabId) ?? []).length > 0;
}

export async function resolveSecureInputRequest(
  tab: { tabId: string },
  loginHint: SecureInputLoginHint,
  params: {
    inspector: DomFieldInspector;
    now?: number;
    timeoutMs?: number;
  },
): Promise<SecureInputRequest> {
  const now = params.now ?? Date.now();
  const existingRequestId = secureInputRegistry.pendingByTabId.get(tab.tabId);
  if (existingRequestId) {
    const existing = secureInputRegistry.pendingByRequestId.get(existingRequestId);
    if (existing) {
      if (Date.parse(existing.expiresAt) > now) {
        throw new Error(
          `A secure-input request is already pending for tab ${JSON.stringify(tab.tabId)}.`,
        );
      }
      cleanupPendingRequest(existingRequestId);
    }
  }

  const inspected = await params.inspector.inspectFields({ tabId: tab.tabId, loginHint });
  const expiresAtMs =
    now + Math.max(1_000, params.timeoutMs ?? DEFAULT_SECURE_INPUT_REQUEST_TTL_MS);
  const requestId = crypto.randomUUID();
  const fieldBindings = new Map<string, { domFieldId: string; role: SecureInputFieldRole }>();
  const fields = inspected.candidates.map(({ domFieldId, role }) => {
    const fieldId = crypto.randomUUID();
    fieldBindings.set(fieldId, { domFieldId, role });
    return { fieldId, role };
  });
  const request: PendingSecureInputRequest = {
    requestId,
    tabId: inspected.tab.tabId,
    documentId: inspected.tab.documentId,
    origin: inspected.tab.origin,
    fields,
    expiresAt: new Date(expiresAtMs).toISOString(),
    pending: true,
    fieldBindings,
  };
  secureInputRegistry.pendingByRequestId.set(requestId, request);
  secureInputRegistry.pendingByTabId.set(request.tabId, requestId);
  return request;
}

export function cancelSecureInputRequest(requestId: string): boolean {
  return Boolean(cleanupPendingRequest(requestId));
}

function recordFulfilledSecureInputFields(request: PendingSecureInputRequest) {
  const fulfilled = secureInputRegistry.fulfilledByTabId.get(request.tabId) ?? [];
  fulfilled.push(
    ...request.fields
      .map((field) => {
        const binding = request.fieldBindings.get(field.fieldId);
        return binding
          ? {
              fieldId: field.fieldId,
              domFieldId: binding.domFieldId,
              role: field.role,
              documentId: request.documentId,
            }
          : undefined;
      })
      .filter((field): field is FulfilledSecureInputField => field !== undefined),
  );
  secureInputRegistry.fulfilledByTabId.set(request.tabId, fulfilled);
}

export async function fulfillSecureInputRequest(
  requestId: string,
  answers: SecureInputFieldAnswerMap,
  currentTabState: SecureInputTabState,
  params: {
    inspector: DomFieldInspector;
    now?: number;
  },
): Promise<SecureInputFulfillmentResult> {
  const now = params.now ?? Date.now();
  const request = secureInputRegistry.pendingByRequestId.get(requestId);
  if (!request) {
    return { filled: false, reason: "not_found" };
  }
  if (Date.parse(request.expiresAt) <= now) {
    cleanupPendingRequest(requestId);
    return { filled: false, reason: "expired" };
  }
  if (
    request.tabId !== currentTabState.tabId ||
    request.documentId !== currentTabState.documentId ||
    request.origin !== currentTabState.origin
  ) {
    cleanupPendingRequest(requestId);
    return { filled: false, reason: "page_changed" };
  }

  const fieldsToFill = request.fields.flatMap((field) => {
    const binding = request.fieldBindings.get(field.fieldId);
    const value = answers[field.fieldId];
    return binding && typeof value === "string" ? [{ domFieldId: binding.domFieldId, value }] : [];
  });
  cleanupPendingRequest(requestId);
  if (fieldsToFill.length === 0) {
    return { filled: false, reason: "not_found" };
  }

  try {
    const result = await params.inspector.fillFields({
      tab: currentTabState,
      fields: fieldsToFill,
    });
    if (result.filled) {
      recordFulfilledSecureInputFields(request);
      return { filled: true };
    }
    return { filled: false, reason: "not_found" };
  } finally {
    for (const field of fieldsToFill) {
      field.value = "";
    }
    for (const key of Object.keys(answers)) {
      answers[key] = "";
      delete answers[key];
    }
  }
}

function replaceRedactedValues(text: string, currentValues: Iterable<string>): string {
  let redacted = text;
  for (const value of [...currentValues]
    .filter(Boolean)
    .toSorted((left, right) => right.length - left.length)) {
    redacted = redacted.split(value).join(SECURE_INPUT_REDACTION_PLACEHOLDER);
  }
  return redacted;
}

function redactSnapshotLineByRef(snapshot: string, ref: string): string {
  const linePattern = new RegExp(
    `^(.*\\[ref=${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\].*)$`,
    "gm",
  );
  return snapshot.replace(linePattern, (line) => {
    const maskedValue = line.replace(
      / value=(?:"(?:\\.|[^"\\])*"|[^\s\]]+)/g,
      ` value=${JSON.stringify(SECURE_INPUT_REDACTION_PLACEHOLDER)}`,
    );
    return maskedValue.replace(/ description=(?:"(?:\\.|[^"\\])*"|[^\s\]]+)/g, (segment) =>
      segment.includes(SECURE_INPUT_REDACTION_PLACEHOLDER) ? segment : segment,
    );
  });
}

function redactStructuredStrings(value: unknown, currentValues: readonly string[]): unknown {
  if (typeof value === "string") {
    return replaceRedactedValues(value, currentValues);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactStructuredStrings(entry, currentValues));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactStructuredStrings(entry, currentValues),
    ]),
  );
}

async function readRedactionContext(
  tab: SecureInputTabState,
  inspector: DomFieldInspector,
): Promise<{
  fields: FulfilledSecureInputField[];
  currentValues: string[];
}> {
  const fulfilled = (secureInputRegistry.fulfilledByTabId.get(tab.tabId) ?? []).filter(
    (field) => field.documentId === tab.documentId,
  );
  if (fulfilled.length === 0) {
    return { fields: [], currentValues: [] };
  }
  const currentValues = await inspector.readCurrentFieldValues({
    tab,
    domFieldIds: fulfilled.map((field) => field.domFieldId),
  });
  return {
    fields: fulfilled,
    currentValues: [...currentValues.values()],
  };
}

export async function redactSecureInputSnapshotResult<
  T extends {
    format: "ai" | "aria";
    snapshot?: string;
    nodes?: SnapshotAriaNode[];
  },
>(
  snapshot: T,
  params: {
    tab: SecureInputTabState;
    inspector: DomFieldInspector;
  },
): Promise<T> {
  const context = await readRedactionContext(params.tab, params.inspector);
  if (context.fields.length === 0) {
    return snapshot;
  }
  const redactedRefs = new Set(context.fields.map((field) => field.domFieldId));
  if (snapshot.format === "aria") {
    return {
      ...snapshot,
      nodes: (snapshot.nodes ?? []).map((node) =>
        redactedRefs.has(node.ref)
          ? {
              ...node,
              value: SECURE_INPUT_REDACTION_PLACEHOLDER,
              description:
                typeof node.description === "string"
                  ? replaceRedactedValues(node.description, context.currentValues)
                  : node.description,
            }
          : {
              ...node,
              ...(typeof node.description === "string"
                ? { description: replaceRedactedValues(node.description, context.currentValues) }
                : {}),
            },
      ),
    };
  }
  let redactedSnapshot = snapshot.snapshot ?? "";
  for (const field of context.fields) {
    redactedSnapshot = redactSnapshotLineByRef(redactedSnapshot, field.domFieldId);
  }
  redactedSnapshot = replaceRedactedValues(redactedSnapshot, context.currentValues);
  return { ...snapshot, snapshot: redactedSnapshot };
}

export async function redactSecureInputToolPayload<T>(
  payload: T,
  params: {
    tab: SecureInputTabState;
    inspector: DomFieldInspector;
  },
): Promise<T> {
  const context = await readRedactionContext(params.tab, params.inspector);
  if (context.fields.length === 0 || context.currentValues.length === 0) {
    return payload;
  }
  return redactStructuredStrings(payload, context.currentValues) as T;
}

export function readSecureInputLoginHint(input: Record<string, unknown>): SecureInputLoginHint {
  if ("selector" in input || "origin" in input) {
    throw new Error(
      "requestSecureInput accepts structural hints only; selectors and origin are derived from the live tab.",
    );
  }
  const raw = input.loginHint;
  if (!isRecord(raw) || !Array.isArray(raw.fieldRoles)) {
    throw new Error("requestSecureInput requires loginHint.fieldRoles.");
  }
  const fieldRoles = normalizeRequestedRoles({
    fieldRoles: raw.fieldRoles as SecureInputFieldRole[],
  });
  if (fieldRoles.length === 0) {
    throw new Error("requestSecureInput requires at least one supported field role.");
  }
  return { fieldRoles };
}
