import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
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
import { normalizeOtelLogString } from "./service-content-normalization.js";
import {
  assignOtelModelContentAttributes,
  assignOtelToolContentAttributes,
} from "./service-genai-content.js";

const MAX_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
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
// A JWT whose header and payload run past the redaction lookahead, so a window that starts it
// ends before its signature. Built from runtime claims so the fixture is not a literal token.
const LONG_JWT_HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
  "base64url",
);
const LONG_JWT_PAYLOAD = Buffer.from(
  JSON.stringify({ sub: "synthetic", groups: Array.from({ length: 400 }, (_, i) => `group-${i}`) }),
).toString("base64url");
const LONG_JWT = `${LONG_JWT_HEADER}.${LONG_JWT_PAYLOAD}.${SECRET_BODY}`;
// The core JWT rule takes any base64url payload; indented claims do not start `eyJ`.
const LONG_JWT_INDENTED = `${LONG_JWT_HEADER}.${Buffer.from(
  JSON.stringify(
    { sub: "synthetic", groups: Array.from({ length: 300 }, (_, i) => `group-${i}`) },
    null,
    2,
  ),
).toString("base64url")}.${SECRET_BODY}`;
// The AWS secret-key rule matches exactly 40 characters, so a cut inside one leaves no match.
const AWS_STYLE_SECRET = "Q1w2E3r4".repeat(5);
// Each masks to 11 characters, so together they shorten the redacted text by more than the lookahead.
const SHRINKING_TOKENS = Array.from({ length: 5 }, () => `sk-${SECRET_BODY.repeat(31)}`).join(" ");

function captureModelCall(inputMessages: unknown[]): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {};
  assignOtelModelContentAttributes(attributes, { inputMessages }, true);
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
  assignOtelToolContentAttributes(attributes, content, true);
  return attributes;
}

function withRedactPatterns<T>(patterns: string[], run: () => T): T {
  const configDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openclaw-otel-redact-config-"));
  const configPath = nodePath.join(configDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ logging: { redactPatterns: patterns } }));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  try {
    return run();
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(configDir, { force: true, recursive: true });
  }
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

  it("keeps fewer object fields when every candidate that fits is over the redaction cap", () => {
    // 512 long strings outside any array: the smallest budget clips each one, and its JSON would
    // fit the attribute, but their redaction windows pass the 8x cap. 16 fields of 8 strings fit
    // both at 512 characters a string.
    const fields = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`f${index}`, `${SECRET_TOKEN} ${"o".repeat(4960)}`]),
    );
    const toolInput = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`k${index}`, { ...fields }]),
    );
    let exported = "";

    const work = redactionCharsFor(() => {
      exported = String(captureToolCall({ toolInput })["gen_ai.tool.call.arguments"]);
    });

    const parsed = JSON.parse(exported) as Record<string, unknown>;
    expect(parsed).toMatchObject({ truncated: true, omittedFields: 48 });
    expect(Object.keys(parsed).filter((key) => key.startsWith("k"))).toHaveLength(16);
    const kept = Object.values(parsed.k15 as Record<string, string>);
    expect(kept).toHaveLength(8);
    for (const text of kept) {
      expect(text).toHaveLength(512);
      expect(text.startsWith("glpat-…")).toBe(true);
      expect(text.endsWith(TRUNCATED_SUFFIX)).toBe(true);
    }
    expect(exported).not.toContain(SECRET_BODY);
    expect(work).toBeLessThan(2 * 8 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  });
});

describe("OTEL complete export after masking", () => {
  // Each line's token masks to 11 characters, so the dump's JSON shrinks by about half.
  const credentialsDump = (lines: number) =>
    Array.from(
      { length: lines },
      (_, index) =>
        `GITHUB_TOKEN_${String(index).padStart(5, "0")}=ghp_${SECRET_BODY}${String(index).padStart(4, "0")}`,
    ).join("\n");
  // Twelve characters from the middle of a token: a mask keeps only its first six and last four.
  const TOKEN_MIDDLE = SECRET_BODY.slice(8, 20);
  const exportedJson = (inputMessages: unknown[]) =>
    Object.values(captureModelCall(inputMessages))
      .map(String)
      .filter((value) => value.startsWith("["));
  // Two JSON serializations (`input.value` reuses one), each redacted whole (strings, then
  // JSON) and then truncated as before.
  const wholeThenTruncatedMaxWork = 2 * (8 + 9) * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS;

  it("exports a value whose JSON fits the attribute only once it is masked", () => {
    // Eight tool results of about 24,000 characters: over the attribute together, under it masked.
    const inputMessages = toolResultTranscript(8, 1, credentialsDump(400));
    expect(JSON.stringify(inputMessages).length).toBeGreaterThan(MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);

    const exported = exportedJson(inputMessages);

    expect(exported).toHaveLength(3);
    for (const json of exported) {
      expect(json.length).toBeLessThanOrEqual(MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
      expect(json).not.toContain(TRUNCATED_SUFFIX);
      expect(json).not.toContain(TOKEN_MIDDLE);
      expect(json.match(/GITHUB_TOKEN_00399=/g)).toHaveLength(8);
    }
  });

  it("masks tokens across 16,384-character offsets in a string exported whole", () => {
    // One string of about 180,000 characters. Configured patterns run in 16,384-character chunks
    // on text this long; built-in rules must mask a token wherever it falls. The 30-character
    // first line puts a token across each of these offsets.
    const text = `${"x".repeat(29)}\n${credentialsDump(3000)}`;
    for (const offset of [16_384, 32_768, 65_536]) {
      const tokenStart = text.lastIndexOf("ghp_", offset);
      expect(tokenStart).toBeLessThan(offset);
      expect(tokenStart + 40).toBeGreaterThan(offset);
    }
    const inputMessages = toolResultTranscript(1, 1, text);
    expect(JSON.stringify(inputMessages).length).toBeGreaterThan(MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);

    const exported = exportedJson(inputMessages);

    expect(exported).toHaveLength(3);
    for (const json of exported) {
      expect(json).not.toContain(TRUNCATED_SUFFIX);
      expect(json).not.toContain(TOKEN_MIDDLE);
      expect(json).toContain("GITHUB_TOKEN_02999=");
    }
  });

  it.each([
    { name: "short trailing text", trailing: "Trailing words after the token. ".repeat(10) },
    {
      name: "trailing text longer than a clipped string",
      trailing: "Trailing words. ".repeat(1400),
    },
  ])(
    "exports a message past 4x the attribute whole once its JWT is masked, with $name",
    ({ trailing }) => {
      // The JWT's payload alone puts the message past 4x the attribute; masked, it fits.
      const payload = Buffer.from(
        JSON.stringify({ sub: "synthetic", note: "n".repeat(450_000) }),
      ).toString("base64url");
      const jwt = `${LONG_JWT_HEADER}.${payload}.${SECRET_BODY}`;
      const content = `Token: ${jwt}\n${trailing}`;
      expect(content.length).toBeGreaterThan(4 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);

      const attributes = captureModelCall([{ role: "user", content }]);

      for (const key of ["gen_ai.input.messages", "openclaw.content.input_messages"]) {
        const json = String(attributes[key]);
        expect(json).not.toContain(TRUNCATED_SUFFIX);
        expect(json).not.toContain(payload.slice(100, 140));
        expect(json).toContain(trailing.slice(-64));
      }
    },
  );

  it("truncates a value under 4x the attribute that masking does not shrink enough", () => {
    const inputMessages = toolResultTranscript(8, 1, "o".repeat(20_000));
    let exported: string[] = [];

    const work = redactionCharsFor(() => {
      exported = exportedJson(inputMessages);
    });

    expect(exported).toHaveLength(3);
    for (const json of exported) {
      expect(json).toContain(TRUNCATED_SUFFIX);
      expect(json.length).toBeLessThanOrEqual(MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    }
    expect(work).toBeLessThan(wholeThenTruncatedMaxWork);
  });

  it("does not redact a value just over 4x the attribute whole", () => {
    // Four tool results of 150,000 characters are past 4x the attribute, so they are truncated
    // without a whole-value pass and doubling them does not change the work.
    const capture = (scale: number) =>
      exportedJson(toolResultTranscript(4, 1, "o".repeat(scale * 150_000)));
    expect(JSON.stringify(toolResultTranscript(4, 1, "o".repeat(150_000))).length).toBeGreaterThan(
      4 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
    );

    const work = redactionCharsFor(() => capture(1));

    expect(redactionCharsFor(() => capture(2))).toBe(work);
    expect(work).toBeLessThan(2 * 9 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    for (const json of capture(1)) {
      expect(json).toContain(TRUNCATED_SUFFIX);
    }
  });
});

describe("OTEL content redaction at the export cut", () => {
  // The text after each cut puts a string past 8x the attribute, so neither the whole-value pass
  // nor a whole-string pass runs and these cases exercise the windows.
  const CUT_TAIL_CHARS = 1_100_000;
  // Past 4x the attribute and within 8x: a string whose window ends inside a secret is redacted
  // whole.
  const WHOLE_STRING_TAIL_CHARS = 600_000;
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
      cutOnConfiguredPatternChunk: true,
      exportText: (text: string) =>
        String(captureToolCall({ toolOutput: text })["gen_ai.tool.call.result"]),
    },
    {
      name: "a tool call input of joined strings",
      keptChars: MAX_OTEL_CONTENT_ATTRIBUTE_CHARS,
      windowChars: MAX_OTEL_CONTENT_ATTRIBUTE_CHARS + REDACTION_LOOKAHEAD_CHARS,
      cutOnConfiguredPatternChunk: true,
      exportText: (text: string) =>
        String(captureToolCall({ toolInput: [text] })["gen_ai.tool.call.arguments"]),
    },
  ];
  // Configured patterns run in 16,384-character chunks on text over 32,768 characters (built-in
  // rules scan the whole text), and these cuts fall on a chunk boundary, so a configured match
  // crossing them goes unmatched in the whole text too.
  const configuredPatternCutPaths = exportPaths.filter(
    (path) => !("cutOnConfiguredPatternChunk" in path),
  );

  it.each(exportPaths)("masks a token that crosses the cut in $name", (path) => {
    // The token starts 10 characters before the cut; unmasked, the export would end "glpat-A1b2".
    const text = `${"x".repeat(path.keptChars - 11)} ${SECRET_TOKEN} ${"y".repeat(CUT_TAIL_CHARS)}`;

    const exported = path.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).toContain("glpat-…");
    expect(exported).not.toContain("glpat-A1b2");
  });

  it("masks a token that crosses the cut after a whole-value pass that does not fit", () => {
    // Under 4x the attribute, so the value is redacted whole first. It stays too large, and the
    // truncated export still has to mask the token at its cut.
    const text = `${"x".repeat(messagePart.keptChars - 11)} ${SECRET_TOKEN} ${"y".repeat(300_000)}`;
    expect(text.length).toBeGreaterThan(MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
    expect(text.length).toBeLessThan(3 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);

    const exported = messagePart.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).toContain("glpat-…");
    expect(exported).not.toContain("glpat-A1b2");
  });

  it.each(exportPaths)("drops a private key cut off before its end line in $name", (path) => {
    const keyBlock = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END PRIVATE KEY-----`;
    const text = `${"x".repeat(path.keptChars - 400)}\n${keyBlock}\n${"y".repeat(CUT_TAIL_CHARS)}`;

    const exported = path.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).not.toContain(PRIVATE_KEY_BODY.slice(0, 32));
  });

  it.each(exportPaths)(
    "masks a JWT whose signature lies past the redaction window in $name",
    (path) => {
      for (const jwt of [LONG_JWT, LONG_JWT_INDENTED]) {
        // The token starts 200 characters before the cut, so its header and part of its payload
        // would be exported.
        expect(jwt.lastIndexOf(".")).toBeGreaterThan(200 + REDACTION_LOOKAHEAD_CHARS);
        const text = `${"x".repeat(path.keptChars - 201)} ${jwt} ${"y".repeat(CUT_TAIL_CHARS)}`;

        const exported = path.exportText(text);

        expect(exported).toContain(TRUNCATED_SUFFIX);
        expect(exported).not.toContain(LONG_JWT_HEADER);
        expect(exported).not.toContain(
          jwt.slice(LONG_JWT_HEADER.length + 1, LONG_JWT_HEADER.length + 33),
        );
      }
    },
  );

  it.each(exportPaths)(
    "masks a JSON secret whose closing quote lies past the redaction window in $name",
    (path) => {
      const text = `${"x".repeat(path.keptChars - 200)} {"password": "${LONG_SECRET}"} ${"y".repeat(CUT_TAIL_CHARS)}`;

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
    const text = `${pad} ${open}${value}${close} ${"y".repeat(CUT_TAIL_CHARS)}`;

    const exported = messagePart.exportText(text);

    expect(exported).toContain(TRUNCATED_SUFFIX);
    expect(exported).not.toContain(SECRET_BODY);
  });

  it.each(configuredPatternCutPaths)(
    "masks a configured pattern's match that runs past the lookahead in $name",
    (path) => {
      // Configured patterns can need any amount of text: this match starts 200 characters before
      // the cut and ends past the lookahead, so only whole-value redaction masks it.
      const secret = `SECRETSTART${"q".repeat(5000)}END`;
      const text = `${"x".repeat(path.keptChars - 201)} ${secret} ${"y".repeat(CUT_TAIL_CHARS)}`;

      const exported = withRedactPatterns(["SECRETSTART[q]{5000}END"], () => path.exportText(text));

      expect(exported).toContain(TRUNCATED_SUFFIX);
      expect(exported).not.toContain("SECRETSTART");
    },
  );

  it("keeps long base64url JSON with no dot that crosses the window end", () => {
    // It starts like a JWT header, but a JWT header ends at a dot.
    const text = `${"x".repeat(messagePart.keptChars - 200)} ${LONG_JWT_PAYLOAD} ${"y".repeat(CUT_TAIL_CHARS)}`;

    expect(messagePart.exportText(text)).toContain(LONG_JWT_PAYLOAD.slice(0, 150));
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
        { role: "user", content: `${messagePad}${open}${value}" ${"z".repeat(CUT_TAIL_CHARS)}` },
      ]);
      for (const key of ["gen_ai.input.messages", "openclaw.content.input_messages"]) {
        expect(String(attributes[key]), `${key}, filler ${filler}`).not.toContain("LEAKMARK");
      }
    }
  });

  it("keeps text after a quote that a line break leaves unclosed", () => {
    const prose = "ordinary words ".repeat(400);
    const text = `${"x".repeat(messagePart.keptChars - 200)} Set password: "\n${prose}" ${"y".repeat(CUT_TAIL_CHARS)}`;

    expect(messagePart.exportText(text)).toContain("ordinary words ordinary words");
  });

  it.each(exportPaths)(
    "masks a fixed-length secret the window cuts after earlier masks shorten the text in $name",
    (path) => {
      // Without the earlier masks the secret would start past the export; with them, the export
      // reaches the window end, where the cut leaves 20 characters of the secret unmatched.
      const head = `${SHRINKING_TOKENS} `;
      const pad = "x".repeat(path.windowChars - head.length - 21);
      const text = `${head}${pad} ${AWS_STYLE_SECRET} ${"y".repeat(CUT_TAIL_CHARS)}`;

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

  // Registered secrets stay registered until the runner resets the registry after this file, and
  // they widen every later window, so these cases run last.
  it.each(exportPaths)("masks a URL password whose @ lies past the lookahead in $name", (path) => {
    // The URL rules need the @ after the password, which lies past the window here.
    const urls = [
      (password: string) => `https://deploy:${password}@internal.example.test/path`,
      (password: string) => `postgres://deploy:${password}@db.example.test:5432/app`,
    ];
    for (const url of urls) {
      for (const length of [5000, 10_000]) {
        const password = `${SECRET_BODY}${"p".repeat(length - SECRET_BODY.length)}`;
        const text = `${"x".repeat(path.keptChars - 201)} ${url(password)} ${"y".repeat(CUT_TAIL_CHARS)}`;

        const exported = path.exportText(text);

        expect(exported).not.toContain(SECRET_BODY);
        expect(exported).toContain("deploy:***");
        expect(exported).toContain(TRUNCATED_SUFFIX);
      }
    }
  });

  it.each(exportPaths)(
    "masks a database URL password holding a slash whose @ lies past the lookahead in $name",
    (path) => {
      // The connection-string rule lets a password hold a `/` and ends it only at `@`.
      const password = `${SECRET_BODY}/${"p".repeat(5000)}`;
      const url = `postgres://deploy:${password}@db.example.test:5432/app`;
      const text = `${"x".repeat(path.keptChars - 201)} ${url} ${"y".repeat(CUT_TAIL_CHARS)}`;

      const exported = path.exportText(text);

      expect(exported).not.toContain(SECRET_BODY);
      expect(exported).toContain("deploy:***");
      expect(exported).toContain(TRUNCATED_SUFFIX);
    },
  );

  it("masks a database URL password holding a slash in a string redacted whole", () => {
    const password = `${SECRET_BODY}/${"p".repeat(5000)}`;
    const url = `postgres://deploy:${password}@db.example.test:5432/app`;
    const text = `${"x".repeat(messagePart.keptChars - 201)} ${url} ${"y".repeat(WHOLE_STRING_TAIL_CHARS)}`;

    const exported = messagePart.exportText(text);

    expect(exported).not.toContain(SECRET_BODY);
    expect(exported).toContain(TRUNCATED_SUFFIX);
  });

  it.each([
    // A web URL's password ends at `/`, so the port is not one.
    { url: "https://internal.example.test:8443/", tail: CUT_TAIL_CHARS },
    // A database URL's password may hold a `/`, so a port and path that run to the window end
    // read as an open password; a string within the whole-string budget is redacted whole.
    { url: "postgres://db.example.test:5432/app/", tail: WHOLE_STRING_TAIL_CHARS },
  ])("keeps the port and path of $url when they cross the cut", ({ url, tail }) => {
    const text = `${"x".repeat(messagePart.keptChars - 200)} ${url}${"a".repeat(20_000)} ${"y".repeat(tail)}`;

    expect(messagePart.exportText(text)).toContain(`${url}aaaa`);
  });

  it("drops a database URL from its port when its path runs past the window and the budget", () => {
    const url = "postgres://db.example.test:5432/app/";
    const text = `${"x".repeat(messagePart.keptChars - 200)} ${url}${"a".repeat(20_000)} ${"y".repeat(CUT_TAIL_CHARS)}`;

    const exported = messagePart.exportText(text);

    expect(exported).toContain("postgres://db.example.test:***");
    expect(exported).not.toContain("5432/app");
  });

  it.each(exportPaths)(
    "masks a registered secret longer than the lookahead that crosses the cut in $name",
    (path) => {
      // Registered values only match whole. This one starts 10 characters before the cut and
      // ends past the default lookahead; unmasked, the export would end with its first 10.
      const secret = generateSecureToken({ bytes: 3456, redact: true });
      expect(secret.length).toBeGreaterThan(REDACTION_LOOKAHEAD_CHARS);
      const text = `${"x".repeat(path.keptChars - 11)} ${secret} ${"y".repeat(CUT_TAIL_CHARS)}`;

      const exported = path.exportText(text);

      expect(exported).not.toContain(secret.slice(0, 10));
      expect(exported).toContain(`${secret.slice(0, 6)}…`);
      expect(exported).toContain(TRUNCATED_SUFFIX);
    },
  );

  it("keeps a model call's redaction work within its budget when a long secret is registered", () => {
    // A registered secret widens every clipped string's window by its length. JSON attributes
    // count those windows against their cap and keep fewer items instead of redacting more.
    const secret = generateSecureToken({ bytes: 49_152, redact: true });
    expect(secret).toHaveLength(65_536);

    const work = redactionCharsFor(() =>
      captureModelCall(toolResultTranscript(200, 1, "o".repeat(100_000))),
    );

    expect(work).toBeLessThan(2 * 9 * MAX_OTEL_CONTENT_ATTRIBUTE_CHARS);
  });

  it("names the redaction cap when no candidate's windows fit it", () => {
    // A registered secret of 1,048,576 characters makes every clipped string's window pass the cap
    // on its own, so even one field of one string cannot be exported.
    const secret = generateSecureToken({ bytes: 786_432, redact: true });
    expect(secret).toHaveLength(1_048_576);

    const exported = captureToolCall({ toolInput: { note: "o".repeat(2_000_000) } })[
      "gen_ai.tool.call.arguments"
    ];

    expect(JSON.parse(String(exported))).toEqual({
      truncated: true,
      reason: "max_redaction_work",
      type: "object",
    });
  });
});
