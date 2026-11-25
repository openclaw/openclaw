import { AsyncLocalStorage } from "node:async_hooks";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread, threadId } from "node:worker_threads";
import type { ArrowFunction, FunctionDeclaration, Node } from "typescript/ast";

const handlersUrl = new URL("../../src/state/openclaw-state-read-handlers.ts", import.meta.url)
  .href;
const handlersOverride = process.env.OPENCLAW_BENCH_GITHUB_STATE_HANDLERS;
const selectedHandlersUrl = handlersOverride
  ? pathToFileURL(resolve(handlersOverride)).href
  : handlersUrl;
if (dirname(fileURLToPath(selectedHandlersUrl)) !== dirname(fileURLToPath(handlersUrl))) {
  throw new Error("GitHub state handler override must be adjacent to its source owner");
}
const publicationReaderUrl = new URL(
  "../../src/state/github-publication.read.worker.ts",
  import.meta.url,
).href;
const readerOverride = process.env.OPENCLAW_BENCH_GITHUB_PUBLICATION_READER;
const selectedReaderUrl = readerOverride
  ? pathToFileURL(resolve(readerOverride)).href
  : publicationReaderUrl;
if (dirname(fileURLToPath(selectedReaderUrl)) !== dirname(fileURLToPath(publicationReaderUrl))) {
  throw new Error("GitHub publication reader override must be adjacent to its source owner");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url === handlersUrl) {
      return { ...result, url: selectedHandlersUrl };
    }
    return result.url === publicationReaderUrl ? { ...result, url: selectedReaderUrl } : result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (
      url !== new URL("../../src/infra/runtime-worker-url.ts", import.meta.url).href ||
      result.source == null
    ) {
      return result;
    }
    const source =
      typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    const original =
      /\[\s*["']--import["']\s*,\s*import\.meta\.resolve\(\s*["']tsx\/esm["']\s*\)\s*\]/u;
    if (!original.test(source)) {
      throw new Error("Missing shared-state worker preload measurement boundary");
    }
    return {
      ...result,
      source: source.replace(
        original,
        `["--import", import.meta.resolve("tsx/esm"), "--import", ${JSON.stringify(import.meta.url)}]`,
      ),
    };
  },
});

if (!isMainThread) {
  const workerUrl = new URL("../../src/state/openclaw-state-read.worker.ts", import.meta.url).href;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== workerUrl || result.source == null) {
        return result;
      }
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      const original = /await\s+import\(\s*["']\.\/openclaw-state-read-handlers\.js["']\s*\)/u;
      if (!original.test(source)) {
        throw new Error("Missing shared-state fallback import measurement boundary");
      }
      return {
        ...result,
        source: source.replace(
          original,
          `await (async () => {
            const started = performance.now();
            try { return await import("./openclaw-state-read-handlers.js"); }
            finally {
              const durationMs = performance.now() - started;
              if (durationMs >= 10) console.error("GITHUB_RECEIPT_IMPORT " + JSON.stringify({
                threadId: ${threadId}, command: input.command.type,
                module: ${JSON.stringify(selectedHandlersUrl)},
                startedAtEpochMs: performance.timeOrigin + started, durationMs
              }));
            }
          })()`,
        ),
      };
    },
  });
}

// Benchmark IPC only: no source changes, credentials, or request contents are recorded.
if (isMainThread) {
  if (!process.send) {
    throw new Error("GitHub options measurement requires the benchmark IPC channel");
  }
  const typescript = await import("typescript/ast");
  const { API } = await import("typescript/sync");
  const scope = new AsyncLocalStorage<number>();
  let nextRequest = 0;
  const recordStage = (request: number, phase: string, started: number) => {
    process.send?.({
      channel: "github-options-stage",
      request,
      phase,
      startedAtEpochMs: performance.timeOrigin + started,
      durationMs: performance.now() - started,
    });
  };
  const tracker = {
    run<T>(body: () => Promise<T>): Promise<T> {
      return scope.run(++nextRequest, () => tracker.measure("handler", body));
    },
    async measure<T>(phase: string, body: () => Promise<T>): Promise<T> {
      const request = scope.getStore();
      if (request === undefined) {
        return body();
      }
      const started = performance.now();
      try {
        return await body();
      } finally {
        recordStage(request, phase, started);
      }
    },
    measureSync<T>(phase: string, body: () => T): T {
      const request = scope.getStore();
      if (request === undefined) {
        return body();
      }
      const started = performance.now();
      try {
        return body();
      } finally {
        recordStage(request, phase, started);
      }
    },
  };
  const symbol = "openclaw.benchmark.github-options";
  Object.defineProperty(globalThis, Symbol.for(symbol), { value: tracker });
  const access = `globalThis[Symbol.for(${JSON.stringify(symbol)})]`;
  const sourceUrl = (file: string) => new URL(`../../src/${file}`, import.meta.url).href;
  const ownerUrl = sourceUrl("gateway/github-publication-shared-read.ts");
  const override = process.env.OPENCLAW_BENCH_GITHUB_OBSERVATION_OWNER;
  const selectedOwnerUrl = override ? pathToFileURL(resolve(override)).href : ownerUrl;
  if (dirname(fileURLToPath(selectedOwnerUrl)) !== dirname(fileURLToPath(ownerUrl))) {
    throw new Error("GitHub observation override must be adjacent to its source owner");
  }
  const availabilityOwnerUrl = sourceUrl("gateway/github-publication-availability.ts");
  const availabilityOverride = process.env.OPENCLAW_BENCH_GITHUB_AVAILABILITY_OWNER;
  const selectedAvailabilityUrl = availabilityOverride
    ? pathToFileURL(resolve(availabilityOverride)).href
    : availabilityOwnerUrl;
  if (
    dirname(fileURLToPath(selectedAvailabilityUrl)) !== dirname(fileURLToPath(availabilityOwnerUrl))
  ) {
    throw new Error("GitHub availability override must be adjacent to its source owner");
  }
  const targets = new Map<string, Record<string, string>>([
    [
      sourceUrl("gateway/server-methods/sessions-github.ts"),
      { "sessions.github.options": "handler" },
    ],
    [
      sourceUrl("gateway/server-methods/github-personal-authorization.ts"),
      {
        prepareGitHubPublicationOptionsRead: "admission",
        prepareOptionsSession: "session-preparation",
      },
    ],
    [
      selectedAvailabilityUrl,
      {
        prepareCurrentGitHubPublicationOptionsIdentity: "identity",
        qualifyGitHubPublicationSource: "target",
        prepareGitHubPublicationSession: "publication-session",
      },
    ],
    [sourceUrl("agents/github-read-identity.ts"), { readNativeGitHubToken: "native-token" }],
    [
      sourceUrl("agents/github-oauth-client.ts"),
      { verifyGitHubCredential: "credential-verification" },
    ],
    [selectedOwnerUrl, { readSharedGitHubPublication: "receipt" }],
    [
      sourceUrl("state/openclaw-state-read-operation.ts"),
      { run: "state-read-source", query: "state-read-query" },
    ],
    [sourceUrl("gateway/serialized-json.ts"), { serializeGatewayFrame: "serialization" }],
  ]);
  let ownerLoaded = false;
  let availabilityLoaded = false;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url === availabilityOwnerUrl) {
        return { ...result, url: selectedAvailabilityUrl };
      }
      return result.url === ownerUrl ? { ...result, url: selectedOwnerUrl } : result;
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const expected = targets.get(url);
      if (!expected) {
        return result;
      }
      if (result.source == null) {
        throw new Error(`GitHub options measurement requires source: ${url}`);
      }
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      using parser = new API();
      using parsed = parser.createSourceFile(fileURLToPath(url), source);
      const tree = parsed.sourceFile;
      const edits: { start: number; end: number; text: string }[] = [];
      const seen = new Set<string>();
      const wrap = (name: string, node: FunctionDeclaration | ArrowFunction) => {
        const body = node.body;
        const synchronous = expected[name] === "serialization";
        const isAsync = Boolean(
          node.modifiers?.some((modifier) => modifier.kind === typescript.SyntaxKind.AsyncKeyword),
        );
        if (
          seen.has(name) ||
          !body ||
          !typescript.isBlock(body) ||
          node.asteriskToken ||
          isAsync === synchronous
        ) {
          throw new Error(`Unexpected GitHub options measurement shape: ${name} in ${url}`);
        }
        seen.add(name);
        const call =
          name === "sessions.github.options"
            ? "run("
            : `${synchronous ? "measureSync" : "measure"}(${JSON.stringify(expected[name])}, `;
        edits.push({
          start: body.getStart(tree),
          end: body.end,
          text: `{ return ${access}.${call}${synchronous ? "" : "async "}() => ${source.slice(body.getStart(tree), body.end)}); }`,
        });
      };
      const visit = (node: Node) => {
        if (typescript.isFunctionDeclaration(node) && node.name && expected[node.name.text]) {
          wrap(node.name.text, node);
        } else if (
          typescript.isPropertyAssignment(node) &&
          typescript.isStringLiteral(node.name) &&
          node.name.text === "sessions.github.options" &&
          typescript.isCallExpression(node.initializer)
        ) {
          const call = node.initializer;
          const handler = call.arguments.at(-1);
          if (
            !typescript.isIdentifier(call.expression) ||
            call.expression.text !== "defineSessionGitHubMethod" ||
            !handler ||
            !typescript.isArrowFunction(handler)
          ) {
            throw new Error(`Unexpected GitHub options handler shape: ${url}`);
          }
          wrap(node.name.text, handler);
        }
        node.forEachChild(visit);
      };
      visit(tree);
      for (const name of Object.keys(expected)) {
        if (!seen.has(name)) {
          throw new Error(`Missing GitHub options measurement function: ${name} in ${url}`);
        }
      }
      let transformed = source;
      for (const edit of edits.toSorted((left, right) => right.start - left.start)) {
        transformed = transformed.slice(0, edit.start) + edit.text + transformed.slice(edit.end);
      }
      if (url === selectedOwnerUrl && !ownerLoaded) {
        ownerLoaded = true;
        process.send?.({
          channel: "github-options-owner-loaded",
          path: fileURLToPath(url),
          override: Boolean(override),
        });
      }
      if (url === selectedAvailabilityUrl && !availabilityLoaded) {
        availabilityLoaded = true;
        process.send?.({
          channel: "github-options-availability-loaded",
          path: fileURLToPath(url),
          override: Boolean(availabilityOverride),
        });
      }
      return { ...result, source: transformed };
    },
  });
}
