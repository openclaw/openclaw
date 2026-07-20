import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  BoardSnapshotSchema,
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
});
