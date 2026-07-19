import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  BoardSnapshotSchema,
  BoardWidgetAppViewParamsSchema,
  BoardWidgetContentSchema,
  BoardWidgetGrantParamsSchema,
  BoardWidgetPutParamsSchema,
} from "./board.js";

describe("BoardSnapshotSchema", () => {
  it("accepts optional HTML widget view metadata", () => {
    const snapshot = {
      sessionKey: "agent:main:main",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [
        {
          name: "status",
          tabId: "main",
          contentKind: "html",
          sizeW: 6,
          sizeH: 4,
          position: 0,
          grantState: "none",
          revision: 1,
          declaredSummary: ["Network access: https://example.com"],
          frameUrl: "/__openclaw__/board/agent%3Amain%3Amain/status/index.html?bt=ticket",
        },
      ],
    };
    expect(Value.Check(BoardSnapshotSchema, snapshot)).toBe(true);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], frameUrl: 42 }],
      }),
    ).toBe(false);
    expect(
      Value.Check(BoardSnapshotSchema, {
        ...snapshot,
        widgets: [{ ...snapshot.widgets[0], declaredSummary: [42] }],
      }),
    ).toBe(false);
  });

  it("accepts declared grant summaries", () => {
    const widget = {
      name: "status",
      tabId: "main",
      contentKind: "mcp-app",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      declaredSummary: ["Network: api.example.com", "Tools: lookup"],
      revision: 1,
    };
    const snapshot = {
      sessionKey: "agent:main:main",
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [widget],
    };

    expect(Value.Check(BoardSnapshotSchema, snapshot)).toBe(true);
  });
});

describe("BoardWidgetPutParamsSchema", () => {
  it("accepts a gateway-resolved canvas document source", () => {
    expect(
      Value.Check(BoardWidgetPutParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        content: { kind: "canvas-doc", docId: "cv_status" },
      }),
    ).toBe(true);
  });

  it("accepts a transient MCP App pin descriptor with a live view id", () => {
    const content = { kind: "mcp-app", viewId: "mcp-app-live" };
    expect(
      Value.Check(BoardWidgetPutParamsSchema, {
        sessionKey: "agent:main:main",
        name: "demo",
        content,
      }),
    ).toBe(true);
    expect(Value.Check(BoardWidgetContentSchema, content)).toBe(false);
  });
});

describe("BoardWidgetGrantParamsSchema", () => {
  it("requires the widget revision being approved", () => {
    expect(
      Value.Check(BoardWidgetGrantParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        decision: "granted",
        revision: 1,
      }),
    ).toBe(true);
    expect(
      Value.Check(BoardWidgetGrantParamsSchema, {
        sessionKey: "agent:main:main",
        name: "status",
        decision: "granted",
      }),
    ).toBe(false);
  });

  it("accepts an MCP App instance id without requiring it for HTML grants", () => {
    expect(
      Value.Check(BoardWidgetGrantParamsSchema, {
        sessionKey: "agent:main:main",
        name: "app",
        decision: "granted",
        revision: 1,
        instanceId: "instance-1",
      }),
    ).toBe(true);
  });
});

describe("BoardWidgetAppViewParamsSchema", () => {
  it("requires the exact widget revision and instance", () => {
    const params = {
      sessionKey: "agent:main:main",
      name: "app",
      revision: 1,
      instanceId: "instance-1",
    };
    expect(Value.Check(BoardWidgetAppViewParamsSchema, params)).toBe(true);
    expect(Value.Check(BoardWidgetAppViewParamsSchema, { ...params, instanceId: undefined })).toBe(
      false,
    );
  });
});
