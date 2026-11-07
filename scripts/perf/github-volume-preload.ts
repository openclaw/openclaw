// Recording loopback GitHub fixture for transcript-broadcast-measure --github-volume-observe.
// Source hooks label async request ancestry; no production diagnostics or real credentials.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!process.send) {
  throw new Error("GitHub volume measurement requires Gateway IPC");
}
const scope = new AsyncLocalStorage<string>();
const symbol = Symbol.for("openclaw.benchmark.github-volume");
Object.defineProperty(globalThis, symbol, { value: scope });
const owner = new URL("../../src/gateway/server-methods.ts", import.meta.url).href;
const prsOwner = new URL("../../src/gateway/control-ui-session-prs.ts", import.meta.url).href;
const override = process.env.OPENCLAW_BENCH_GITHUB_VOLUME_OWNER;
const selectedOwner = override ? pathToFileURL(resolve(override)).href : prsOwner;
if (dirname(fileURLToPath(selectedOwner)) !== dirname(fileURLToPath(prsOwner))) {
  throw new Error("GitHub volume owner override must be adjacent to source");
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    return result.url === prsOwner ? { ...result, url: selectedOwner } : result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url === selectedOwner && result.source != null) {
      const source =
        typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
      process.send?.({
        channel: "github-volume-owner",
        path: selectedOwner,
        sha256: createHash("sha256").update(source).digest("hex"),
      });
      const declaration = /\b(export\s+)?async\s+function\s+loadControlUiSessionPullRequests\s*\(/u;
      const match = declaration.exec(source);
      if (!match) {
        throw new Error("Missing session PR attribution boundary");
      }
      return {
        ...result,
        source:
          source.replace(declaration, "async function loadControlUiSessionPullRequestsObserved(") +
          `
${match[1] ? "export " : ""}function loadControlUiSessionPullRequests(...args) {
  const scope = globalThis[Symbol.for("openclaw.benchmark.github-volume")];
  return scope.run(scope.getStore() ?? "sessionPullRequests.background",
    () => loadControlUiSessionPullRequestsObserved(...args));
}
`,
      };
    }
    if (url !== owner || result.source == null) {
      return result;
    }
    const source =
      typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    const declaration = /\b(export\s+)?async\s+function\s+handleGatewayRequest\s*\(/u;
    const match = declaration.exec(source);
    if (!match) {
      throw new Error("Missing Gateway request attribution boundary");
    }
    return {
      ...result,
      source:
        source.replace(declaration, "async function handleGatewayRequestObserved(") +
        `
${match[1] ? "export " : ""}function handleGatewayRequest(...args) {
  return globalThis[Symbol.for("openclaw.benchmark.github-volume")].run(args[0].req.method,
    () => handleGatewayRequestObserved(...args));
}
`,
    };
  },
});

const port = Number(process.env.OPENCLAW_BENCH_GITHUB_VOLUME_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("GitHub volume measurement requires its loopback fixture port");
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (url.origin === "https://api.github.com") {
    const headers = new Headers(options?.headers);
    headers.set("x-benchmark-caller", scope.getStore() ?? "background");
    return nativeFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
      ...options,
      headers,
    });
  }
  if (url.hostname !== "127.0.0.1") {
    throw new Error("Benchmark blocked external fetch");
  }
  return nativeFetch(input, options);
};
