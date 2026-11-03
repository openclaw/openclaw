import { describe, expect, it } from "vitest";
import type { CdpProtocolSend, RawAXNode } from "./cdp-ax.js";
import { REDACTED_FIELD_VALUE, redactSensitiveAXNodeValues } from "./sensitive-field-values.js";

function axNode(
  nodeId: string,
  role: string,
  fields: { name?: string; value?: string; backendDOMNodeId?: number; childIds?: string[] },
): RawAXNode {
  return {
    nodeId,
    role: { value: role },
    ...(fields.name ? { name: { value: fields.name } } : {}),
    ...(fields.value ? { value: { value: fields.value } } : {}),
    ...(fields.backendDOMNodeId ? { backendDOMNodeId: fields.backendDOMNodeId } : {}),
    ...(fields.childIds ? { childIds: fields.childIds } : {}),
  };
}

describe("redactSensitiveAXNodeValues", () => {
  it("masks credential, payment, and undescribable field values with their text descendants", async () => {
    const elements: Record<number, string[]> = {
      1: ["type", "email", "autocomplete", "username"],
      2: ["autocomplete", "section-pay billing CC-NUMBER"],
      3: ["id", "pw", "TYPE", "Password"],
      4: ["autocomplete", "one-time-code"],
      5: ["type", "password"],
    };
    const send = (async (method: string, params?: { backendNodeId?: number }) => {
      expect(method).toBe("DOM.describeNode");
      const attributes = elements[params?.backendNodeId ?? 0];
      if (!attributes) {
        throw new Error("No node with given id found");
      }
      return { node: { nodeName: params?.backendNodeId === 5 ? "TEXTAREA" : "INPUT", attributes } };
    }) as CdpProtocolSend;
    const nodes = [
      axNode("email", "textbox", {
        name: "Email",
        value: "a@example.test",
        backendDOMNodeId: 1,
        childIds: ["email-text"],
      }),
      axNode("email-text", "StaticText", { name: "a@example.test" }),
      axNode("card", "textbox", {
        name: "Card",
        value: "4242",
        backendDOMNodeId: 2,
        childIds: ["card-text"],
      }),
      axNode("card-text", "StaticText", { name: "4242", childIds: ["card-box"] }),
      axNode("card-box", "InlineTextBox", { name: "4242" }),
      axNode("password", "textbox", { name: "Password", value: "••••", backendDOMNodeId: 3 }),
      axNode("otp", "spinbutton", { name: "Code", value: "123456", backendDOMNodeId: 4 }),
      axNode("notes", "textbox", { name: "Notes", value: "pw", backendDOMNodeId: 5 }),
      axNode("detached", "searchbox", { name: "Search", value: "gone", backendDOMNodeId: 9 }),
      axNode("unbacked", "combobox", { name: "Pick", value: "orphan" }),
      axNode("slider", "slider", { name: "Volume", value: "7" }),
    ];
    await redactSensitiveAXNodeValues(send, nodes);
    expect(nodes.map((node) => [node.name?.value, node.value?.value])).toEqual([
      ["Email", "a@example.test"],
      ["a@example.test", undefined],
      ["Card", REDACTED_FIELD_VALUE],
      [REDACTED_FIELD_VALUE, undefined],
      [REDACTED_FIELD_VALUE, undefined],
      ["Password", REDACTED_FIELD_VALUE],
      ["Code", REDACTED_FIELD_VALUE],
      ["Notes", "pw"],
      ["Search", REDACTED_FIELD_VALUE],
      ["Pick", REDACTED_FIELD_VALUE],
      ["Volume", "7"],
    ]);
  });
});
