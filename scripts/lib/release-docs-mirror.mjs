import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDocsMarkdown, parseAttrs, parseFrontmatter } from "./docs-markdown.mjs";
import { changelogEntryPath } from "./release-changelog.mjs";

const releaseDocsMirrorMarker = "openclaw-docs-mirror-v1";
const markdown = createDocsMarkdown({ html: false });
const callouts = new Set(["Note", "Warning", "Tip", "Info", "Check", "Say", "Banner", "Update"]);
const wrappers = new Set(["AccordionGroup", "Accordion", "details", ...callouts]);

function requireVersion(version) {
  if (
    typeof version !== "string" ||
    version === "Unreleased" ||
    changelogEntryPath(version) !== `CHANGELOG/${version}.md`
  ) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

function requireSources(sources) {
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length) {
    throw new Error("Mirror sources must be a nonempty ordered list without duplicates");
  }
  for (const source of sources) {
    if (
      typeof source !== "string" ||
      !/^docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?$/.test(source) ||
      source.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error(`Invalid docs source path: ${source}`);
    }
  }
}

function readSources(rootDir, sources) {
  requireSources(sources);
  const root = fs.realpathSync(rootDir);
  return sources.map((source) => {
    const target = fs.realpathSync(path.join(root, source));
    if (!target.startsWith(`${root}${path.sep}`) || !fs.statSync(target).isFile()) {
      throw new Error(`Docs source escapes the repository or is not a file: ${source}`);
    }
    const bytes = fs.readFileSync(target);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { source, bytes, text };
  });
}

// Length framing binds exact bytes and order, independently of platform newlines.
// The marker records provenance only: it is never publication or editorial approval.
function releaseDocsSourceDigest(entries) {
  const digest = createHash("sha256").update(`${releaseDocsMirrorMarker}\0`);
  for (const { source, bytes } of entries) {
    digest.update(`${source}\0${bytes.length}\0`).update(bytes).update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
}

function docsUrl(href, source) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href;
  }
  const route = source
    .replace(/^docs\//, "/")
    .replace(/\.mdx?$/, "")
    .replace(/\/index$/, "/");
  const url = new URL(href, `https://docs.openclaw.ai${route}`);
  url.pathname = url.pathname.replace(/\.mdx?$/, "").replace(/\/index$/, "/");
  return url.href;
}

// CommonMark identifies code before any source edits. Inline code is held as well;
// source prose and Markdown syntax are otherwise retained instead of reserialized.
function holdInlineCode(line) {
  const held = [];
  let prefix = "OPENCLAWMIRRORLITERAL";
  while (line.includes(prefix)) {
    prefix += "X";
  }
  let result = "";
  const hold = (value) =>
    value
      .split("\n")
      .map((part) => {
        const placeholder = `${prefix}${held.length}END`;
        held.push(part);
        return placeholder;
      })
      .join("\n");
  for (let i = 0; i < line.length;) {
    if (line.startsWith("<!--", i)) {
      const end = line.indexOf("-->", i + 4);
      if (end < 0) {
        throw new Error("Unterminated HTML comment");
      }
      result += hold(line.slice(i, end + 3));
      i = end + 3;
      continue;
    }
    if (line[i] === "\\") {
      result += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (line[i] !== "`") {
      result += line[i++];
      continue;
    }
    const run = /^`+/.exec(line.slice(i))[0];
    let end = i + run.length;
    while ((end = line.indexOf(run, end)) !== -1) {
      if (line[end - 1] !== "`" && line[end + run.length] !== "`") {
        break;
      }
      end += run.length;
    }
    if (end === -1) {
      result += run;
      i += run.length;
    } else {
      result += hold(line.slice(i, end + run.length));
      i = end + run.length;
    }
  }
  return {
    text: result,
    restore: (value) =>
      value.replace(new RegExp(`${prefix}(\\d+)END`, "g"), (_, index) => held[Number(index)]),
  };
}

function expandLinks(text, source) {
  const edits = [];
  const replaceDestination = (start, inline = false) => {
    const result = markdown.helpers.parseLinkDestination(text, start, text.length);
    if (!result.ok || !result.str) {
      return;
    }
    if (inline) {
      let end = result.pos;
      while (end < text.length && /\s/.test(text[end])) {
        end++;
      }
      if (text[end] !== ")") {
        const title = markdown.helpers.parseLinkTitle(text, end, text.length);
        if (!title.ok) {
          return;
        }
        end = title.pos;
        while (end < text.length && /\s/.test(text[end])) {
          end++;
        }
        if (text[end] !== ")") {
          return;
        }
      }
    }
    const href = docsUrl(result.str, source);
    if (href !== result.str) {
      const enclosed = text[start] === "<";
      edits.push({
        start,
        end: result.pos,
        value: enclosed ? `<${href}>` : href.replaceAll("(", "%28").replaceAll(")", "%29"),
      });
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
    } else if (text[i] === "]" && text[i + 1] === "(") {
      let start = i + 2;
      while (/\s/.test(text[start] ?? "") && start < text.length) {
        start++;
      }
      replaceDestination(start, true);
    }
  }
  for (const reference of text.matchAll(/^ {0,3}\[(?:[^\\\]]|\\.)+\]:\s*/gm)) {
    replaceDestination(reference.index + reference[0].length);
  }
  let expanded = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    expanded = expanded.slice(0, edit.start) + edit.value + expanded.slice(edit.end);
  }
  return expanded;
}

export function flattenReleaseDocs(sourceText, source) {
  const { data, content } = parseFrontmatter(sourceText);
  if (
    /^---[ \t]*\r?\n/.test(sourceText.replace(/^\uFEFF/, "")) &&
    !/^---[ \t]*\r?\n[\s\S]*?\r?\n---(?:[ \t]*\r?\n|[ \t]*$)/.test(
      sourceText.replace(/^\uFEFF/, ""),
    )
  ) {
    throw new Error(`${source}: unterminated frontmatter`);
  }
  const lines = content.split("\n");
  const codeLines = new Set();
  const tokens = markdown.parse(content, {});
  for (const token of tokens) {
    if (["fence", "code_block"].includes(token.type)) {
      for (let line = token.map[0]; line < token.map[1]; line++) {
        codeLines.add(line);
      }
    }
  }
  const output = [];
  const literal = holdInlineCode(
    lines.map((line, index) => (codeLines.has(index) ? "" : line)).join("\n"),
  );
  const protectedLines = expandLinks(literal.text, source).split("\n");
  let heading = 3;
  const stack = [];
  const quote = (line) =>
    `${"> ".repeat(stack.filter((entry) => callouts.has(entry.name)).length)}${line}`;
  const fail = (line, reason) => {
    throw new Error(`${source}:${line + 1}: ${reason}`);
  };
  if (!tokens.some((token) => token.type === "heading_open" && token.tag === "h1")) {
    if (typeof data.title !== "string" || !data.title.trim() || /[\r\n]/.test(data.title)) {
      throw new Error(`${source}: docs page needs a title or H1`);
    }
    output.push(`### ${data.title}`, "");
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (codeLines.has(index)) {
      output.push(quote(line));
      continue;
    }
    let text = protectedLines[index];
    const tag = /^\s*<(\/)?([A-Za-z][A-Za-z0-9]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>\s*$/.exec(text);
    const summary = /^\s*<summary>(.*?)<\/summary>\s*$/.exec(text);
    if (summary) {
      if (stack.at(-1)?.name !== "details") {
        fail(index, "summary outside details");
      }
      output.push(
        "",
        quote(
          `${"#".repeat(Math.min(6, heading + 1))} ${literal.restore(expandLinks(summary[1], source))}`,
        ),
        "",
      );
      continue;
    }
    if (tag && wrappers.has(tag[2])) {
      const [, closing, name, rawAttrs] = tag;
      if (closing) {
        if (stack.at(-1)?.name !== name || rawAttrs.trim()) {
          fail(index, `unbalanced ${name} wrapper`);
        }
        heading = stack.pop().heading;
      } else {
        if (rawAttrs.trim().endsWith("/")) {
          fail(index, `self-closing ${name} is unsupported`);
        }
        const attrs = parseAttrs(literal.restore(rawAttrs));
        if (/[{}]/.test(rawAttrs.replace(/"[^"]*"|'[^']*'/g, ""))) {
          fail(index, `dynamic ${name} attributes are unsupported`);
        }
        const allowed =
          name === "Accordion"
            ? ["title", "id", "defaultOpen", "icon"]
            : name === "details"
              ? ["class", "open", "id"]
              : [];
        if (Object.keys(attrs).some((key) => !allowed.includes(key))) {
          fail(index, `unsupported ${name} attribute`);
        }
        stack.push({ name, heading });
        if (name === "Accordion") {
          if (!attrs.title || /[\r\n]/.test(attrs.title)) {
            fail(index, "Accordion needs a literal title");
          }
          heading = Math.min(6, heading + 1);
          const title = holdInlineCode(attrs.title);
          output.push(
            "",
            quote(`${"#".repeat(heading)} ${title.restore(expandLinks(title.text, source))}`),
          );
        } else if (callouts.has(name)) {
          output.push("", quote(`**${name}**`));
        }
      }
      output.push(quote(""));
      continue;
    }
    if (/^\s*(?:import|export)\s|\{\/\*/.test(text)) {
      fail(index, "unsupported executable MDX construct");
    }
    // Native inline HTML is retained; URL attributes become portable as well.
    text = expandLinks(text, source);
    text = text.replace(
      /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>/g,
      (match, closing, name, attrs) => {
        if (
          ![
            "a",
            "img",
            "br",
            "em",
            "strong",
            "b",
            "i",
            "del",
            "sup",
            "sub",
            "kbd",
            "s",
            "span",
          ].includes(name)
        ) {
          fail(index, `unsupported or non-standalone <${name}> construct`);
        }
        return `<${closing}${name}${attrs.replace(/\b(href|src)=(['"])(.*?)\2/g, (_, key, delimiter, value) => `${key}=${delimiter}${docsUrl(markdown.utils.unescapeAll(value), source)}${delimiter}`)}>`;
      },
    );
    if (/<\/?(?:[A-Z][A-Za-z0-9_.-]*|details|summary)(?=[\s/>]|$)/.test(text)) {
      fail(index, "unsupported multiline or inline component");
    }
    const title = /^(#{1,6})(\s+.*)$/.exec(text);
    if (title) {
      heading = Math.min(6, title[1].length + 2);
      text = `${"#".repeat(heading)}${title[2]}`;
    }
    output.push(quote(literal.restore(text)));
  }
  if (stack.length) {
    throw new Error(`${source}: unclosed ${stack.at(-1).name} wrapper`);
  }
  return `${output.join("\n")}\n`;
}

export function renderReleaseDocsMirror({ rootDir, version, sources }) {
  requireVersion(version);
  const entries = readSources(rootDir, sources);
  const metadata = { version, sources, sourceDigest: releaseDocsSourceDigest(entries) };
  const body = entries.map(({ source, text }) => flattenReleaseDocs(text, source)).join("\n");
  return `<!-- ${releaseDocsMirrorMarker} ${JSON.stringify(metadata)} -->\n\n## ${version}\n\n${body}`;
}

export function parseReleaseDocsMirror(text) {
  if (!text.startsWith("<!-- openclaw-docs-mirror")) {
    if (text.includes("<!-- openclaw-docs-mirror")) {
      throw new Error("Docs mirror marker must be the first line");
    }
    return undefined;
  }
  const match = /^<!-- openclaw-docs-mirror-v1 (\{[^\n]*\}) -->\n/.exec(text);
  if (!match) {
    throw new Error("Unknown or invalid docs mirror marker");
  }
  const metadata = JSON.parse(match[1]);
  if (
    Object.keys(metadata).toSorted().join(",") !== "sourceDigest,sources,version" ||
    !/^sha256:[a-f0-9]{64}$/.test(metadata.sourceDigest)
  ) {
    throw new Error("Invalid docs mirror metadata");
  }
  requireVersion(metadata.version);
  requireSources(metadata.sources);
  return metadata;
}

export function checkReleaseDocsMirrors({ rootDir, version }) {
  if (version !== undefined) {
    requireVersion(version);
  }
  const directory = path.join(rootDir, "CHANGELOG");
  const files = version
    ? [`${version}.md`]
    : fs.existsSync(directory)
      ? fs
          .readdirSync(directory)
          .filter((name) => name.endsWith(".md"))
          .toSorted()
      : [];
  const checked = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(directory, file), "utf8");
    const metadata = parseReleaseDocsMirror(text);
    if (!metadata) {
      continue;
    }
    if (file !== `${metadata.version}.md`) {
      throw new Error(`${file}: mirror version does not match filename`);
    }
    if (text !== renderReleaseDocsMirror({ rootDir, ...metadata })) {
      throw new Error(`${file}: docs mirror is stale or differs from its sources; regenerate it`);
    }
    checked.push(metadata.version);
  }
  return checked;
}
