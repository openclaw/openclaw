import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { expect, test, vi } from "vitest";
import { resolveContentCapturePolicy } from "./service-content-normalization.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";

const MAX = 128 * 1024;

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return { ...actual, redactSensitiveText: vi.fn(actual.redactSensitiveText) };
});

function capture(inputMessages: unknown[]): (key: string) => string {
  const attributes: Record<string, string | number | boolean> = {};
  vi.mocked(redactSensitiveText).mockClear();
  assignOtelModelContentAttributes(
    attributes,
    { inputMessages },
    resolveContentCapturePolicy(true),
  );
  return (key) => String(attributes[key]);
}

const text = (role: string, value: string) => ({ role, content: [{ type: "text", text: value }] });

test("redacts each string of a large transcript once and masks it in every attribute (#158116)", () => {
  const secret = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"; // pragma: allowlist secret
  // Past 4x the budget, so every attribute walks several truncation budgets.
  const outputs = Array.from({ length: 40 }, (_, i) => `tool output ${i} ${"z".repeat(20_000)}`);
  const attr = capture([
    text("user", `deploy with key ${secret}`),
    ...outputs.map((output) => text("toolResult", output)),
  ]);

  const calls = vi.mocked(redactSensitiveText).mock.calls.map(([value]) => value);
  for (const output of outputs) {
    expect(calls.filter((value) => value === output)).toHaveLength(1);
  }
  expect(Math.max(...calls.map((value) => value.length))).toBeLessThanOrEqual(4 * MAX);
  for (const key of ["gen_ai.input.messages", "input.value", "openclaw.content.input_messages"]) {
    expect(attr(key).length).toBeLessThanOrEqual(MAX);
    expect(attr(key)).toContain("deploy with key sk-ant");
    expect(attr(key)).not.toContain(secret);
  }
  expect(attr("input.value")).toBe(attr("gen_ai.input.messages"));
});

test("exports a value whole when masking brings it under the attribute budget", () => {
  // Remains over the fallback string budget after masking, so early truncation
  // would lose content even though the redacted value fits the attribute budget.
  const prefix = `${"x".repeat(9_000)} `;
  const input = `${prefix}${`Bearer ${"a".repeat(128)} `.repeat(1_000)}`;
  const expected = `${prefix}${"Bearer aaaaaa…aaaa ".repeat(1_000)}`;

  const attr = capture([text("user", input)]);
  expect(JSON.parse(attr("gen_ai.input.messages"))[0].parts).toEqual([
    { type: "text", content: expected },
  ]);
});

test("drops image bytes too large to export whole and keeps smaller images", () => {
  const image = (data: string) => ({ type: "image", mimeType: "image/png", data });
  const attr = capture([
    { role: "user", content: [image("iVBORw0KGgo=")] },
    { role: "user", content: [image("A".repeat(MAX + 1))] },
  ]);
  const blob = { type: "blob", modality: "image", mime_type: "image/png" };
  expect(JSON.parse(attr("gen_ai.input.messages")).map((m: { parts: unknown }) => m.parts)).toEqual(
    [[{ ...blob, content: "iVBORw0KGgo=" }], [blob]],
  );
  expect(JSON.parse(attr("openclaw.content.input_messages"))).toEqual([
    { role: "user", content: [image("iVBORw0KGgo=")] },
    { role: "user", content: [{ type: "image", mimeType: "image/png" }] },
  ]);
});
