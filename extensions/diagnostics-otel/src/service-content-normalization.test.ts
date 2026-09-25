import { describe, expect, it, vi } from "vitest";

const redaction = vi.hoisted(() => ({ chars: 0 }));

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    redactSensitiveText: (...args: Parameters<typeof actual.redactSensitiveText>) => {
      redaction.chars += args[0].length;
      return actual.redactSensitiveText(...args);
    },
  };
});

import { MAX_OTEL_LOG_BODY_CHARS } from "./service-constants.js";
import {
  MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
  normalizeOtelLogString,
  resolveContentCapturePolicy,
} from "./service-content-normalization.js";
import {
  assignOtelModelContentAttributes,
  assignOtelToolContentAttributes,
} from "./service-genai-content.js";

const CAPTURE_ALL = resolveContentCapturePolicy(true);
const TRUNCATED_SUFFIX = "...(truncated)";
const REDACTION_LOOKAHEAD_CHARS = 4096;
// Built at runtime so the fixtures are not literal credentials.
const SECRET_BODY = "A1b2C3d4".repeat(4);
// This token rule needs 20 characters after its prefix, more than the JSON suffix leaves.
const SECRET_TOKEN = `glpat-${SECRET_BODY}`;
// Longer than the redaction lookahead, so the END line falls outside the redacted window.
const PRIVATE_KEY_BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(250);
// Quoted values longer than the lookahead, so a value opened before the cut closes past the
// redacted window. Spaces keep the unquoted assignment rules from masking the whole value.
const LONG_SECRET = `${SECRET_BODY} `.repeat(200);
const LONG_SECRET_WORD = SECRET_BODY.repeat(200);
// The AWS secret-key rule matches exactly 40 characters, so a cut inside one leaves no match.
const AWS_STYLE_SECRET = "Q1w2E3r4".repeat(5);
// Each masks to 11 characters, so together they shorten the redacted text by more than the lookahead.
const SHRINKING_TOKENS = Array.from({ length: 5 }, () => `sk-${SECRET_BODY.repeat(31)}`).join(" ");

function captureModelCall(inputMessages: unknown[]): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  assignOtelModelContentAttributes(attributes, { inputMessages }, CAPTURE_ALL);
  return attributes;
}

function toolResultTranscript(messages: number, parts: number, text: string): unknown[] {
  return Array.from({ length: messages }, (_, index) => ({
    role: "toolResult",
    toolCallId: `call-${index}`,
    content: Array.from({ length: parts }, () => ({ type: "text", text })),
  }));
}

function captureToolCall(content: {
  toolInput?: unknown;
  toolOutput?: unknown;
}): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  assignOtelToolContentAttributes(attributes, content, CAPTURE_ALL);
  return attributes;
}

function redactionCharsFor(run: () => unknown): number {
  redaction.chars = 0;
  run();
  return redaction.chars;
}

describe("OTEL content redaction cost", () => {
  // Input messages export as two JSON attributes. Each picks a budget whose clipped strings fill
  // at most 8x its size in redaction windows, then redacts its serialized JSON.
  const modelCallMaxWork = 2 * 9 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS;
  // Masks and quote probes can make a clipped string cost up to five windows.
  const maskedModelCallMaxWork = 2 * (5 * 8 + 1) * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS;
  // One window of 8,192 characters plus three quote probes under 512 characters each.
  const logBodyProbedMaxWork = 2 * MAX_OTEL_LOG_BODY_CHARS + 3 * 512;
  // Every fixture string is longer than the widest redaction window, so doubling it must not
  // change how much text reaches the redactor.

  it.each([
    {
      name: "a model call's large tool outputs",
      maxWork: modelCallMaxWork,
      capture: (scale: number) =>
        captureModelCall(toolResultTranscript(6, 1, "o".repeat(scale * 150_000))),
    },
    {
      name: "a model call with many tool output parts",
      maxWork: modelCallMaxWork,
      capture: (scale: number) =>
        captureModelCall(toolResultTranscript(200, 5, "o".repeat(scale * 15_000))),
    },
    {
      name: "a model call whose tool outputs are full of masked secrets",
      maxWork: maskedModelCallMaxWork,
      capture: (scale: number) =>
        captureModelCall(toolResultTranscript(200, 1, `${SECRET_TOKEN} `.repeat(scale * 1700))),
    },
    {
      name: "a log body",
      maxWork: 4 * MAX_OTEL_LOG_BODY_CHARS,
      capture: (scale: number) =>
        normalizeOtelLogString("o".repeat(scale * 150_000), MAX_OTEL_LOG_BODY_CHARS),
    },
    {
      // The first window, one widened to at most three times its size, and six quote probes
      // under 512 characters each.
      name: "a log body full of masked secrets",
      maxWork: 9 * MAX_OTEL_LOG_BODY_CHARS,
      capture: (scale: number) =>
        normalizeOtelLogString(`${SECRET_TOKEN} `.repeat(scale * 5000), MAX_OTEL_LOG_BODY_CHARS),
    },
    {
      name: "a log body full of quoted secrets",
      maxWork: 9 * MAX_OTEL_LOG_BODY_CHARS,
      capture: (scale: number) =>
        normalizeOtelLogString(
          `password: "${SECRET_BODY}" and 'it is' done\n`.repeat(scale * 3000),
          MAX_OTEL_LOG_BODY_CHARS,
        ),
    },
    {
      // The quote probe carries a capped escape, not the whole run.
      name: "a log body with a long escape run before a quote",
      maxWork: logBodyProbedMaxWork,
      capture: (scale: number) =>
        normalizeOtelLogString(
          `note=${"\\".repeat(7000)}"${"o".repeat(scale * 150_000)}`,
          MAX_OTEL_LOG_BODY_CHARS,
        ),
    },
    {
      // The quote probe collapses the whitespace between a key and its quote.
      name: "a log body with a long separator before a quote",
      maxWork: logBodyProbedMaxWork,
      capture: (scale: number) =>
        normalizeOtelLogString(
          `note:${" ".repeat(7000)}"${"o".repeat(scale * 150_000)}`,
          MAX_OTEL_LOG_BODY_CHARS,
        ),
    },
  ])("does not grow with $name beyond its export budget", ({ maxWork, capture }) => {
    const work = redactionCharsFor(() => capture(1));

    expect(redactionCharsFor(() => capture(2))).toBe(work);
    expect(work).toBeLessThan(maxWork);
  });
});

describe("OTEL content redaction at the export cut", () => {
  // The first JSON budget keeps 8,192 characters of a clipped string, suffix included.
  const jsonStringChars = 8192;
  const messagePart = {
    name: "a model-call message part",
    keptChars: jsonStringChars - TRUNCATED_SUFFIX.length,
    windowChars: jsonStringChars + REDACTION_LOOKAHEAD_CHARS,
    exportText: (text: string) =>
      String(captureModelCall([{ role: "user", content: text }])["gen_ai.input.messages"]),
  };
  const exportPaths = [
    messagePart,
    {
      name: "a model-call tool result",
      keptChars: jsonStringChars - TRUNCATED_SUFFIX.length,
      windowChars: jsonStringChars + REDACTION_LOOKAHEAD_CHARS,
      exportText: (text: string) =>
        String(
          captureModelCall([
            { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text }] },
          ])["gen_ai.input.messages"],
        ),
    },
    {
      name: "a log body",
      keptChars: MAX_OTEL_LOG_BODY_CHARS,
      windowChars: MAX_OTEL_LOG_BODY_CHARS + REDACTION_LOOKAHEAD_CHARS,
      exportText: (text: string) => normalizeOtelLogString(text, MAX_OTEL_LOG_BODY_CHARS),
    },
    {
      name: "a tool call output",
      keptChars: MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
      windowChars: MAX_OTEL_CONTENT_ATTRIBUTE_CHARS + REDACTION_LOOKAHEAD_CHARS,
      cutOnRedactorChunk: true,
      exportText: (text: string) =>
        String(captureToolCall({ toolOutput: text })["gen_ai.tool.call.result"]),
    },
    {
      name: "a tool call input of joined strings",
      keptChars: MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
      windowChars: MAX_OTEL_CONTENT_ATTRIBUTE_CHARS + REDACTION_LOOKAHEAD_CHARS,
      cutOnRedactorChunk: true,
      exportText: (text: string) =>
        String(captureToolCall({ toolInput: [text] })["gen_ai.tool.call.arguments"]),
    },
  ];
  // The core redactor matches text over 32,768 characters in 16,384-character chunks, and these
  // cuts fall on a chunk boundary, so a token crossing them goes unmatched in the whole text too.
  const tokenCutPaths = exportPaths.filter((path) => !("cutOnRedactorChunk" in path));

  it.each(tokenCutPaths)("masks a token that crosses the cut in $name", (path) => {
    // The token starts 10 characters before the cut; unmasked, the export would end "glpat-A1b2".
    const text = `${"x".repeat(path.keptChars - 11)} ${SECRET_TOKEN} ${"y".repeat(400_000)}`;

    const exported = path.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).toContain("glpat-…");
    expect(exported).not.toContain("glpat-A1b2");
  });

  it.each(exportPaths)("drops a private key cut off before its end line in $name", (path) => {
    const keyBlock = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END PRIVATE KEY-----`;
    const text = `${"x".repeat(path.keptChars - 400)}\n${keyBlock}\n${"y".repeat(400_000)}`;

    const exported = path.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).not.toContain(PRIVATE_KEY_BODY.slice(0, 32));
  });

  it.each(exportPaths)(
    "masks a JSON secret whose closing quote lies past the redaction window in $name",
    (path) => {
      const text = `${"x".repeat(path.keptChars - 200)} {"password": "${LONG_SECRET}"} ${"y".repeat(400_000)}`;

      const exported = path.exportText(text);

      expect(exported).toContain(TRUNCATED_SUFFIX);
      expect(exported).toContain("password");
      expect(exported).not.toContain(SECRET_BODY);
    },
  );

  it.each([
    { name: "JSON payment key", open: '{"cardNumber": "', value: LONG_SECRET, close: '"}' },
    { name: "quoted config assignment", open: 'password: "', value: LONG_SECRET, close: '"' },
    {
      name: "namespaced config assignment",
      open: "db.password = '",
      value: LONG_SECRET,
      close: "'",
    },
    { name: "quoted secret field", open: "client_secret: '", value: LONG_SECRET, close: "'" },
    { name: "backtick assignment", open: "token=`", value: LONG_SECRET, close: "`" },
    { name: "quoted CLI flag", open: '--password "', value: LONG_SECRET_WORD, close: '"' },
    { name: "escaped env assignment", open: 'API_KEY=\\"', value: LONG_SECRET_WORD, close: '\\"' },
    {
      // A GitHub push webhook's null commit id: the probe must not find its stand-in here.
      name: "JSON secret key after a run of zeros",
      open: `{"before": "${"0".repeat(40)}", "password": "`,
      value: LONG_SECRET,
      close: '"}',
    },
    {
      name: "config assignment spaced from its quote",
      open: `password:${" ".repeat(260)}"`,
      value: LONG_SECRET,
      close: '"',
    },
    {
      name: "JSON secret key spaced from its quote",
      open: `{"password":${" ".repeat(300)}"`,
      value: LONG_SECRET,
      close: '"}',
    },
    {
      name: "JSON secret value spanning lines",
      open: '{"password": "',
      value: `${SECRET_BODY}\n${LONG_SECRET}`,
      close: '"}',
    },
  ])("masks an open $name value at the cut", ({ open, value, close }) => {
    // The value starts 200 characters before the cut, however long its key and separator are.
    const pad = "x".repeat(messagePart.keptChars - 201 - open.length);
    const text = `${pad} ${open}${value}${close} ${"y".repeat(400_000)}`;

    const exported = messagePart.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).not.toContain(SECRET_BODY);
  });

  it("keeps a long quoted value whose key is not sensitive", () => {
    const text = `${"x".repeat(messagePart.keptChars - 200)} {"description": "${LONG_SECRET}"}`;

    expect(messagePart.exportText(text)).toContain(`"description\\": \\"${SECRET_BODY}`);
  });

  it("masks a quoted secret wherever the probe's key context starts", () => {
    // A context cut inside `token="` began the probe with an assignment the text does not have,
    // whose quoted value ran to the quote after `password:` and left the stand-in unmasked.
    for (let filler = 230; filler <= 250; filler++) {
      const open = `token="${"y".repeat(filler)} password: "`;
      const value = `LEAKMARKzz ${LONG_SECRET}`;
      const logPad = "x".repeat(MAX_OTEL_LOG_BODY_CHARS - 200 - open.length);
      const logText = `${logPad}${open}${value}" ${"z".repeat(60_000)}`;
      expect(
        normalizeOtelLogString(logText, MAX_OTEL_LOG_BODY_CHARS),
        `filler ${filler}`,
      ).not.toContain("LEAKMARK");
      const messagePad = "x".repeat(messagePart.keptChars - 200 - open.length);
      const attributes = captureModelCall([
        { role: "user", content: `${messagePad}${open}${value}" ${"z".repeat(400_000)}` },
      ]);
      for (const key of ["gen_ai.input.messages", "openclaw.content.input_messages"]) {
        expect(String(attributes[key]), `${key}, filler ${filler}`).not.toContain("LEAKMARK");
      }
    }
  });

  it("keeps text after a quote that a line break leaves unclosed", () => {
    const prose = "ordinary words ".repeat(400);
    const text = `${"x".repeat(messagePart.keptChars - 200)} Set password: "\n${prose}" ${"y".repeat(400_000)}`;

    expect(messagePart.exportText(text)).toContain("ordinary words ordinary words");
  });

  it.each(exportPaths)(
    "masks a fixed-length secret the window cuts after earlier masks shorten the text in $name",
    (path) => {
      // Without the earlier masks the secret would start past the export; with them, the export
      // reaches the window end, where the cut leaves 20 characters of the secret unmatched.
      const head = `${SHRINKING_TOKENS} `;
      const pad = "x".repeat(path.windowChars - head.length - 21);
      const text = `${head}${pad} ${AWS_STYLE_SECRET} ${"y".repeat(400_000)}`;

      const exported = path.exportText(text);

      expect(exported).toContain(TRUNCATED_SUFFIX);
      expect(exported).not.toContain(AWS_STYLE_SECRET.slice(0, 12));
    },
  );

  it("exports a full budget of text whose masks shorten it by up to half", () => {
    const text = `ordinary words around a token ${SECRET_TOKEN}\n`.repeat(2000);

    const exported = normalizeOtelLogString(text, MAX_OTEL_LOG_BODY_CHARS);

    expect(exported).toHaveLength(MAX_OTEL_LOG_BODY_CHARS + TRUNCATED_SUFFIX.length);
    expect(exported).not.toContain(SECRET_BODY);
  });

  it("redacts line-start assignments in content that fits without truncation", () => {
    const attributes = captureModelCall([
      { role: "user", content: `notes\npassword=${SECRET_BODY}` },
    ]);

    for (const key of ["gen_ai.input.messages", "openclaw.content.input_messages"]) {
      expect(String(attributes[key])).not.toContain(SECRET_BODY);
    }
  });
});
