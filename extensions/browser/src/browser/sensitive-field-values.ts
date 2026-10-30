import { axValue, type CdpProtocolSend, type RawAXNode } from "./cdp-ax.js";

// Snapshots are model-facing. Credential and payment field values stay out of them,
// however the page filled the field (typed, scripted, or browser autofill).

export const REDACTED_FIELD_VALUE = "[redacted]";

/** Roles whose snapshot entries can carry a form field value. */
export const VALUE_FIELD_ROLES: ReadonlySet<string> = new Set([
  "combobox",
  "searchbox",
  "spinbutton",
  "textbox",
]);

// WHATWG autofill field names whose values are credentials or payment secrets.
const SENSITIVE_AUTOCOMPLETE_TOKENS: ReadonlySet<string> = new Set([
  "cc-csc",
  "cc-number",
  "current-password",
  "new-password",
  "one-time-code",
]);

/** Field attributes read from the page; `type` and `autocomplete` are raw attribute values. */
export type FieldDescriptor = {
  tagName: string;
  type?: string | null;
  autocomplete?: string | null;
};

type SnapshotValueNode = {
  role?: string;
  name?: string;
  value?: string | number | boolean;
  children?: SnapshotValueNode[];
};

export function parseFieldDescriptor(value: unknown): FieldDescriptor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { tagName, type, autocomplete } = record;
  if (
    typeof tagName !== "string" ||
    (typeof type !== "string" && type !== null) ||
    (typeof autocomplete !== "string" && autocomplete !== null)
  ) {
    return null;
  }
  return { tagName, type, autocomplete };
}

export function isSensitiveFieldDescriptor(field: FieldDescriptor): boolean {
  if (field.tagName.toLowerCase() === "input" && field.type?.toLowerCase() === "password") {
    return true;
  }
  // Section, billing/shipping, and contact tokens may precede the field name.
  return (field.autocomplete ?? "")
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token));
}

/** Return valued form fields from a structured snapshot in snapshot order. */
export function findValuedSnapshotFields<T extends SnapshotValueNode>(root: T): T[] {
  const fields: T[] = [];
  const pending = [root];
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (
      node.value !== undefined &&
      String(node.value).trim() &&
      VALUE_FIELD_ROLES.has(node.role?.trim().toLowerCase() ?? "")
    ) {
      fields.push(node);
    }
    for (const child of node.children?.toReversed() ?? []) {
      pending.push(child as T);
    }
  }
  return fields;
}

/** Mask a structured snapshot field value and accessibility text descendants. */
export function redactSnapshotFieldValue(field: SnapshotValueNode): void {
  const pending = [field];
  const seen = new Set<SnapshotValueNode>();
  for (let node = pending.pop(); node; node = pending.pop()) {
    if (seen.has(node)) {
      continue;
    }
    seen.add(node);
    if (node.value !== undefined && String(node.value).trim()) {
      node.value = REDACTED_FIELD_VALUE;
    }
    if (node !== field && node.name?.trim()) {
      node.name = REDACTED_FIELD_VALUE;
    }
    for (const child of node.children ?? []) {
      pending.push(child);
    }
  }
}

async function describeFieldViaCdp(
  send: CdpProtocolSend,
  backendNodeId: number,
): Promise<FieldDescriptor | null> {
  // SAFETY: DOM.describeNode returns the native node name and alternating string attributes.
  const described = (await send("DOM.describeNode", { backendNodeId }).catch(() => null)) as {
    node?: { nodeName?: string; attributes?: string[] };
  } | null;
  const node = described?.node;
  if (!node?.nodeName) {
    return null;
  }
  const attributes = node.attributes ?? [];
  const attribute = (name: string) => {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index]!.toLowerCase() === name) {
        return attributes[index + 1];
      }
    }
    return undefined;
  };
  return {
    tagName: node.nodeName,
    type: attribute("type"),
    autocomplete: attribute("autocomplete"),
  };
}

/**
 * Mask sensitive field values in captured AX nodes before any snapshot format renders them.
 * Chromium masks type=password values but not one-time-code or card fields, and full trees
 * repeat the value as StaticText/InlineTextBox descendants. A valued field whose DOM node
 * cannot be described is masked.
 */
export async function redactSensitiveAXNodeValues(
  send: CdpProtocolSend,
  nodes: RawAXNode[],
): Promise<void> {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const redact = (node: RawAXNode) => {
    const pending = [node];
    const seen = new Set<RawAXNode>();
    for (let current = pending.pop(); current; current = pending.pop()) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      if (axValue(current.value)) {
        current.value = { value: REDACTED_FIELD_VALUE };
      }
      if (current !== node && axValue(current.name)) {
        current.name = { value: REDACTED_FIELD_VALUE };
      }
      for (const childId of current.childIds ?? []) {
        const child = byId.get(childId);
        if (child) {
          pending.push(child);
        }
      }
    }
  };
  await Promise.all(
    nodes
      .filter(
        (node) => axValue(node.value) && VALUE_FIELD_ROLES.has(axValue(node.role).toLowerCase()),
      )
      .map(async (node) => {
        const field = node.backendDOMNodeId
          ? await describeFieldViaCdp(send, node.backendDOMNodeId)
          : null;
        if (!field || isSensitiveFieldDescriptor(field)) {
          redact(node);
        }
      }),
  );
}
