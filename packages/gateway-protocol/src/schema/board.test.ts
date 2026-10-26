import { describe, it } from "vitest";
import {
  BoardActionParamsSchema,
  BoardSnapshotSchema,
  BoardWidgetAppViewParamsSchema,
  BoardWidgetAppViewResultSchema,
  BoardWidgetGrantParamsSchema,
  BoardWidgetPutParamsSchema,
  BoardWidgetPutResultSchema,
  BoardWidgetResizeOpSchema,
} from "./board.js";
import { accepts, rejects } from "./schema.test-support.js";

const widget = {
  name: "status",
  tabId: "main",
  contentKind: "html",
  sizeW: 6,
  sizeH: 4,
  position: 0,
  grantState: "none",
  revision: 1,
};
const snapshot = {
  sessionKey: "agent:main:main",
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
};
const widgetRef = { sessionKey: snapshot.sessionKey, name: "status" };

it("BoardActionParamsSchema: accepts both exact cron triggers and plugin action verbs", () => {
  accepts(BoardActionParamsSchema, {
    ticket: "v1.ticket.signature",
    action: "cron.trigger",
    jobId: "nightly",
  });
  accepts(BoardActionParamsSchema, {
    ticket: "v1.ticket.signature",
    action: "workboard.dispatch",
    params: { boardId: "release" },
  });
  rejects(BoardActionParamsSchema, {
    ticket: "v1.ticket.signature",
    action: "workboard.dispatch",
    params: "release",
  });
});

it("BoardSnapshotSchema: accepts optional HTML widget view metadata", () => {
  const htmlWidget = {
    ...widget,
    presentation: "frameless",
    heightMode: "fixed",
    declaredSummary: ["Network access: https://example.com"],
    declared: { netOrigins: ["https://example.com"], tools: ["health"] },
    frameUrl: "/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=ticket",
    viewTicket: "v1.ticket.signature",
    viewTicketTtlMs: 60_000,
    viewGeneration: "a".repeat(32),
    sandboxUrl: "/mcp-app-sandbox?csp=encoded",
    sandboxPort: 18790,
  };
  const withWidget = (overrides: Record<string, unknown> = {}) => ({
    ...snapshot,
    widgets: [{ ...htmlWidget, ...overrides }],
  });
  accepts(BoardSnapshotSchema, withWidget());
  accepts(BoardSnapshotSchema, withWidget({ contentOwner: "html" }));
  accepts(
    BoardSnapshotSchema,
    withWidget({
      contentKind: "plugin",
      contentOwner: "registered",
      registeredContentKind: "a2ui",
      pluginKind: "canvas:a2ui",
      kindLabel: "A2UI",
    }),
  );
  for (const invalid of [
    { contentOwner: "unknown" },
    { frameUrl: 42 },
    { presentation: "floating" },
    { heightMode: "elastic" },
    { declaredSummary: [42] },
    { viewGeneration: "not-a-generation" },
  ]) {
    rejects(BoardSnapshotSchema, withWidget(invalid));
  }
});

describe("BoardWidgetPutParamsSchema", () => {
  it("returns the committed widget name with the board snapshot", () => {
    accepts(BoardWidgetPutResultSchema, {
      ...snapshot,
      widgets: [{ ...widget, name: "status-aaaaaaaa" }],
      resolvedWidgetName: "status-aaaaaaaa",
    });
  });

  it("rejects invalid widget presentation and height modes", () => {
    const pin = { ...widgetRef, content: { kind: "html", html: "<p>ok</p>" } };
    rejects(BoardWidgetPutParamsSchema, { ...pin, presentation: "floating" });
    rejects(BoardWidgetPutParamsSchema, { ...pin, heightMode: "elastic" });
    const resize = { kind: "widget_resize", name: "status", sizeW: 6, sizeH: 4 };
    accepts(BoardWidgetResizeOpSchema, { ...resize, heightMode: "fixed" });
    rejects(BoardWidgetResizeOpSchema, { ...resize, heightMode: "elastic" });
  });

  it("requires an active source view for MCP App pins", () => {
    const pin = {
      ...widgetRef,
      name: "weather-app",
      content: { kind: "mcp-app", viewId: "mcp-app-source" },
    };
    accepts(BoardWidgetPutParamsSchema, pin);
    rejects(BoardWidgetPutParamsSchema, {
      ...pin,
      content: { ...pin.content, viewId: undefined },
    });
    rejects(BoardWidgetPutParamsSchema, {
      ...pin,
      content: {
        kind: "mcp-app",
        descriptor: { viewId: "mcp-app-source" },
      },
    });
  });
});

it("BoardWidgetAppView schemas: binds lease requests to a board widget and returns its expiry", () => {
  const request = {
    ...widgetRef,
    name: "weather-app",
    revision: 3,
    instanceId: "widget-instance",
  };
  accepts(BoardWidgetAppViewParamsSchema, request);
  const { instanceId: _instanceId, ...missingInstance } = request;
  rejects(BoardWidgetAppViewParamsSchema, missingInstance);
  accepts(BoardWidgetAppViewResultSchema, { viewId: "mcp-app-fresh", expiresAtMs: 1_800_000 });
});

it("BoardWidgetGrantParamsSchema: requires the widget revision and instance being approved", () => {
  const request = {
    ...widgetRef,
    decision: "granted",
    revision: 1,
    instanceId: "widget-instance",
  };
  accepts(BoardWidgetGrantParamsSchema, request);
  const { instanceId: _instanceId, ...missingInstance } = request;
  const { revision: _revision, ...missingRevision } = request;
  rejects(BoardWidgetGrantParamsSchema, missingInstance);
  rejects(BoardWidgetGrantParamsSchema, missingRevision);
});
