import { createHash } from "node:crypto";
import { SourceMap } from "node:module";
import { parse } from "@babel/parser";
import type { Node } from "@babel/types";
import type { Page } from "playwright";

type CounterName = "markdownRenders" | "toolFormats" | "diffAnalyses" | "parserRenders";
type Counts = Record<CounterName, number>;
type Target = { source: string; name: string; counter: CounterName; method?: boolean };
type OriginalTarget = Target & { line: number; column: number; endLine: number; endColumn: number };
type Transformation = { body: string; counters: CounterName[] };
type ProbeState = { errors: string[]; instrumented: Set<CounterName>; unmappedAssets: Set<string> };

const targets: Target[] = [
  {
    source: "ui/src/components/markdown.ts",
    name: "renderSanitizedMarkdown",
    counter: "markdownRenders",
  },
  {
    source: "ui/src/lib/chat/tool-output.ts",
    name: "formatToolOutput",
    counter: "toolFormats",
  },
  {
    source: "ui/src/pages/chat/components/chat-diff-highlight.runtime.ts",
    name: "analyzeDiffSyntax",
    counter: "diffAnalyses",
  },
];
const parserTarget: Target = {
  source: "markdown-it/dist/markdown-it.mjs",
  name: "render",
  counter: "parserRenders",
  method: true,
};
const states = new WeakMap<Page, ProbeState>();
// Different scenarios commonly fetch identical immutable production assets.
const transformed = new Map<string, Transformation>();

/** Babel's child dictionaries include non-node metadata and arrays. */
function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

function walk(node: Node, visit: (node: Node) => void) {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNode(child)) {
          walk(child, visit);
        }
      }
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function parserRenderMethod(node: Node) {
  if (
    node.type !== "VariableDeclarator" ||
    node.id.type !== "Identifier" ||
    node.id.name !== "MarkdownIt" ||
    node.init?.type !== "ClassExpression"
  ) {
    return undefined;
  }
  return node.init.body.body.find(
    (member) =>
      member.type === "ClassMethod" &&
      !member.computed &&
      member.key.type === "Identifier" &&
      member.key.name === "render",
  );
}

function originalTargets(map: SourceMap, selected: Target[]): OriginalTarget[] {
  const result: OriginalTarget[] = [];
  const payload = map.payload;
  for (const [index, source] of payload.sources.entries()) {
    const target = selected.find((entry) => source.replaceAll("\\", "/").endsWith(entry.source));
    if (!target) {
      continue;
    }
    const content = payload.sourcesContent?.[index];
    if (!content) {
      throw new Error(`Heavy count probe needs sourcesContent for ${target.source}`);
    }
    const ast = parse(content, { sourceType: "unambiguous", plugins: ["typescript"] });
    const found: OriginalTarget[] = [];
    walk(ast, (node) => {
      const fn = target.method ? parserRenderMethod(node) : node;
      if (
        fn &&
        ((!target.method && fn.type === "FunctionDeclaration" && fn.id?.name === target.name) ||
          (target.method && fn.type === "ClassMethod")) &&
        (fn.type === "FunctionDeclaration" || fn.type === "ClassMethod") &&
        fn.loc &&
        fn.body.loc
      ) {
        found.push({
          ...target,
          // Function headers identify the owner without accidentally matching nested callbacks.
          line: fn.loc.start.line - 1,
          column: fn.loc.start.column,
          endLine: fn.body.loc.start.line - 1,
          endColumn: fn.body.loc.start.column,
        });
      }
    });
    if (found.length !== 1) {
      throw new Error(
        `Heavy count probe expected one ${target.source}:${target.name}, found ${found.length}`,
      );
    }
    result.push(...found);
  }
  return result;
}

function transform(body: string, mapText: string, selected: Target[]): Transformation {
  const key = createHash("sha256")
    .update(body)
    .update("\0")
    .update(mapText)
    .update(selected.map((target) => target.counter).join(","))
    .digest("hex");
  const cached = transformed.get(key);
  if (cached) {
    return cached;
  }
  const map = new SourceMap(JSON.parse(mapText));
  const originals = originalTargets(map, selected);
  const insertions: { offset: number; counter: CounterName }[] = [];
  if (originals.length) {
    walk(parse(body, { sourceType: "module" }), (node) => {
      if (node.type !== "FunctionDeclaration" && node.type !== "ClassMethod") {
        return;
      }
      const position =
        (node.type === "ClassMethod" ? node.key.loc?.start : node.id?.loc?.start) ??
        node.loc?.start;
      if (!position) {
        return;
      }
      const origin = map.findEntry(position.line - 1, position.column);
      if (!("originalSource" in origin) || typeof origin.originalSource !== "string") {
        return;
      }
      const target = originals.find(
        (entry) =>
          origin.originalSource.replaceAll("\\", "/").endsWith(entry.source) &&
          (origin.originalLine > entry.line ||
            (origin.originalLine === entry.line && origin.originalColumn >= entry.column)) &&
          (origin.originalLine < entry.endLine ||
            (origin.originalLine === entry.endLine && origin.originalColumn <= entry.endColumn)) &&
          (entry.method ? node.type === "ClassMethod" : node.type === "FunctionDeclaration"),
      );
      if (!target) {
        return;
      }
      const offset =
        node.body.directives.at(-1)?.end ??
        (node.body.start === null || node.body.start === undefined
          ? undefined
          : node.body.start + 1);
      if (offset === undefined || offset === null) {
        throw new Error(`Heavy count probe has no insertion offset for ${target.name}`);
      }
      insertions.push({ offset, counter: target.counter });
    });
    for (const target of originals) {
      const matches = insertions.filter((entry) => entry.counter === target.counter).length;
      if (matches !== 1) {
        throw new Error(
          `Heavy count probe mapped ${target.source}:${target.name} to ${matches} generated functions`,
        );
      }
    }
  }
  let output = body;
  for (const insertion of insertions.toSorted((left, right) => right.offset - left.offset)) {
    output = `${output.slice(0, insertion.offset)};window.heavyContentEntryCounts.${insertion.counter}++;${output.slice(insertion.offset)}`;
  }
  const result = { body: output, counters: insertions.map((entry) => entry.counter) };
  transformed.set(key, result);
  return result;
}

declare global {
  interface Window {
    heavyContentEntryCounts: Counts;
  }
}

/** Diagnostic only: route interception disables HTTP caching and alters generated code. */
export async function installHeavyCountProbe(
  page: Page,
  options: { markdownParserRender?: boolean } = {},
): Promise<void> {
  if (states.has(page)) {
    throw new Error("Heavy count probe is already installed on this page");
  }
  const state: ProbeState = { errors: [], instrumented: new Set(), unmappedAssets: new Set() };
  states.set(page, state);
  const selected = options.markdownParserRender ? [...targets, parserTarget] : targets;
  await page.addInitScript(() => {
    window.heavyContentEntryCounts = {
      markdownRenders: 0,
      toolFormats: 0,
      diffAnalyses: 0,
      parserRenders: 0,
    };
  });
  await page.route("**/assets/*.js", async (route) => {
    try {
      const response = await route.fetch();
      if (!response.ok()) {
        throw new Error(
          `Heavy count probe asset fetch failed: ${response.status()} ${route.request().url()}`,
        );
      }
      const body = await response.text();
      const reference = [...body.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/gu)].at(-1)?.[1];
      // Release builds can omit the comment while still emitting hidden source maps.
      const mapUrl = new URL(
        reference ?? `${new URL(route.request().url()).pathname}.map`,
        route.request().url(),
      );
      const mapResponse = await page.request.get(mapUrl.href);
      if (!reference && mapResponse.status() === 404) {
        // Rolldown's runtime and generated locale modules have no source maps.
        state.unmappedAssets.add(new URL(route.request().url()).pathname);
        await route.fulfill({ response });
        return;
      }
      if (!mapResponse.ok()) {
        throw new Error(
          `Heavy count probe source map fetch failed: ${mapResponse.status()} ${mapUrl.href}`,
        );
      }
      const result = transform(body, await mapResponse.text(), selected);
      for (const counter of result.counters) {
        state.instrumented.add(counter);
      }
      await route.fulfill({ response, body: result.body });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.errors.push(message);
      console.error(`[heavy-count-probe] ${message}`);
      await route.abort("failed");
    }
  });
}

export async function readHeavyCountProbe(page: Page) {
  const state = states.get(page);
  if (!state) {
    throw new Error("Heavy count probe was not installed on this page");
  }
  if (state.errors.length) {
    throw new Error(state.errors.join("\n"));
  }
  const counts = await page.evaluate(() => window.heavyContentEntryCounts);
  if (!counts) {
    throw new Error("Heavy count probe initialization did not run");
  }
  return {
    counts,
    instrumented: [...state.instrumented].toSorted(),
    unmappedAssets: [...state.unmappedAssets].toSorted(),
  };
}
