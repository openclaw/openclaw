import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import { registerSessionSearchPlugin } from "./index.js";
import { clearPendingSessionSearchInjectionsForTest } from "./src/pending-injections.js";

describe("session-search plugin", () => {
  beforeEach(() => {
    clearPendingSessionSearchInjectionsForTest();
  });

  it("registers a Plugin UI Entry Point and gateway-auth test page", () => {
    const registerControlUiEntryPoint = vi.fn();
    const registerHttpRoute = vi.fn();
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      pluginConfig: {
        testFlag: true,
      },
      registerControlUiEntryPoint,
      registerHttpRoute,
    });

    registerSessionSearchPlugin(api);

    expect(registerControlUiEntryPoint).toHaveBeenCalledWith({
      id: "session-search",
      surface: "app-nav",
      label: "Session Search",
      path: "/plugins/session-search/",
      description: "Search, inspect, inject, and resume previous OpenClaw sessions.",
      requiredScopes: ["operator.read"],
    });
    expect(registerHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/plugins/session-search",
        auth: "gateway",
        match: "prefix",
      }),
    );
  });

  it("serves a read-only session list from the configured session store", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const discoveredTranscriptPath = path.join(dir, "older-session.jsonl");
    const deletedTranscriptPath = path.join(
      dir,
      "deleted-session.jsonl.deleted.2026-04-28T21-33-34.723Z",
    );
    await fs.writeFile(
      storePath,
      JSON.stringify({
        main: {
          sessionId: "sess-main",
          updatedAt: 1_700_000_000_000,
          sessionFile: transcriptPath,
          lastChannel: "webchat",
          modelProvider: "openai",
          model: "gpt-test",
        },
      }),
    );
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({ type: "session", id: "sess-main" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "Find old deployment notes",
            timestamp: 1_700_000_000_000,
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "Deployment notes found.",
            timestamp: 1_700_000_001_000,
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            content: "Tool output belongs with tool result filters.",
            timestamp: 1_700_000_002_000,
          },
        }),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      discoveredTranscriptPath,
      [
        JSON.stringify({ type: "session", id: "older-session" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "Older transcript outside sessions json",
            timestamp: 1_600_000_000_000,
          },
        }),
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      deletedTranscriptPath,
      [
        JSON.stringify({ type: "session", id: "deleted-session" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: "Deleted archived transcript still searchable",
            timestamp: 1_500_000_000_000,
          },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => ({
              main: {
                sessionId: "sess-main",
                updatedAt: 1_700_000_000_000,
                sessionFile: transcriptPath,
                lastChannel: "webchat",
                modelProvider: "openai",
                model: "gpt-test",
              },
            }),
            resolveSessionFilePath: () => transcriptPath,
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler({ url: "/plugins/session-search/" } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "text/html; charset=utf-8");
    expect(res.setHeader).toHaveBeenCalledWith("cache-control", "no-store");
    expect(chunks.join("")).toContain("Session Search");
    expect(chunks.join("")).toContain("Loading sessions");
    expect(chunks.join("")).toContain('data-select-visible-messages title="Select All Messages"');
    expect(chunks.join("")).toContain('data-clear-all-message-selection title="Clear Selection"');
    expect(chunks.join("")).toContain('data-message-role-filter value="assistant" checked');
    chunks.length = 0;

    await route.handler({ url: "/plugins/session-search/session/main" } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(chunks.join("")).toContain('data-message-role="tool"');
    expect(chunks.join("")).toContain("Tool Result");
    expect(chunks.join("")).toContain("Tool output belongs with tool result filters.");
    chunks.length = 0;

    await route.handler(
      { method: "GET", url: "/plugins/session-search/api/sessions?limit=10" } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("content-type", "application/json; charset=utf-8");
    const payload = JSON.parse(chunks.join("")) as { items?: Array<Record<string, unknown>> };
    const serializedItems = JSON.stringify(payload.items);
    expect(serializedItems).toContain("Find old deployment notes");
    expect(serializedItems).toContain("Older transcript outside sessions json");
    expect(serializedItems).toContain("Deleted archived transcript still searchable");
    expect(serializedItems).toContain("/plugins/session-search/session/main");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not cap the default unfiltered session list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionStore: Record<string, unknown> = {};
    for (let index = 0; index < 55; index += 1) {
      const key = `session-${index}`;
      const transcriptPath = path.join(dir, `${key}.jsonl`);
      sessionStore[key] = {
        sessionId: key,
        updatedAt: 1_700_000_000_000 + index,
        sessionFile: transcriptPath,
        lastChannel: "webchat",
      };
      await fs.writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "message",
            message: { role: "user", content: `Unfiltered session ${index}` },
          }),
          "",
        ].join("\n"),
      );
    }
    await fs.writeFile(storePath, JSON.stringify(sessionStore));
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => sessionStore as never,
            resolveSessionFilePath: (_sessionId, entry) =>
              (entry as { sessionFile?: string }).sessionFile ?? "",
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler({ url: "/plugins/session-search/" } as never, res as never);

    const html = chunks.join("");
    expect(res.statusCode).toBe(200);
    expect(html).toContain("Loading sessions");
    chunks.length = 0;

    await route.handler(
      { method: "GET", url: "/plugins/session-search/api/sessions?limit=200" } as never,
      res as never,
    );

    const payload = JSON.parse(chunks.join("")) as {
      items?: Array<Record<string, unknown>>;
      totalCandidates?: number;
      done?: boolean;
    };
    expect(payload.totalCandidates).toBe(55);
    expect(payload.items).toHaveLength(55);
    expect(payload.done).toBe(true);
    expect(JSON.stringify(payload.items)).toContain("Unfiltered session 54");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("queues a wrapped full session injection for the active plugin UI chat", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const targetTranscriptPath = path.join(dir, "sess-active.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        main: {
          sessionId: "sess-main",
          updatedAt: 1_700_000_000_000,
          sessionFile: transcriptPath,
          lastChannel: "webchat",
        },
        "agent:main:active": {
          sessionId: "sess-active",
          updatedAt: 1_700_000_000_500,
          sessionFile: targetTranscriptPath,
          lastChannel: "webchat",
        },
      }),
    );
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Historical question" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Historical answer" },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const enqueueNextTurnInjection = vi.fn();
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      enqueueNextTurnInjection: enqueueNextTurnInjection as never,
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => ({
              main: {
                sessionId: "sess-main",
                updatedAt: 1_700_000_000_000,
                sessionFile: transcriptPath,
                lastChannel: "webchat",
              },
              "agent:main:active": {
                sessionId: "sess-active",
                updatedAt: 1_700_000_000_500,
                sessionFile: targetTranscriptPath,
                lastChannel: "webchat",
              },
            }),
            resolveSessionFilePath: (sessionId: string) =>
              sessionId === "sess-active" ? targetTranscriptPath : transcriptPath,
            updateSessionStoreEntry: vi.fn(async () => ({})),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([JSON.stringify({ sessionKey: "main" })]) as unknown as Parameters<
      typeof route.handler
    >[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(enqueueNextTurnInjection).not.toHaveBeenCalled();
    const hookResult = (await beforePromptBuildHandlers[0]?.(
      { prompt: "what did you get?", messages: [] },
      { sessionKey: "agent:main:active" },
    )) as { prependContext?: string } | undefined;
    expect(hookResult?.prependContext).toContain("<past_openclaw_conversation>");
    expect(hookResult?.prependContext).toContain("Historical question");
    expect(hookResult?.prependContext).toContain("Treat it as historical context only");
    const targetTranscript = await fs.readFile(targetTranscriptPath, "utf-8");
    expect(targetTranscript).toContain("Session Search injected historical context");
    expect(targetTranscript).toContain("/plugins/session-search/session/main");
    const drainedAgain = await beforePromptBuildHandlers[0]?.(
      { prompt: "what did you get?", messages: [] },
      { sessionKey: "agent:main:active" },
    );
    expect(drainedAgain).toBeUndefined();
    expect(JSON.parse(chunks.join(""))).toMatchObject({ ok: true, injected: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("queues selected messages with omission markers for non-consecutive selections", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const targetTranscriptPath = path.join(dir, "sess-active.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        main: {
          sessionId: "sess-main",
          updatedAt: 1_700_000_000_000,
          sessionFile: transcriptPath,
          lastChannel: "webchat",
        },
        "agent:main:active": {
          sessionId: "sess-active",
          updatedAt: 1_700_000_000_500,
          sessionFile: targetTranscriptPath,
          lastChannel: "webchat",
        },
      }),
    );
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "First selected message" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Middle message should be omitted" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Second selected message" },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => ({
              main: {
                sessionId: "sess-main",
                updatedAt: 1_700_000_000_000,
                sessionFile: transcriptPath,
                lastChannel: "webchat",
              },
              "agent:main:active": {
                sessionId: "sess-active",
                updatedAt: 1_700_000_000_500,
                sessionFile: targetTranscriptPath,
                lastChannel: "webchat",
              },
            }),
            resolveSessionFilePath: (sessionId: string) =>
              sessionId === "sess-active" ? targetTranscriptPath : transcriptPath,
            updateSessionStoreEntry: vi.fn(async () => ({})),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([
      JSON.stringify({ sessionKey: "main", selectedMessageIndexes: [0, 2] }),
    ]) as unknown as Parameters<typeof route.handler>[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const hookResult = (await beforePromptBuildHandlers[0]?.(
      { prompt: "what did you get?", messages: [] },
      { sessionKey: "agent:main:active" },
    )) as { prependContext?: string } | undefined;
    expect(hookResult?.prependContext).toContain("These are selected messages");
    expect(hookResult?.prependContext).toContain("First selected message");
    expect(hookResult?.prependContext).toContain("Second selected message");
    expect(hookResult?.prependContext).not.toContain("Middle message should be omitted");
    expect(hookResult?.prependContext).toContain(
      "1 message was omitted between these selected messages.",
    );
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      ok: true,
      injected: true,
      selectedMessages: 2,
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps selected messages even when role filters are submitted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const targetTranscriptPath = path.join(dir, "sess-active.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        main: {
          sessionId: "sess-main",
          updatedAt: 1_700_000_000_000,
          sessionFile: transcriptPath,
          lastChannel: "webchat",
        },
        "agent:main:active": {
          sessionId: "sess-active",
          updatedAt: 1_700_000_000_500,
          sessionFile: targetTranscriptPath,
          lastChannel: "webchat",
        },
      }),
    );
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Visible user message" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Hidden but selected assistant message" },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => ({
              main: {
                sessionId: "sess-main",
                updatedAt: 1_700_000_000_000,
                sessionFile: transcriptPath,
                lastChannel: "webchat",
              },
              "agent:main:active": {
                sessionId: "sess-active",
                updatedAt: 1_700_000_000_500,
                sessionFile: targetTranscriptPath,
                lastChannel: "webchat",
              },
            }),
            resolveSessionFilePath: (sessionId: string) =>
              sessionId === "sess-active" ? targetTranscriptPath : transcriptPath,
            updateSessionStoreEntry: vi.fn(async () => ({})),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([
      JSON.stringify({
        sessionKey: "main",
        selectedMessageIndexes: [1],
        includedMessageRoles: ["user"],
      }),
    ]) as unknown as Parameters<typeof route.handler>[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const hookResult = (await beforePromptBuildHandlers[0]?.(
      { prompt: "what did you get?", messages: [] },
      { sessionKey: "agent:main:active" },
    )) as { prependContext?: string } | undefined;
    expect(hookResult?.prependContext).toContain("Hidden but selected assistant message");
    expect(hookResult?.prependContext).not.toContain("Visible user message");
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      ok: true,
      injected: true,
      selectedMessages: 1,
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a resumed session and queues the source session into its context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "AGENTS guidance for resumed sessions");
    await fs.writeFile(path.join(dir, "SOUL.md"), "SOUL current persona");
    await fs.writeFile(path.join(dir, "TOOLS.md"), "TOOLS current local notes");
    await fs.writeFile(path.join(dir, "USER.md"), "USER current profile");
    await fs.writeFile(path.join(dir, "MEMORY.md"), "ROOT MEMORY current distilled notes");
    await fs.writeFile(path.join(dir, "memory", "2023-11-14.md"), "DAY 2023-11-14 memory");
    await fs.writeFile(path.join(dir, "memory", "2023-11-13.md"), "DAY 2023-11-13 memory");
    await fs.writeFile(path.join(dir, "memory", "2026-05-10.md"), "CURRENT DAY SHOULD NOT RESUME");
    const sessionStore: Record<string, Record<string, unknown>> = {
      main: {
        sessionId: "sess-main",
        updatedAt: 1_700_000_000_000,
        sessionStartedAt: 1_700_000_000_000,
        sessionFile: transcriptPath,
        lastChannel: "webchat",
        origin: {
          label: "webchat direct",
          provider: "webchat",
          surface: "webchat",
        },
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore));
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Original session question" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Original session answer" },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () =>
            ({
              session: { store: storePath },
              agents: { defaults: { workspace: dir, userTimezone: "UTC" } },
            }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => sessionStore,
            updateSessionStore: vi.fn(async (_storePath, mutator) => {
              await mutator(sessionStore as never);
              await fs.writeFile(storePath, JSON.stringify(sessionStore));
            }),
            updateSessionStoreEntry: vi.fn(async ({ sessionKey, update }) => {
              const entry = sessionStore[sessionKey];
              if (!entry) {
                return null;
              }
              Object.assign(entry, await update(entry as never));
              await fs.writeFile(storePath, JSON.stringify(sessionStore));
              return entry;
            }),
            resolveSessionFilePath: (sessionId: string, entry?: { sessionFile?: string }) =>
              entry?.sessionFile ?? path.join(dir, `${sessionId}.jsonl`),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([
      JSON.stringify({ sessionKey: "main", resumeSession: true }),
    ]) as unknown as Parameters<typeof route.handler>[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(chunks.join("")) as { sessionKey?: string; resumed?: boolean };
    expect(payload.resumed).toBe(true);
    expect(payload.sessionKey).toMatch(/^agent:main:dashboard:/);
    const resumedSessionKey = payload.sessionKey ?? "";
    expect(sessionStore[resumedSessionKey]).toMatchObject({
      label: "Resume: webchat direct",
      parentSessionKey: "main",
    });
    const hookResult = (await beforePromptBuildHandlers[0]?.(
      { prompt: "continue", messages: [] },
      { sessionKey: resumedSessionKey },
    )) as { prependContext?: string } | undefined;
    expect(hookResult?.prependContext).toContain("Original session question");
    expect(hookResult?.prependContext).toContain("Original session answer");
    expect(hookResult?.prependContext).toContain("<resume_manifest>");
    expect(hookResult?.prependContext).toContain("Session date anchor: 2023-11-14");
    expect(hookResult?.prependContext).toContain("DAY 2023-11-14 memory");
    expect(hookResult?.prependContext).toContain("DAY 2023-11-13 memory");
    expect(hookResult?.prependContext).not.toContain("CURRENT DAY SHOULD NOT RESUME");
    expect(hookResult?.prependContext).toContain("AGENTS guidance for resumed sessions");
    expect(hookResult?.prependContext).toContain("USER current profile");
    expect(hookResult?.prependContext).toContain("ROOT MEMORY current distilled notes");
    expect(hookResult?.prependContext).toContain(
      "Workspace bootstrap markdown files use their current contents",
    );
    expect(hookResult?.prependContext).toContain("Origin provider: webchat");
    const resumedTranscriptPath = sessionStore[resumedSessionKey]?.sessionFile as string;
    const resumedTranscript = await fs.readFile(resumedTranscriptPath, "utf-8");
    expect(resumedTranscript).toContain("Session Search injected historical context");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a resumed session from a selected message and only queues transcript history through that point", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "AGENTS resume-from-here guidance");
    await fs.writeFile(path.join(dir, "SOUL.md"), "SOUL current persona");
    await fs.writeFile(path.join(dir, "TOOLS.md"), "TOOLS current local notes");
    await fs.writeFile(path.join(dir, "USER.md"), "USER current profile");
    await fs.writeFile(path.join(dir, "MEMORY.md"), "ROOT MEMORY current distilled notes");
    await fs.writeFile(path.join(dir, "memory", "2023-11-14.md"), "DAY 2023-11-14 memory");
    await fs.writeFile(path.join(dir, "memory", "2023-11-13.md"), "DAY 2023-11-13 memory");
    const sessionStore: Record<string, Record<string, unknown>> = {
      main: {
        sessionId: "sess-main",
        updatedAt: 1_700_000_000_000,
        sessionStartedAt: 1_700_000_000_000,
        sessionFile: transcriptPath,
        lastChannel: "webchat",
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore));
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "First resume-from-here message" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Second resume-from-here message" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Future message should not be included" },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () =>
            ({
              session: { store: storePath },
              agents: { defaults: { workspace: dir, userTimezone: "UTC" } },
            }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => sessionStore,
            updateSessionStore: vi.fn(async (_storePath, mutator) => {
              await mutator(sessionStore as never);
              await fs.writeFile(storePath, JSON.stringify(sessionStore));
            }),
            updateSessionStoreEntry: vi.fn(async ({ sessionKey, update }) => {
              const entry = sessionStore[sessionKey];
              if (!entry) {
                return null;
              }
              Object.assign(entry, await update(entry as never));
              await fs.writeFile(storePath, JSON.stringify(sessionStore));
              return entry;
            }),
            resolveSessionFilePath: (sessionId: string, entry?: { sessionFile?: string }) =>
              entry?.sessionFile ?? path.join(dir, `${sessionId}.jsonl`),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([
      JSON.stringify({
        sessionKey: "main",
        resumeSession: true,
        resumeThroughMessageIndex: 1,
      }),
    ]) as unknown as Parameters<typeof route.handler>[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(chunks.join("")) as { sessionKey?: string; resumed?: boolean };
    expect(payload.resumed).toBe(true);
    const resumedSessionKey = payload.sessionKey ?? "";
    const hookResult = (await beforePromptBuildHandlers[0]?.(
      { prompt: "continue", messages: [] },
      { sessionKey: resumedSessionKey },
    )) as { prependContext?: string } | undefined;
    expect(hookResult?.prependContext).toContain("included only up to the selected resume point");
    expect(hookResult?.prependContext).toContain("Resume through source message index: 1");
    expect(hookResult?.prependContext).toContain("Transcript messages included: 2");
    expect(hookResult?.prependContext).toContain("First resume-from-here message");
    expect(hookResult?.prependContext).toContain("Second resume-from-here message");
    expect(hookResult?.prependContext).not.toContain("Future message should not be included");
    expect(sessionStore[resumedSessionKey]).toMatchObject({
      parentSessionKey: "main",
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("filters unchecked message roles out of resumed session context", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "AGENTS filtered resume guidance");
    await fs.writeFile(path.join(dir, "SOUL.md"), "SOUL current persona");
    await fs.writeFile(path.join(dir, "TOOLS.md"), "TOOLS current local notes");
    await fs.writeFile(path.join(dir, "USER.md"), "USER current profile");
    await fs.writeFile(path.join(dir, "MEMORY.md"), "ROOT MEMORY current distilled notes");
    await fs.writeFile(path.join(dir, "memory", "2023-11-14.md"), "DAY 2023-11-14 memory");
    const sessionStore: Record<string, Record<string, unknown>> = {
      main: {
        sessionId: "sess-main",
        updatedAt: 1_700_000_000_000,
        sessionStartedAt: 1_700_000_000_000,
        sessionFile: transcriptPath,
        lastChannel: "webchat",
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore));
    await fs.writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "User resume message" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: "Assistant resume message should be filtered" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", content: "Tool resume message should be filtered" },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Second user resume message" },
        }),
        "",
      ].join("\n"),
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () =>
            ({
              session: { store: storePath },
              agents: { defaults: { workspace: dir, userTimezone: "UTC" } },
            }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => sessionStore,
            updateSessionStore: vi.fn(async (_storePath, mutator) => {
              await mutator(sessionStore as never);
              await fs.writeFile(storePath, JSON.stringify(sessionStore));
            }),
            updateSessionStoreEntry: vi.fn(async ({ sessionKey, update }) => {
              const entry = sessionStore[sessionKey];
              if (!entry) {
                return null;
              }
              Object.assign(entry, await update(entry as never));
              await fs.writeFile(storePath, JSON.stringify(sessionStore));
              return entry;
            }),
            resolveSessionFilePath: (sessionId: string, entry?: { sessionFile?: string }) =>
              entry?.sessionFile ?? path.join(dir, `${sessionId}.jsonl`),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([
      JSON.stringify({
        sessionKey: "main",
        resumeSession: true,
        resumeThroughMessageIndex: 3,
        includedMessageRoles: ["user"],
      }),
    ]) as unknown as Parameters<typeof route.handler>[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    const payload = JSON.parse(chunks.join("")) as { sessionKey?: string; resumed?: boolean };
    expect(payload.resumed).toBe(true);
    const hookResult = (await beforePromptBuildHandlers[0]?.(
      { prompt: "continue", messages: [] },
      { sessionKey: payload.sessionKey ?? "" },
    )) as { prependContext?: string } | undefined;
    expect(hookResult?.prependContext).toContain("Transcript messages included: 2");
    expect(hookResult?.prependContext).toContain("User resume message");
    expect(hookResult?.prependContext).toContain("Second user resume message");
    expect(hookResult?.prependContext).not.toContain("Assistant resume message should be filtered");
    expect(hookResult?.prependContext).not.toContain("Tool resume message should be filtered");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects show-session injection when it exceeds the active context window", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const targetTranscriptPath = path.join(dir, "sess-active.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        main: {
          sessionId: "sess-main",
          updatedAt: 1_700_000_000_000,
          sessionFile: transcriptPath,
        },
        "agent:main:active": {
          sessionId: "sess-active",
          updatedAt: 1_700_000_000_500,
          sessionFile: targetTranscriptPath,
        },
      }),
    );
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "This is too much text for the tiny window." },
      })}\n`,
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const enqueueNextTurnInjection = vi.fn();
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      enqueueNextTurnInjection,
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => ({
              main: {
                sessionId: "sess-main",
                updatedAt: 1_700_000_000_000,
                sessionFile: transcriptPath,
              },
              "agent:main:active": {
                sessionId: "sess-active",
                updatedAt: 1_700_000_000_500,
                sessionFile: targetTranscriptPath,
              },
            }),
            resolveSessionFilePath: (sessionId: string) =>
              sessionId === "sess-active" ? targetTranscriptPath : transcriptPath,
            updateSessionStoreEntry: vi.fn(async () => ({})),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([JSON.stringify({ sessionKey: "main" })]) as unknown as Parameters<
      typeof route.handler
    >[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "1",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(413);
    expect(enqueueNextTurnInjection).not.toHaveBeenCalled();
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      ok: false,
      error: "too_large",
      message: "Session exceeds the active context window.",
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not create a resumed session when resume exceeds the active context window", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    await fs.mkdir(path.join(dir, "memory"), { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "AGENTS guidance");
    await fs.writeFile(path.join(dir, "SOUL.md"), "SOUL guidance");
    await fs.writeFile(path.join(dir, "TOOLS.md"), "TOOLS guidance");
    await fs.writeFile(path.join(dir, "USER.md"), "USER guidance");
    await fs.writeFile(path.join(dir, "MEMORY.md"), "MEMORY guidance");
    const sessionStore: Record<string, Record<string, unknown>> = {
      main: {
        sessionId: "sess-main",
        updatedAt: 1_700_000_000_000,
        sessionStartedAt: 1_700_000_000_000,
        sessionFile: transcriptPath,
        lastChannel: "webchat",
      },
    };
    await fs.writeFile(storePath, JSON.stringify(sessionStore));
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "This resume is too large for the tiny window." },
      })}\n`,
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const updateSessionStore = vi.fn(async (_storePath, mutator) => {
      await mutator(sessionStore as never);
      await fs.writeFile(storePath, JSON.stringify(sessionStore));
    });
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      runtime: {
        config: {
          current: () =>
            ({
              session: { store: storePath },
              agents: { defaults: { workspace: dir, userTimezone: "UTC" } },
            }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => sessionStore,
            updateSessionStore,
            updateSessionStoreEntry: vi.fn(async () => ({})),
            resolveSessionFilePath: (sessionId: string, entry?: { sessionFile?: string }) =>
              entry?.sessionFile ?? path.join(dir, `${sessionId}.jsonl`),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([
      JSON.stringify({ sessionKey: "main", resumeSession: true }),
    ]) as unknown as Parameters<typeof route.handler>[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "1",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(413);
    expect(updateSessionStore).not.toHaveBeenCalled();
    expect(Object.keys(sessionStore)).toEqual(["main"]);
    expect(JSON.parse(chunks.join(""))).toMatchObject({
      ok: false,
      error: "too_large",
      message: "Session exceeds the active context window.",
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not depend on the host next-turn injection queue", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-search-test-"));
    const storePath = path.join(dir, "sessions.json");
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const targetTranscriptPath = path.join(dir, "sess-active.jsonl");
    await fs.writeFile(
      storePath,
      JSON.stringify({
        main: {
          sessionId: "sess-main",
          updatedAt: 1_700_000_000_000,
          sessionFile: transcriptPath,
        },
        "agent:main:active": {
          sessionId: "sess-active",
          updatedAt: 1_700_000_000_500,
          sessionFile: targetTranscriptPath,
        },
      }),
    );
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "Historical question" },
      })}\n`,
    );
    const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
    const enqueueNextTurnInjection = vi.fn(async () => {
      throw new Error("host queue should not be used");
    });
    const beforePromptBuildHandlers: Array<Parameters<OpenClawPluginApi["on"]>[1]> = [];
    const api = createTestPluginApi({
      id: "session-search",
      name: "Session Search",
      version: "test",
      enqueueNextTurnInjection: enqueueNextTurnInjection as never,
      runtime: {
        config: {
          current: () => ({ session: { store: storePath } }) as never,
        },
        agent: {
          session: {
            resolveStorePath: () => storePath,
            loadSessionStore: () => ({
              main: {
                sessionId: "sess-main",
                updatedAt: 1_700_000_000_000,
                sessionFile: transcriptPath,
              },
              "agent:main:active": {
                sessionId: "sess-active",
                updatedAt: 1_700_000_000_500,
                sessionFile: targetTranscriptPath,
              },
            }),
            resolveSessionFilePath: (sessionId: string) =>
              sessionId === "sess-active" ? targetTranscriptPath : transcriptPath,
            updateSessionStoreEntry: vi.fn(async () => ({})),
          },
        },
      } as never,
      registerHttpRoute(route) {
        routes.push(route);
      },
      on(hookName, handler) {
        if (hookName === "before_prompt_build") {
          beforePromptBuildHandlers.push(handler);
        }
      },
    });
    registerSessionSearchPlugin(api);
    const route = routes[0];
    if (!route) {
      throw new Error("expected session-search route registration");
    }
    const chunks: string[] = [];
    const req = Readable.from([JSON.stringify({ sessionKey: "main" })]) as unknown as Parameters<
      typeof route.handler
    >[0];
    Object.assign(req, {
      method: "POST",
      url: "/plugins/session-search/show-session",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-openclaw-plugin-ui-session-key": "agent:main:active",
        "x-openclaw-plugin-ui-context-tokens": "10000",
      },
    });
    const res = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn((chunk: string) => {
        chunks.push(chunk);
      }),
    };

    await route.handler(req, res as never);

    expect(res.statusCode).toBe(200);
    expect(enqueueNextTurnInjection).not.toHaveBeenCalled();
    const hookResult = await beforePromptBuildHandlers[0]?.(
      { prompt: "what did you get?", messages: [] },
      { sessionKey: "agent:main:active" },
    );
    expect(hookResult).toEqual(
      expect.objectContaining({
        prependContext: expect.stringContaining("Historical question"),
      }),
    );
    expect(JSON.parse(chunks.join(""))).toMatchObject({ ok: true, injected: true });
    await fs.rm(dir, { recursive: true, force: true });
  });
});
