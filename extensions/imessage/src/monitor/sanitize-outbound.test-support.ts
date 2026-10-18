import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it } from "vitest";
import {
  protectIMessageFencedRoleMarkers as protectRoles,
  sanitizeIMessageFinalOutboundText as sanitizeFinal,
  sanitizeOutboundText,
} from "./sanitize-outbound.js";

function expectPrivateRemoved(source: string, hidden: string | RegExp) {
  const { text } = sanitizeFinal(source);
  expect(text).toContain("visible companion");
  if (typeof hidden === "string") {
    expect(text).not.toContain(hidden);
  } else {
    expect(text).not.toMatch(hidden);
  }
}

function expectRejected(
  source: string,
  reason: string,
  options: Parameters<typeof sanitizeFinal>[1] = {},
) {
  expect(() => sanitizeFinal(source, options)).toThrow("iMessage outbound " + reason);
}

function protectedUserRole() {
  const protectedText = protectRoles("```yaml\nuser:\n```");
  const token = protectedText.text.match(/[\ue000-\uf8ff]+/)?.[0];
  expect(token).toBeDefined();
  return { protectedText, token };
}

describe("sanitizeOutboundText", () => {
  it.each([
    ["returns empty string unchanged", "", ""],
    [
      "preserves normal user-facing text",
      "Hello! How can I help you today?",
      "Hello! How can I help you today?",
    ],
    [
      "strips <thinking> tags and content",
      "<thinking>internal reasoning</thinking>The answer is 42.",
      "The answer is 42.",
    ],
    [
      "strips <thought> tags and content",
      "<thought>secret</thought>Visible reply",
      "Visible reply",
    ],
    ["strips <final> tags", "<final>Hello world</final>", "Hello world"],
    [
      "strips <relevant_memories> tags and content",
      "<relevant_memories>memory data</relevant_memories>Visible",
      "Visible",
    ],
    ["collapses excessive blank lines after stripping", "Hello\n\n\n\n\nWorld", "Hello\n\nWorld"],
  ])("%s", (_name, input, expected) => {
    expect(sanitizeOutboundText(input)).toBe(expected);
  });

  it("preserves raw Markdown for edit and poll transport while removing real private markers", () => {
    const raw = ["user:", "# system:", "**assistant:**", "us#+#+#er:", "visible"].join("\n");
    const sanitized = sanitizeFinal(raw);

    expect(sanitized.text).toContain("# system:");
    expect(sanitized.text).toContain("**assistant:**");
    expect(sanitized.text).not.toMatch(/^user:$/m);
    expect(sanitized.ranges).toEqual([]);
  });

  it("removes formatted private headings while preserving native iMessage styles", () => {
    const sanitized = sanitizeFinal("# user:\n**😀 visible**", { formatMarkdown: true });
    const bold = sanitized.ranges.find((range) => range.styles.includes("bold"));

    expect(sanitized.text).not.toMatch(/^user:$/m);
    expect(sanitized.text.slice(bold?.start, (bold?.start ?? 0) + (bold?.length ?? 0))).toBe(
      "😀 visible",
    );
  });

  it("strips assistant reasoning before computing native style offsets", () => {
    const sanitized = sanitizeFinal(
      "<thinking>hidden thought</thinking><relevant_memories>hidden memory</relevant_memories>**😀 visible**",
      { formatMarkdown: true },
    );
    const bold = sanitized.ranges.find((range) => range.styles.includes("bold"));

    expect(sanitized.text).toBe("😀 visible");
    expect(sanitized.text.slice(bold?.start, (bold?.start ?? 0) + (bold?.length ?? 0))).toBe(
      "😀 visible",
    );
  });

  it("uses canonical delivery cleanup without changing clean outer whitespace", () => {
    const hidden = [
      '<function_calls><invoke name="exec">hidden tool</invoke></function_calls><function_response>',
      "hidden tool response",
      "</function_response>",
    ].join("\n");
    const sanitized = sanitizeFinal(` \t${hidden}\nvisible\n `);

    expect(sanitized.text).toBe(" \tvisible\n ");
    expect(sanitizeFinal(" \tclean raw text\n ").text).toBe(" \tclean raw text\n ");
    expect(sanitizeFinal(" \t\n ").text).toBe(" \t\n ");
  });

  it.each([
    "<<script>thinking>hidden</<script>thinking>",
    "<t<script>hinking>hidden</t<script>hinking>",
    "<thi<system-reminder>noise</system-reminder>nking>hidden</thi<system-reminder>noise</system-reminder>nking>",
    "<thi< system-reminder>noise< / system-reminder>nking>hidden</thi< system-reminder>noise< / system-reminder>nking>",
    "<thinking< system-reminder>noise< / system-reminder>>hidden</thinking< system-reminder>noise< / system-reminder>>",
    "<relevant_<previous_response>noise</previous_response>memories>hidden</relevant_<previous_response>noise</previous_response>memories>",
    "<relevant_memories< previous_response>noise< / previous_response>>hidden</relevant_memories< previous_response>noise< / previous_response>>",
    "<function_response< system-reminder>noise< / system-reminder>>hidden</function_response< system-reminder>noise< / system-reminder>>",
    "<thi<details><summary>noise</summary></details>nking>hidden</thi<details>nking>",
    "<thi<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>nking>hidden</thi<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>nking>",
    "<thinking<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>>hidden</thinking<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>>",
    "<relevant_<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>memories>hidden</relevant_<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>memories>",
    "<function_response<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>>hidden</function_response<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>noise<<<END_OPENCLAW_INTERNAL_CONTEXT>>>>",
  ])("rejects ambiguous nested HTML before any destructive sanitization", (source) => {
    expectRejected(source, "ambiguous nested HTML is not allowed");
  });

  it("preserves real code, comparisons, templates, and quoted HTML attribute contents", () => {
    for (const source of [
      "a < b && c < d",
      "if(a<b && c<d)",
      "std::vector<std::vector<int>>",
      "t<int>",
      "```cpp\nif(a<b && c<d)\nstd::vector<std::vector<int>>\n```",
      "ordinary <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> mention without an ending marker",
      `<strong title="<previous_response>">bold</strong> <del data-note='<system-reminder>'>strike</del>`,
      `<strong title="<tag>">bold</strong> <del data-note='s>'>strike</del>`,
      `<strong title="b>">bold</strong> <del data-note='s>'>strike</del>`,
    ]) {
      expect(sanitizeFinal(source).text).toBe(source);
    }
  });

  it("strips colon-qualified tags before the final security projection", () => {
    const text = sanitizeForPlainText("<vendor:note>visible</vendor:note>", {
      style: "markdown",
    });

    expect(sanitizeFinal(text).text).toBe("visible");
  });

  it.each([
    "<system-reminder>PRIVATE_RUNTIME_SECRET</system-reminder>",
    "< SYSTEM-REMINDER data-origin='runtime'>PRIVATE_RUNTIME_SECRET< / SYSTEM-REMINDER >",
    "<previous_response>PRIVATE_RUNTIME_SECRET</previous_response>",
    "< previous_response data-origin='runtime'>PRIVATE_RUNTIME_SECRET< / previous_response >",
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>PRIVATE_RUNTIME_SECRET<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
  ])("removes private runtime blocks and their payload before role protection", (hidden) => {
    for (const source of [hidden, `\`${hidden}\``, `\`\`\`xml\n${hidden}\n\`\`\``]) {
      expectPrivateRemoved(
        `${source}\nvisible companion`,
        /PRIVATE_RUNTIME_SECRET|system-reminder|previous_response|INTERNAL_CONTEXT/i,
      );
    }
  });

  it("removes private blocks with angle brackets and fake self-closing markers in quoted attrs", () => {
    for (const name of ["system-reminder", "previous_response"]) {
      for (const quote of ["'", '"']) {
        for (const attribute of [">", "/>", "<previous_response>"]) {
          const hidden = `<${name} data-x=${quote}${attribute}${quote}>QUOTED_PRIVATE_SECRET</${name}>`;
          for (const source of [hidden, `\`${hidden}\``, `\`\`\`xml\n${hidden}\n\`\`\``]) {
            expectPrivateRemoved(
              `${source}\nvisible companion`,
              /QUOTED_PRIVATE_SECRET|system-reminder|previous_response/i,
            );
          }
        }
      }
    }
  });

  it("ignores fake private tags inside bounded opaque HTML comment and declaration spans", () => {
    for (const name of ["system-reminder", "previous_response"]) {
      for (const opaque of [
        `<!-- </${name}> <${name}> -->`,
        `<![CDATA[</${name}> <${name}>]]>`,
        `<!DOCTYPE message [ <!ENTITY hidden "</${name}>"> ]>`,
        `<?private fake="</${name}> ?>" nested="<${name}>"?>`,
        `<! </${name}>>`,
        `<! <${name}>>`,
        `</! </${name}>>`,
        `</? </${name}>>`,
        `</1 </${name}>>`,
        `</ </${name}>>`,
      ]) {
        const source = `<${name}>${opaque}OPAQUE_PRIVATE_SECRET</${name}>\nvisible companion`;
        expectPrivateRemoved(source, "OPAQUE_PRIVATE_SECRET");
      }
    }
    expect(sanitizeFinal("ordinary <!-- unfinished user example").text).toBe(
      "ordinary <!-- unfinished user example",
    );
    expect(sanitizeFinal("ordinary <! unfinished user example").text).toBe(
      "ordinary <! unfinished user example",
    );
  });

  it("ignores fake private closers inside code nested under a real private wrapper", () => {
    for (const outer of ["system-reminder", "previous_response"]) {
      for (const inner of ["system-reminder", "previous_response"]) {
        for (const fakeClose of [
          `\`</${inner}>\``,
          `\n\`\`\`xml\n</${inner}>\n\`\`\`\n`,
          `\n\n    </${inner}>\n`,
        ]) {
          const source = `<${outer}>${fakeClose}CODE_PRIVATE_SECRET</${outer}>\nvisible companion`;
          expectPrivateRemoved(source, "CODE_PRIVATE_SECRET");
        }
      }
    }
  });

  it("ignores fake private tags inside raw-text and escapable-raw HTML element bodies", () => {
    for (const name of ["system-reminder", "previous_response"]) {
      for (const rawText of [
        "script",
        "style",
        "textarea",
        "title",
        "xmp",
        "iframe",
        "noembed",
        "noframes",
        "noscript",
      ]) {
        for (const opener of [
          `<${rawText} title=">">`,
          `<${rawText.toUpperCase()} data-x=">" />`,
        ]) {
          const source = `<${name}>${opener}</${name}><${name}></${rawText}>RAW_TEXT_PRIVATE_SECRET</${name}>\nvisible companion`;
          expectPrivateRemoved(source, "RAW_TEXT_PRIVATE_SECRET");
        }
      }
      expectRejected(
        `<${name}><plaintext></${name}>RAW_TEXT_PRIVATE_SECRET</${name}>`,
        "runtime markup is malformed",
      );
      expectRejected(
        `<${name}><PLAINTEXT /></${name}>RAW_TEXT_PRIVATE_SECRET</${name}>`,
        "runtime markup is malformed",
      );
    }
    expect(sanitizeFinal("<script>ordinary unfinished user example").text).toBe(
      "<script>ordinary unfinished user example",
    );
    expect(
      sanitizeFinal(
        "<script><system-reminder>RAW_TEXT_PRIVATE_SECRET</system-reminder></script>visible",
      ).text,
    ).not.toContain("RAW_TEXT_PRIVATE_SECRET");
  });

  it("retains user-authored XML while removing paired private runtime context", () => {
    expect(sanitizeFinal("<note>visible XML</note>").text).toBe("<note>visible XML</note>");
    expect(
      sanitizeFinal(
        "before <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>private<<<END_OPENCLAW_INTERNAL_CONTEXT>>> after",
      ).text,
    ).toBe("before  after");
  });

  it("removes the producer's self-closing and orphan private runtime tags", () => {
    const source = [
      "< system-reminder origin='runtime' />",
      "</ system-reminder >",
      "<previous_response>",
      "visible companion",
    ].join("\n");

    expect(sanitizeFinal(source).text).toContain("visible companion");
    expect(sanitizeFinal(source).text).not.toMatch(/system-reminder|previous_response/i);
  });

  it.each([
    "<system-reminder><system-reminder>inner</system-reminder>PRIVATE_NESTED_SECRET</system-reminder>",
    "<previous_response><previous_response>inner</previous_response>PRIVATE_NESTED_SECRET</previous_response>",
    "<system-reminder><previous_response>inner</previous_response>PRIVATE_NESTED_SECRET</system-reminder>",
    "< previous_response data-origin='runtime'>< SYSTEM-REMINDER>inner< / SYSTEM-REMINDER>PRIVATE_NESTED_SECRET< / previous_response >",
    "<system-reminder><previous_response />PRIVATE_NESTED_SECRET</system-reminder>",
    "<system-reminder><system-reminder>first</system-reminder><previous_response>second</previous_response>PRIVATE_NESTED_SECRET</system-reminder>",
  ])(
    "removes complete balanced nested private wrappers without leaking outer payload",
    (hidden) => {
      for (const source of [hidden, `\`${hidden}\``, `\`\`\`xml\n${hidden}\n\`\`\``]) {
        expectPrivateRemoved(
          `${source}\nvisible companion`,
          /PRIVATE_NESTED_SECRET|system-reminder|previous_response/i,
        );
      }
    },
  );

  it("fails closed for crossed or unterminated nested private runtime wrappers", () => {
    for (const source of [
      "<system-reminder><previous_response>private</system-reminder></previous_response>",
      "<system-reminder><previous_response>private",
      "<system-reminder><system-reminder>inner</system-reminder>OUTER_PRIVATE_SECRET",
      "<system-reminder><previous_response>inner</previous_response>OUTER_PRIVATE_SECRET",
      "<system-reminder><previous_response />OUTER_PRIVATE_SECRET",
      "<system-reminder>`</system-reminder>`OUTER_PRIVATE_SECRET",
      "<system-reminder>`prefix </system-reminder> suffix`OUTER_PRIVATE_SECRET",
      "<system-reminder>``prefix </system-reminder> suffix``OUTER_PRIVATE_SECRET",
      "<system-reminder>`prefix </previous_response> suffix`OUTER_PRIVATE_SECRET",
      "<system-reminder>```xml\n</previous_response>\n```\nOUTER_PRIVATE_SECRET",
      "<system-reminder data-x=<previous_response>>OUTER_PRIVATE_SECRET",
      "<system-reminder <previous_response>>OUTER_PRIVATE_SECRET",
      "<previous_response data-x=<system-reminder>>OUTER_PRIVATE_SECRET",
      "</previous_response data-x=<system-reminder>>OUTER_PRIVATE_SECRET",
      `<system-reminder data-x='>PRIVATE_UNTERMINATED_QUOTE</system-reminder>`,
      "<system-reminder><!-- </system-reminder> OUTER_PRIVATE_SECRET",
      "<system-reminder><! unfinished bogus declaration OUTER_PRIVATE_SECRET",
    ]) {
      expect(() => sanitizeFinal(source)).toThrow("iMessage outbound runtime markup is malformed");
    }
    expectRejected("<system-reminder>".repeat(33) + "private", "runtime markup exceeded its limit");
    expect(sanitizeFinal("<system-reminder>visible orphan").text).toBe("visible orphan");
  });

  it.each([
    "<system-reminder>`</system-reminder>`OUTER_PRIVATE_SECRET",
    "<system-reminder>`prefix </system-reminder> suffix`OUTER_PRIVATE_SECRET",
    "<system-reminder>``prefix </system-reminder> suffix``OUTER_PRIVATE_SECRET",
    "<previous_response>```xml\n</system-reminder>\n```\nOUTER_PRIVATE_SECRET",
  ])("fails closed when nested Markdown literals impersonate private owners", (malformed) => {
    for (const [wrapper, source] of [
      ["raw", malformed],
      ["inline", `\`${malformed}\``],
      ["fenced", `\`\`\`xml\n${malformed}\n\`\`\``],
      ["wide-fenced", `\`\`\`\`xml\n${malformed}\n\`\`\`\``],
    ] as const) {
      expect(() => sanitizeFinal(source), JSON.stringify({ malformed, wrapper, source })).toThrow(
        "iMessage outbound runtime markup is malformed",
      );
    }
  });

  it("reserves private-use glyphs from original hidden blocks before protecting real YAML roles", () => {
    const source = [
      "<system-reminder>\ue000</system-reminder>",
      "<previous_response>\ue001</previous_response>",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\ue002<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      "```yaml",
      "user:",
      "system:",
      "assistant:",
      "```",
    ].join("\n");
    const protection = protectRoles(source);

    expect(protection.text).toContain("\ue003".repeat("user".length));
    expect(protection.text).not.toMatch(/[\ue000-\ue002]/);
    const sanitized = sanitizeFinal(protection.text, { protection });
    for (const role of ["user", "system", "assistant"]) {
      expect(sanitized.text).toMatch(new RegExp(`^${role}:$`, "m"));
    }
    expect(sanitized.text).not.toMatch(/[\ue000-\uf8ff]/);
  });

  it("drops native style metadata when fenced assistant reasoning is exposed after formatting", () => {
    const sanitized = sanitizeFinal(
      ["```xml", "<thinking>hidden thought</thinking>", "```", "**😀 visible**"].join("\n"),
      { formatMarkdown: true },
    );

    expect(sanitized.text).not.toContain("hidden thought");
    expect(sanitized.text).toContain("😀 visible");
    expect(sanitized.ranges).toEqual([]);
  });

  it.each([
    { name: "fenced thinking", source: "```xml\n<thinking>hidden</thinking>\n```" },
    {
      name: "fenced memories",
      source: "```xml\n<relevant_memories>hidden</relevant_memories>\n```",
    },
    { name: "inline thinking", source: "`<thinking>hidden</thinking>`" },
    { name: "inline memories", source: "`<relevant-memories>hidden</relevant-memories>`" },
    { name: "unterminated fenced memories", source: "```xml\n<relevant_memories>hidden\n```" },
  ])("rejects $name instead of leaking private payload through raw Markdown", ({ source }) => {
    expectRejected(source, "hidden assistant content is not allowed");
  });

  it("recursively rejects assistant reasoning through multiple closed Markdown fence layers", () => {
    let nested = "<thinking>hidden nested thought</thinking>";
    for (let depth = 0; depth < 5; depth += 1) {
      const fence = "`".repeat(depth + 3);
      nested = `${fence}xml\n${nested}\n${fence}`;
    }

    expectRejected(nested, "hidden assistant content is not allowed");
    expectRejected(nested, "hidden assistant content is not allowed", { formatMarkdown: true });
  });

  it("fails closed when recursive Markdown unwrapping exceeds its security budget", () => {
    let nested = "safe but unreasonably nested";
    for (let depth = 0; depth < 80; depth += 1) {
      const fence = "`".repeat(depth + 3);
      nested = `${fence}xml\n${nested}\n${fence}`;
    }

    expectRejected(nested, "Markdown security projection exceeded its limit");
  });

  it("strips +#+#+#+# separator patterns", () => {
    const text = "NO_REPLY +#+#+#+#+#+ more internal stuff";
    expect(sanitizeOutboundText(text)).not.toContain("+#+#");
  });

  it("strips assistant to=final markers", () => {
    const text = "Some text assistant to=final more text";
    const result = sanitizeOutboundText(text);
    expect(result).not.toMatch(/assistant\s+to\s*=\s*final/i);
  });

  it("strips trailing role turn markers", () => {
    const text = "Hello\nassistant:\nuser:";
    const result = sanitizeOutboundText(text);
    expect(result).not.toMatch(/^assistant:$/m);
  });

  it("preserves prose lines that merely end with 'user:'/'system:'", () => {
    expect(sanitizeOutboundText("Please send this reply to the user:")).toBe(
      "Please send this reply to the user:",
    );
    expect(sanitizeOutboundText("Here is a note for the system:")).toBe(
      "Here is a note for the system:",
    );
  });

  it.each([
    [
      "backtick fence preserves user while stripping prose user",
      "user:\n```yaml\nuser:\n  name: alice\n```",
      "```yaml\nuser:\n  name: alice\n```",
    ],
    [
      "tilde fence preserves system while stripping prose system",
      "system:\n~~~yaml\nsystem:\n  enabled: true\n~~~",
      "~~~yaml\nsystem:\n  enabled: true\n~~~",
    ],
    [
      "closed fence preserves assistant while stripping prose assistant",
      "assistant:\n```yaml\nassistant:\n  enabled: true\n```",
      "```yaml\nassistant:\n  enabled: true\n```",
    ],
    [
      "unterminated fence never exposes internal marker families",
      [
        "#+#+#",
        "assistant to=final",
        "user:",
        "```text",
        "#+#+#",
        "assistant to=tool",
        "user:",
      ].join("\n"),
      "```text",
    ],
    [
      "longer matching closing fence preserves role mappings",
      "```yaml\nuser:\n  id: 1\n````",
      "```yaml\nuser:\n  id: 1\n````",
    ],
    [
      "three-space-indented fences preserve role mappings",
      "Example:\n   ```yaml\n   user:\n     id: 1\n   ```",
      "Example:\n   ```yaml\n   user:\n     id: 1\n   ```",
    ],
    [
      "CRLF fences preserve role mappings",
      "```yaml\r\nuser:\r\n  id: 1\r\n```",
      "```yaml\r\nuser:\r\n  id: 1\r\n```",
    ],
    [
      "closing fence whitespace preserves role mappings",
      "```yaml\nuser:\n  id: 1\n``` \t",
      "```yaml\nuser:\n  id: 1\n```",
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(sanitizeOutboundText(input)).toBe(expected);
  });

  it.each([
    ["an unterminated backtick fence", "```yaml\nuser:"],
    ["an unterminated tilde fence", "~~~yaml\nsystem:"],
    ["a mismatched closing fence", "```yaml\nassistant:\n~~~"],
    ["a shorter closing fence", "````yaml\nuser:\n```"],
    ["indented code", "    user:\n    enabled: true"],
    ["inline code", "prefix `user:` suffix"],
    ["multiline inline code", "prefix ```\nuser:\n``` suffix"],
    ["a midline opener", "prefix ```yaml\nuser:\n```"],
    ["a quoted fence", "> ```yaml\n> user:\n> ```"],
  ])("does not exempt role markers in %s", (_name, text) => {
    expect(sanitizeOutboundText(text)).not.toMatch(/^[ \t]*(?:user|system|assistant):\s*$/m);
  });

  it.each(["user", "system", "assistant"] as const)(
    "strips quoted %s role headers without removing quoted prose",
    (role) => {
      for (const prefix of ["> ", ">> ", "> > ", ">\t"]) {
        for (const closed of [false, true]) {
          const source = [
            `${prefix}\`\`\`yaml`,
            `${prefix}${role}:`,
            `${prefix}safe: value`,
            ...(closed ? [`${prefix}\`\`\``] : []),
          ].join("\n");
          const sanitized = sanitizeOutboundText(source);

          expect(sanitized).toContain(`${prefix}safe: value`);
          expect(sanitized).not.toMatch(
            /^[ \t]*(?:>[ \t]*)*(?:user|system|assistant)[ \t]*:[ \t]*$/gim,
          );
        }
      }
      expect(sanitizeOutboundText(`> Please reply to the ${role}:`)).toBe(
        `> Please reply to the ${role}:`,
      );
    },
  );

  it("preserves role provenance and remaps native UTF-16 styles after final scrubbing", () => {
    const source = "```yaml\nuser:\n  name: alice\n```";
    const protectedText = protectRoles(source);
    const token = protectedText.text.match(/[\ue000-\uf8ff]+/)?.[0];
    expect(token).toHaveLength("user".length);
    const hidden = "assistant:\n";
    const visible = `😀 ${token}:\n`;
    const sanitized = protectedText.sanitizeFormatted({
      text: hidden + visible,
      ranges: [
        { start: 0, length: "assistant".length, styles: ["bold"] },
        { start: hidden.length, length: 3, styles: ["italic"] },
      ],
    });

    expect(sanitized.text).toBe("\n😀 user:\n");
    expect(sanitized.ranges).toEqual([{ start: 1, length: 3, styles: ["italic"] }]);
    expect(sanitized.text).not.toMatch(/[\ue000-\uf8ff]/);
  });

  it("fails closed when formatted content forges an authenticated role marker", () => {
    const { protectedText, token } = protectedUserRole();

    expect(() =>
      protectedText.sanitizeFormatted({ text: `${token}:\n${token}:`, ranges: [] }),
    ).toThrow("iMessage outbound role protection failed");
  });

  it("rejects partial authenticated-marker glyphs before they can replace a removed role", () => {
    const { protectedText, token } = protectedUserRole();

    expect(() =>
      protectedText.sanitizeFormatted({
        text: `<thinking>${token}:</thinking>${token?.slice(0, 2)}<relevant_memories>hidden</relevant_memories>${token?.slice(2)}:`,
        ranges: [],
      }),
    ).toThrow("iMessage outbound role protection failed");
  });

  it("fails closed when marker removal assembles a second authenticated role token", () => {
    const { protectedText, token } = protectedUserRole();
    const splitToken = `${token?.slice(0, 2)}#+#+#${token?.slice(2)}`;

    expect(() =>
      protectedText.sanitizeFormatted({ text: `${token}:\n${splitToken}:`, ranges: [] }),
    ).toThrow("iMessage outbound role protection failed");
  });

  it("remaps native UTF-16 ranges across every private-marker removal pass", () => {
    const protectedText = protectRoles("safe");
    const disguised = "us#+#+#er:";
    const sanitized = protectedText.sanitizeFormatted({
      text: `${disguised}\n😀 styled`,
      ranges: [{ start: disguised.length + 1, length: "😀 styled".length, styles: ["bold"] }],
    });

    expect(sanitized.text).toBe("\n😀 styled");
    expect(sanitized.ranges).toEqual([{ start: 1, length: "😀 styled".length, styles: ["bold"] }]);
  });

  it("selects a distinct role marker when user content already contains private-use text", () => {
    const existing = "\ue000".repeat("user".length);
    const protectedText = protectRoles(["```yaml", "user:", "```", existing].join("\n"));
    const token = protectedText.text.split("\n")[1]?.match(/[\ue000-\uf8ff]+/)?.[0];

    expect(token).not.toBe(existing);
    expect(token).toHaveLength("user".length);
  });

  it("never chooses a protected glyph that already occurs as a user-authored partial marker", () => {
    const existing = "\ue000";
    const protectedText = protectRoles(["```yaml", "user:", "```", existing].join("\n"));

    expect(protectedText.text.split("\n")[1]).not.toContain(existing);
  });

  it("removes every private marker family after final Markdown rendering", () => {
    const protectedText = protectRoles("safe");
    const sanitized = protectedText.sanitizeFormatted({
      text: "assistant to=tool\n#+#+#\nUSER:\nVisible",
      ranges: [],
    });

    expect(sanitized.text).not.toMatch(/assistant\s+to\s*=\s*\w+|(?:#\+){2,}|^user:/gim);
    expect(sanitized.text).toContain("Visible");
  });

  it("keeps internal metadata stripped inside closed code fences", () => {
    const text = ["```text", "#+#+#", "assistant to=tool", "user:", "```"].join("\n");
    const result = sanitizeOutboundText(text);

    expect(result).toContain("user:");
    expect(result).not.toContain("#+#+#");
    expect(result).not.toContain("assistant to=tool");
  });

  it("strips prose roles while preserving adjacent closed-fence YAML keys", () => {
    const text = ["assistant:", "```yaml", "user:", "```", "system:"].join("\n");

    expect(sanitizeOutboundText(text)).toBe("```yaml\nuser:\n```");
  });

  it("keeps fenced roles aligned after earlier internal-marker removal", () => {
    const text = ["#+#+#", "assistant to=final", "```yaml", "user:", "  id: 1", "```"].join("\n");

    expect(sanitizeOutboundText(text)).toBe("```yaml\nuser:\n  id: 1\n```");
  });

  it("handles combined internal markers in one message", () => {
    const text = "<thinking>step 1</thinking>NO_REPLY +#+#+#+# assistant to=final\n\nActual reply";
    const result = sanitizeOutboundText(text);
    expect(result).not.toContain("<thinking>");
    expect(result).not.toContain("+#+#");
    expect(result).not.toMatch(/assistant to=final/i);
    expect(result).toContain("Actual reply");
  });
});
