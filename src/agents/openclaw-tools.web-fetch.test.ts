import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as secretsState from "../secrets/runtime-state.js";
import { createOpenClawCodingToolsAsync } from "./agent-tools.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import * as privateTempFiles from "./sessions/tools/private-temp-file.js";
import type { WebFetchTransport } from "./tools/web-fetch-transport.js";

const spillPaths = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([...spillPaths].map((path) => rm(path, { force: true })));
  spillPaths.clear();
});

async function assemble(webFetchTransport: WebFetchTransport, config: OpenClawConfig = {}) {
  return createOpenClawCodingToolsAsync({
    config: {
      ...config,
      tools: { ...config.tools, web: { ...config.tools?.web, search: { enabled: false } } },
    },
    disableMessageTool: true,
    wrapBeforeToolCallHook: false,
    authProfileStore: { version: 1, profiles: {} },
    webFetchTransport,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  } satisfies OpenClawCodingToolsOptions);
}

function hostTransport(): WebFetchTransport {
  return {
    assertInvocationCurrent: () => {},
    acquire: vi.fn<WebFetchTransport["acquire"]>(async (request) => ({
      response: new Response('{"source":"host"}', {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: request.url,
      release: async () => {},
    })),
  };
}

function detailsOf(result: { details?: unknown }): Record<string, unknown> {
  assert(result.details && typeof result.details === "object" && !Array.isArray(result.details));
  const details = result.details as Record<string, unknown>;
  const spill = details.spill;
  if (spill && typeof spill === "object" && !Array.isArray(spill)) {
    const path = (spill as Record<string, unknown>).path;
    if (typeof path === "string") {
      spillPaths.add(path);
    }
  }
  return details;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("web_fetch transport through native coding-tool assembly", () => {
  it("binds one native tool and honors runtime disable/re-enable before cache reuse", async () => {
    const transport = hostTransport();
    const tools = await assemble(transport);
    const fetchTools = tools.filter((tool) => tool.name === "web_fetch");
    expect(fetchTools).toHaveLength(1);
    const tool = fetchTools[0];
    assert(tool);
    const args = { url: "https://example.com/assembled-host" };
    const first = await tool.execute("first", args);
    expect(first.details).toMatchObject({
      extractor: "json",
      externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
      text: expect.stringContaining('"source": "host"'),
    });
    const config: OpenClawConfig = { tools: { web: { fetch: { enabled: false } } } };
    const snapshot = vi
      .spyOn(secretsState, "getActiveSecretsRuntimeConfigSnapshot")
      .mockReturnValue({
        config,
        sourceConfig: config,
        configRefsPrepared: true,
      });
    await expect(tool.execute("disabled", args)).rejects.toThrow("web_fetch is disabled");
    snapshot.mockRestore();
    expect((await tool.execute("enabled", args)).details).toMatchObject({ cached: true });
    expect(transport.acquire).toHaveBeenCalledTimes(1);
  });

  it("uses a real host adapter for allowed dispatch and blocks denied redirects before fallback", async () => {
    let allowedHits = 0;
    let deniedHits = 0;
    let deniedOrigin = "";
    const allowedServer = createServer((request, response) => {
      allowedHits += 1;
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `${deniedOrigin}/secret` });
        response.end();
        return;
      }
      expect(request.headers["x-route"]).toBe("real-adapter-proof");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("allowed real adapter content");
    });
    const deniedServer = createServer((_request, response) => {
      deniedHits += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("denied origin content");
    });
    try {
      const [allowedOrigin, deniedUrl] = await Promise.all([
        listen(allowedServer),
        listen(deniedServer),
      ]);
      deniedOrigin = deniedUrl;
      const allowedOrigins = new Set([allowedOrigin]);
      const transport: WebFetchTransport = {
        assertInvocationCurrent: vi.fn(() => {}),
        acquire: vi.fn<WebFetchTransport["acquire"]>(async (request) => {
          const admit = (candidate: string, reason: "destination" | "redirect") => {
            if (!allowedOrigins.has(new URL(candidate).origin)) {
              throw new Error(`host policy refused ${reason}`);
            }
          };
          let nextUrl = request.url;
          let remainingRedirects = request.maxRedirects;
          for (;;) {
            transport.assertInvocationCurrent();
            admit(nextUrl, "destination");
            const response = await fetch(nextUrl, {
              headers: request.init.headers,
              method: request.init.method,
              redirect: "manual",
              signal: request.signal,
            });
            transport.assertInvocationCurrent();
            if (response.status < 300 || response.status >= 400) {
              return {
                response,
                finalUrl: nextUrl,
                release: async () => {},
              };
            }
            if (remainingRedirects <= 0) {
              throw new Error("host policy refused redirect");
            }
            const location = response.headers.get("location");
            if (!location) {
              throw new Error("host redirect missing location");
            }
            const redirected = new URL(location, nextUrl).href;
            admit(redirected, "redirect");
            nextUrl = redirected;
            remainingRedirects -= 1;
          }
        }),
      };
      const [tool] = (
        await assemble(transport, {
          tools: { web: { fetch: { headers: { "X-Route": "real-adapter-proof" } } } },
        })
      ).filter((entry) => entry.name === "web_fetch");
      assert(tool);

      expect(
        detailsOf(await tool.execute("real-allowed", { url: `${allowedOrigin}/ok` })),
      ).toMatchObject({
        finalUrl: `${allowedOrigin}/ok`,
        text: expect.stringContaining("allowed real adapter content"),
      });
      await expect(
        tool.execute("real-denied-destination", { url: `${deniedOrigin}/secret` }),
      ).rejects.toThrow("host policy refused destination");
      await expect(
        tool.execute("real-denied-redirect", { url: `${allowedOrigin}/redirect` }),
      ).rejects.toThrow("host policy refused redirect");

      expect(transport.acquire).toHaveBeenCalledTimes(3);
      expect(allowedHits).toBe(2);
      expect(deniedHits).toBe(0);
    } finally {
      await Promise.all([closeServer(allowedServer), closeServer(deniedServer)]);
    }
  });

  it("prevents real dispatch when revoked during awaited host admission", async () => {
    let hits = 0;
    let current = true;
    const enteredAdmission = createDeferred();
    const resumeAdmission = createDeferred();
    const server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("stale real adapter content");
    });
    try {
      const origin = await listen(server);
      const transport: WebFetchTransport = {
        assertInvocationCurrent: vi.fn(() => {
          if (!current) {
            throw new Error("invocation closed");
          }
        }),
        acquire: vi.fn<WebFetchTransport["acquire"]>(async (request) => {
          enteredAdmission.resolve();
          await resumeAdmission.promise;
          transport.assertInvocationCurrent();
          const response = await fetch(request.url, {
            headers: request.init.headers,
            method: request.init.method,
            redirect: "manual",
            signal: request.signal,
          });
          return {
            response,
            finalUrl: request.url,
            release: async () => {},
          };
        }),
      };
      const [tool] = (await assemble(transport)).filter((entry) => entry.name === "web_fetch");
      assert(tool);

      const execution = tool.execute("real-revoked-admission", { url: `${origin}/private` });
      await enteredAdmission.promise;
      current = false;
      resumeAdmission.resolve();

      await expect(execution).rejects.toThrow("invocation closed");
      expect(hits).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("blocks real cached delivery, spill creation and error details after retirement", async () => {
    let current = true;
    let hits = 0;
    const bodyControls = {
      "/cache": createDeferred(),
      "/large": createDeferred(),
      "/error": createDeferred(),
    };
    const transportReturned = {
      "/cache": createDeferred(),
      "/large": createDeferred(),
      "/error": createDeferred(),
    };
    const server = createServer((request, response) => {
      hits += 1;
      if (request.url === "/error") {
        response.writeHead(403, { "content-type": "text/plain" });
        response.flushHeaders();
        void bodyControls["/error"].promise.then(() => {
          response.end("private host error detail");
        });
        return;
      }
      const path = request.url === "/large" ? "/large" : "/cache";
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      void bodyControls[path].promise.then(() => {
        response.end(
          path === "/large"
            ? "private acquired content ".repeat(300)
            : "cacheable real adapter content",
        );
      });
    });
    const release = vi.fn(async () => {});
    const write = vi.spyOn(privateTempFiles, "writePrivateTempFile");
    try {
      const origin = await listen(server);
      const transport: WebFetchTransport = {
        assertInvocationCurrent: vi.fn(() => {
          if (!current) {
            throw new Error("invocation closed");
          }
        }),
        acquire: vi.fn<WebFetchTransport["acquire"]>(async (request) => {
          const response = await fetch(request.url, {
            headers: request.init.headers,
            method: request.init.method,
            redirect: "manual",
            signal: request.signal,
          });
          const path = new URL(request.url).pathname as "/cache" | "/large" | "/error";
          const returned = transportReturned[path];
          assert(returned);
          returned.resolve();
          return {
            response,
            finalUrl: request.url,
            release,
          };
        }),
      };
      const [tool] = (await assemble(transport)).filter((entry) => entry.name === "web_fetch");
      assert(tool);

      const cacheSeed = tool.execute("real-cache-seed", { url: `${origin}/cache` });
      await transportReturned["/cache"].promise;
      bodyControls["/cache"].resolve();
      expect(detailsOf(await cacheSeed).text).toContain("cacheable real adapter content");
      current = false;
      await expect(tool.execute("real-cache-retired", { url: `${origin}/cache` })).rejects.toThrow(
        "invocation closed",
      );
      expect(hits).toBe(1);

      current = true;
      const spill = tool.execute("real-spill-retired", {
        url: `${origin}/large`,
        maxChars: 1_000,
      });
      await transportReturned["/large"].promise;
      current = false;
      bodyControls["/large"].resolve();
      await expect(spill).rejects.toThrow("invocation closed");
      expect(write).not.toHaveBeenCalled();

      current = true;
      const error = tool.execute("real-error-retired", { url: `${origin}/error` });
      await transportReturned["/error"].promise;
      current = false;
      bodyControls["/error"].resolve();
      await expect(error).rejects.toThrow("invocation closed");
      try {
        await error;
      } catch (caught) {
        expect((caught as Error).message).not.toContain("private host error detail");
      }
      expect(release).toHaveBeenCalledTimes(3);
      expect(hits).toBe(3);
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    { label: "disabled", config: { tools: { web: { fetch: { enabled: false } } } } },
    { label: "denied by name", config: { tools: { deny: ["web_fetch"] } } },
    { label: "denied by group", config: { tools: { deny: ["group:web"] } } },
  ])("preserves $label user policy on rebuilt surfaces", async ({ config }) => {
    const transport = hostTransport();
    expect((await assemble(transport)).some((tool) => tool.name === "web_fetch")).toBe(true);
    expect((await assemble(transport, config)).some((tool) => tool.name === "web_fetch")).toBe(
      false,
    );
    expect(transport.acquire).not.toHaveBeenCalled();
  });
});
