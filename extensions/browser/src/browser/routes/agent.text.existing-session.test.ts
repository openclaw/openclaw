import { createContext, runInContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMcpTargetOperation } from "../chrome-mcp-contracts.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "../constants.js";
import {
  createExistingSessionAgentSharedModule,
  existingSessionRouteState,
} from "./existing-session.test-support.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserResponse } from "./types.js";

type DocumentTask = (document: { evaluate: (fn: string) => Promise<unknown> }) => Promise<unknown>;

const mcpMocks = vi.hoisted(() => ({
  ChromeMcpDocumentUnavailableError: class ChromeMcpDocumentUnavailableError extends Error {},
  withChromeMcpDocument:
    vi.fn<(params: ChromeMcpTargetOperation, task: DocumentTask) => Promise<unknown>>(),
}));

const navigationMocks = vi.hoisted(() => ({
  assertBrowserNavigationResultAllowed:
    vi.fn<(params: { url: string; signal?: AbortSignal }) => Promise<void>>(),
  withBrowserNavigationPolicy: (ssrfPolicy?: unknown) => ({ ssrfPolicy }),
}));

vi.mock("../chrome-mcp.js", () => mcpMocks);
vi.mock("../navigation-guard.js", () => navigationMocks);
vi.mock("./agent.shared.js", () => {
  const shared = createExistingSessionAgentSharedModule();
  return {
    ...shared,
    withRouteTabContext: vi.fn(
      async (
        params: Parameters<typeof shared.withRouteTabContext>[0] & { res: BrowserResponse },
      ) => {
        try {
          await shared.withRouteTabContext(params);
        } catch (error) {
          shared.handleRouteError(params.ctx, params.res, error);
        }
      },
    ),
  };
});

const { registerBrowserAgentTextRoutes } = await import("./agent.text.js");

class TextElement {
  constructor(
    private readonly value: string,
    private readonly onRead: () => void,
  ) {}

  get innerText() {
    this.onRead();
    return this.value;
  }
}

function createDocumentFixture() {
  const reads: string[] = [];
  const elements = new Map<string, TextElement[]>();
  const document = {
    nodeType: 9,
    querySelector: vi.fn((selector: string) => elements.get(selector)?.[0] ?? null),
    get body() {
      return elements.get("body")?.[0] ?? null;
    },
  };
  const globals = {
    document,
    root: document,
    location: { href: "https://example.com/article" },
    escaped: false,
  };
  const realm = createContext(globals);
  return {
    reads,
    globals,
    document,
    inLease: false,
    beforeEvaluation: undefined as
      | ((params: ChromeMcpTargetOperation) => Promise<void>)
      | undefined,
    set(selector: string, ...texts: string[]) {
      elements.set(
        selector,
        texts.map((text) => new TextElement(text, () => reads.push(text))),
      );
    },
    evaluate(fn: string): unknown {
      // Execute the real fixed reader: this fixture supplies DOM primitives, not extraction rules.
      return runInContext(`(${fn})(root)`, realm);
    },
  };
}

let fixture: ReturnType<typeof createDocumentFixture>;

async function callText(query: Record<string, unknown> = {}, signal?: AbortSignal) {
  const { app, getHandlers } = createBrowserRouteApp();
  registerBrowserAgentTextRoutes(app, {
    state: () => ({
      resolved: {
        actionTimeoutMs: 60_000,
        evaluateEnabled: false,
        ssrfPolicy: { allowPrivateNetwork: false },
      },
    }),
  } as never);
  const response = createBrowserRouteResponse();
  await expectDefined(getHandlers.get("/text"), "page text handler")(
    { params: {}, query: { targetId: "7", ...query }, signal },
    response.res,
  );
  return response;
}

describe("existing-session page text route", () => {
  beforeEach(() => {
    fixture = createDocumentFixture();
    existingSessionRouteState.tab.url = "https://example.com/article";
    navigationMocks.assertBrowserNavigationResultAllowed.mockReset().mockResolvedValue(undefined);
    mcpMocks.withChromeMcpDocument.mockReset().mockImplementation(async (params, task) => {
      params.signal?.throwIfAborted();
      fixture.inLease = true;
      try {
        return await task({
          evaluate: async (fn) => {
            await fixture.beforeEvaluation?.(params);
            params.signal?.throwIfAborted();
            return fixture.evaluate(fn);
          },
        });
      } finally {
        fixture.inLease = false;
      }
    });
  });

  it.each([
    { article: true, main: true, expected: "First article" },
    { article: false, main: true, expected: "Main prose" },
    { article: false, main: false, expected: "Body prose" },
  ])("reads $expected with caller evaluation disabled", async ({ article, main, expected }) => {
    fixture.set("body", "Body prose");
    if (main) {
      fixture.set("main", "Main prose");
    }
    if (article) {
      fixture.set("article", "First article", "Second article");
    }
    const response = await callText();
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      targetId: "7",
      url: "https://example.com/article",
      text: expected,
      truncated: false,
    });
    expect(fixture.reads).toEqual([expected]);
  });

  it("keeps a selector containing script punctuation as data and reads only its first match", async () => {
    const selector = '[data-label="quote\'); globalThis.escaped = true; //"]';
    fixture.set(selector, "  Selected text\n", "Second match");
    fixture.set("article", "Unrelated article");
    const response = await callText({ selector, maxChars: 5 });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ text: "  Sel", truncated: true });
    expect(fixture.globals.escaped).toBe(false);
    expect(fixture.reads).toEqual(["  Selected text\n"]);
  });

  it("waits for an explicit selector that appears after the first read", async () => {
    fixture.document.querySelector.mockImplementationOnce(() => {
      fixture.set(".loaded", "Loaded prose");
      return null;
    });
    const response = await callText({ selector: ".loaded" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ text: "Loaded prose", truncated: false });
    expect(fixture.reads).toEqual(["Loaded prose"]);
  });

  it("caps an oversized text budget before returning document text", async () => {
    fixture.set("body", "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS + 1));
    const response = await callText({ maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS * 2 });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      text: "x".repeat(DEFAULT_AI_SNAPSHOT_MAX_CHARS),
      truncated: true,
    });
  });

  it("rejects an invalid text budget before connecting to the browser", async () => {
    const response = await callText({ maxChars: 0 });
    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "maxChars must be a positive integer." });
    expect(mcpMocks.withChromeMcpDocument).not.toHaveBeenCalled();
  });

  it("does not read a document whose probed URL is blocked", async () => {
    fixture.globals.location.href = "http://127.0.0.1/private";
    fixture.set("body", "Private document");
    navigationMocks.assertBrowserNavigationResultAllowed.mockImplementation(async ({ url }) => {
      if (url === "http://127.0.0.1/private") {
        throw new Error("browser navigation blocked by policy");
      }
    });
    const response = await callText();
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).toMatchObject({ error: "browser navigation blocked by policy" });
    expect(fixture.reads).toEqual([]);
  });

  it.each(["url", "document"])(
    "does not read when the %s changes during asynchronous URL admission",
    async (change) => {
      fixture.set("body", "Replacement document");
      navigationMocks.assertBrowserNavigationResultAllowed.mockImplementation(async () => {
        if (!fixture.inLease) {
          return;
        }
        if (change === "url") {
          fixture.globals.location.href = "https://example.com/replacement";
        } else {
          fixture.globals.root = { ...fixture.document };
        }
      });
      const response = await callText();
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatchObject({ error: expect.stringMatching(/document changed/i) });
      expect(fixture.reads).toEqual([]);
    },
  );

  it("forwards cancellation to a pending document read and returns no prose", async () => {
    fixture.set("body", "Must not be returned");
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.beforeEvaluation = async () => {
      entered.resolve();
      await release.promise;
    };
    const controller = new AbortController();
    const pending = callText({}, controller.signal);
    await entered.promise;
    controller.abort(new Error("Canceled text inspection"));
    release.resolve();
    const response = await pending;
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).toMatchObject({ error: "Canceled text inspection" });
    expect(fixture.reads).toEqual([]);
  });
});
