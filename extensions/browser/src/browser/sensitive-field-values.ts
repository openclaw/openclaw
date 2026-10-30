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
