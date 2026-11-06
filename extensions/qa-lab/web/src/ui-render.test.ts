import { describe, expect, it } from "vitest";
import { renderQaLabUi, type UiState } from "./ui-render.js";
import type {
  EvidenceArtifactView,
  EvidenceEntryView,
  EvidenceEnvelope,
  EvidenceMatrixCell,
} from "./ui-types.js";

type Snapshot = NonNullable<UiState["snapshot"]>;

function message(
  text: string,
  overrides: Partial<Snapshot["messages"][number]> = {},
): Snapshot["messages"][number] {
  return {
    accountId: "account-a",
    conversation: { id: "shared", kind: "channel" },
    direction: "outbound",
    id: text,
    reactions: [],
    senderId: "openclaw",
    text,
    timestamp: 1,
    ...overrides,
  };
}

function thread(
  id: string,
  title: string,
  overrides: Partial<Snapshot["threads"][number]> = {},
): Snapshot["threads"][number] {
  return {
    accountId: "account-a",
    conversationId: "shared",
    createdAt: 0,
    createdBy: "openclaw",
    id,
    title,
    ...overrides,
  };
}

function gallery(
  overrides: Partial<NonNullable<EvidenceEnvelope["evidence"]>>,
): NonNullable<EvidenceEnvelope["evidence"]> {
  return {
    counts: { blocked: 0, fail: 0, pass: 1, skipped: 0 },
    entries: [],
    evidenceMode: "full",
    evidencePath: ".artifacts/qa-e2e/suite/qa-evidence.json",
    generatedAt: "2026-06-17T12:00:00.000Z",
    producerContext: null,
    profile: null,
    schemaVersion: 2,
    ...overrides,
  };
}

function artifact(
  path: string,
  kind: string,
  mediaKind: EvidenceArtifactView["mediaKind"],
): EvidenceArtifactView {
  return {
    error: null,
    exists: true,
    href: `/api/evidence/artifact?artifactPath=${path}`,
    kind,
    mediaKind,
    path,
    preview: null,
    source: "ux-matrix:web-ui:first-run",
  };
}

function evidenceEntry(
  status: EvidenceEntryView["status"],
  overrides: Partial<EvidenceEntryView> = {},
): EvidenceEntryView {
  return {
    artifacts: [],
    coverage: [],
    failureReason: null,
    key: "0",
    effective: true,
    id: status,
    kind: "script-test",
    sourcePath: "fixture.ts",
    status,
    title: status,
    ...overrides,
  };
}

function matrixCell(surface: string, lane: string, entryKey: string | null): EvidenceMatrixCell {
  return {
    artifactKinds: entryKey ? ["screenshot"] : [],
    artifactPaths: entryKey ? ["screenshot.png"] : [],
    coverageIds: [],
    runner: { availability: "local", command: "run-ux-fixture", lane, workflow: "fixture.yml" },
    stage: "first-run",
    status: entryKey ? "pass" : "proof-gap",
    surface,
    entryKey,
    testId: entryKey ? "ux-matrix.web-ui.first-run" : null,
    title: entryKey ? "UX Matrix: web-ui / first-run" : null,
  };
}

function expectMarkup(html: string, included: string[], excluded: string[] = []) {
  for (const value of included) {
    expect(html).toContain(value);
  }
  for (const value of excluded) {
    expect(html).not.toContain(value);
  }
}

function evidenceState(overrides: Partial<UiState> = {}): UiState {
  return {
    activeTab: "evidence",
    bootstrap: null,
    busy: false,
    captureCollapsedLaneIds: [],
    captureControlsExpanded: true,
    captureCoverage: null,
    captureDetailPlacement: "right",
    captureDetailSplitDragging: false,
    captureDetailSplitPct: 35,
    captureDetailView: "overview",
    captureErrorsOnly: false,
    captureEvents: [],
    captureFlowDetailLayout: null,
    captureGroupMode: "none",
    captureHeaderMode: "key",
    captureHostFilter: [],
    captureKindFilter: [],
    capturePayloadDetailLayout: null,
    capturePayloadEventFilter: "",
    capturePayloadEventSort: "stream",
    capturePayloadExtent: "preview",
    capturePinnedLaneIds: [],
    captureProviderFilter: [],
    captureQueryPreset: "none",
    captureQueryRows: [],
    captureSavedViews: [],
    captureSearchText: "",
    captureSelectedSessionsExpanded: true,
    captureSessions: [],
    captureStartupStatus: null,
    captureSummaryExpanded: true,
    captureTimelineBrushAnchorPct: null,
    captureTimelineBrushCurrentPct: null,
    captureTimelineFocusSelectedFlow: false,
    captureTimelineFocusedLaneMode: "all",
    captureTimelineFocusedLaneThreshold: "any",
    captureTimelineLaneMode: "domain",
    captureTimelineLaneSearch: "",
    captureTimelineLaneSort: "most-events",
    captureTimelinePreviousLaneSort: null,
    captureTimelineSparklineMode: "session-relative",
    captureTimelineWindowEndPct: null,
    captureTimelineWindowStartPct: null,
    captureTimelineZoom: 100,
    captureViewMode: "list",
    composer: {
      conversationId: "",
      conversationKind: "direct",
      senderId: "",
      senderName: "",
      text: "",
    },
    error: null,
    evidence: null,
    evidenceArtifactFilter: "all",
    evidenceError: null,
    evidenceLoading: false,
    evidencePathDraft: "",
    evidenceSearchText: "",
    evidenceStatusFilter: "all",
    latestReport: null,
    runnerDraft: null,
    runnerDraftDirty: false,
    runnerPlanOverride: null,
    scenarioRun: null,
    selectedCaptureEventKey: null,
    selectedCaptureSessionIds: [],
    selectedConversationKey: null,
    selectedEvidenceEntryKey: null,
    selectedScenarioId: null,
    selectedThreadId: null,
    sidebarCollapsed: false,
    sidebarPanel: "scenarios",
    snapshot: null,
    theme: "light",
    ...overrides,
  };
}

function renderState(overrides: Partial<UiState>): string {
  return renderQaLabUi(evidenceState(overrides));
}

describe("QA Lab sidebar rendering", () => {
  it.each([
    ["chat", false, false],
    ["results", false, false],
    ["evidence", false, true],
    ["report", false, false],
    ["events", false, false],
    ["capture", true, true],
  ] as const)(
    "renders %s with sidebarCollapsed=%s and inert=%s",
    (activeTab, sidebarCollapsed, inert) => {
      const state = evidenceState({ activeTab, sidebarCollapsed, sidebarPanel: "config" });
      const html = renderQaLabUi(state);
      const sidebar = html.match(/<aside class="sidebar(?:\s[^"]*)?"[^>]*>/gu);

      expect(sidebar).toHaveLength(1);
      expect(/\sinert(?:\s|=|>)/u.test(sidebar![0]!)).toBe(inert);
      expect(html).toContain('<select id="provider-mode">');
      expect(html).toContain('data-sidebar-panel="config"');
      expect(html).toContain('data-action="toggle-sidebar"');
      expect(state.sidebarCollapsed).toBe(sidebarCollapsed);
      expect(state.sidebarPanel).toBe("config");
    },
  );
});

function capturePayloadState(
  payload: string,
  layout: UiState["capturePayloadDetailLayout"],
  overrides: Partial<UiState["captureEvents"][number]> = {},
): UiState {
  const event = {
    contentType: "application/json",
    dataText: payload,
    direction: "outbound",
    flowId: "flow-1",
    host: "api.example.test",
    id: 1,
    kind: "request",
    method: "POST",
    path: "/v1/messages",
    payloadPreview: payload,
    protocol: "https",
    provider: "mock",
    ts: 1,
    ...overrides,
  };
  return evidenceState({
    activeTab: "capture",
    captureDetailView: "payload",
    capturePayloadDetailLayout: layout,
    captureEvents: [event],
    selectedCaptureEventKey: `1:flow-1:1:${event.kind}`,
  });
}

describe("QA Lab UI evidence render", () => {
  it.each([
    ["channel", "direct", ["shared (account-a)", "shared (account-b)"]],
    [
      "group",
      "channel",
      ["shared (group, account-a)", "shared (group, account-b)", "shared (channel, account-a)"],
    ],
  ] as const)(
    "isolates same-id %s conversations by account and kind",
    (kind, otherKind, labels) => {
      const selectedConversationKey = JSON.stringify(["account-a", kind, "shared"]);
      const conversation = { id: "shared", kind };
      const sameKind = {
        conversation,
        direction: kind === "group" ? "inbound" : "outbound",
      } as const;
      const composer = evidenceState().composer;
      if (kind === "group") {
        Object.assign(composer, {
          conversationId: "shared",
          conversationKind: kind,
          senderId: "alice",
          senderName: "Alice",
        });
      }
      const html = renderState({
        activeTab: "chat",
        selectedConversationKey,
        composer,
        snapshot: {
          conversations: [
            { accountId: "account-a", id: "shared", kind },
            { accountId: "account-b", id: "shared", kind },
            { accountId: "account-a", id: "shared", kind: otherKind },
            ...(kind === "group"
              ? [{ accountId: "account-a", id: "shared", kind: "direct" as const }]
              : []),
          ],
          cursor: 0,
          events: [],
          messages: [
            message("selected message", sameKind),
            message("foreign message", { ...sameKind, accountId: "account-b", timestamp: 2 }),
            message("other kind message", {
              conversation: { id: "shared", kind: otherKind },
              timestamp: 3,
            }),
          ],
          threads:
            kind === "channel"
              ? [
                  thread("selected-thread", "Selected thread"),
                  thread("foreign-thread", "Foreign thread", { accountId: "account-b" }),
                ]
              : [],
        },
      });
      expectMarkup(
        html,
        [
          "selected message",
          ...labels,
          `data-conversation-key="${selectedConversationKey.replaceAll('"', "&quot;")}"`,
        ],
        ["foreign message", "other kind message"],
      );
      if (kind === "channel") {
        expectMarkup(html, ["Selected thread"], ["Foreign thread"]);
        const crossAccountKindHtml = renderState({
          activeTab: "chat",
          snapshot: {
            conversations: [
              { accountId: "account-a", id: "shared", kind: "group" },
              { accountId: "account-b", id: "shared", kind: "channel" },
            ],
            cursor: 0,
            events: [],
            messages: [],
            threads: [],
          },
        });
        expectMarkup(crossAccountKindHtml, [
          "shared (group, account-a)",
          "shared (channel, account-b)",
        ]);
      } else {
        expect(html).toContain('<option value="group" selected>Group</option>');
      }
    },
  );

  it("keeps thread replies out of the root timeline when thread navigation exists", () => {
    const selectedConversationKey = JSON.stringify(["default", "channel", "qa-room"]);
    const room = {
      accountId: "default",
      conversation: { id: "qa-room", kind: "channel" },
    } as const;
    const snapshot: NonNullable<UiState["snapshot"]> = {
      conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
      cursor: 0,
      events: [],
      messages: [
        message("root timeline message", room),
        message("thread-only reply", {
          ...room,
          threadId: "owned-thread",
          timestamp: 2,
        }),
        message("externally observed thread reply", {
          ...room,
          threadId: "external-thread",
          timestamp: 3,
        }),
      ],
      threads: [
        thread("owned-thread", "Owned thread", { accountId: "default", conversationId: "qa-room" }),
      ],
    };

    const rootHtml = renderState({ activeTab: "chat", selectedConversationKey, snapshot });
    expect(rootHtml).toContain("Main timeline");
    expect(rootHtml).toContain("root timeline message");
    expect(rootHtml).not.toContain("thread-only reply");
    expect(rootHtml).toContain("externally observed thread reply");

    const threadHtml = renderState({
      activeTab: "chat",
      selectedConversationKey,
      selectedThreadId: "owned-thread",
      snapshot,
    });
    expect(threadHtml).not.toContain("root timeline message");
    expect(threadHtml).toContain("thread-only reply");
    expect(threadHtml).not.toContain("externally observed thread reply");

    const externalThreadHtml = renderState({
      activeTab: "chat",
      selectedConversationKey,
      snapshot: { ...snapshot, threads: [] },
    });
    expect(externalThreadHtml).toContain("thread-only reply");
  });

  it("renders capture filters with escaped options, selections, and bounded sizes", () => {
    const kinds = ["response", 'custom<"&>', "request", "ws-frame"];
    const hosts = ["g.test", "a.test", "f.test", "b.test", 'c<"&>.test', "e.test", "d.test"];
    const html = renderState({
      activeTab: "capture",
      captureEvents: hosts.map((host, index) => ({
        direction: "outbound",
        flowId: `flow-${index}`,
        host,
        kind: kinds[index % kinds.length]!,
        protocol: "https",
        provider: 'provider<"&>',
        ts: index,
      })),
      captureHostFilter: ['c<"&>.test', "g.test"],
      captureKindFilter: ['custom<"&>', "response"],
      captureProviderFilter: ['provider<"&>'],
    });
    const controls = [
      ...html.matchAll(
        /<label>(Kind|Provider|Host)\s+<select id="([^"]+)" multiple size="(\d+)">([\s\S]*?)<\/select>/g,
      ),
    ];

    expect(controls.map(([, label, id, size]) => [label, id, Number(size)])).toEqual([
      ["Kind", "capture-kind-filter", 4],
      ["Provider", "capture-provider-filter", 3],
      ["Host", "capture-host-filter", 6],
    ]);
    expect(controls.map((match) => match[4]?.match(/<option[^>]*>[\s\S]*?<\/option>/g))).toEqual([
      [
        '<option value="custom&lt;&quot;&amp;&gt;" selected>custom&lt;&quot;&amp;&gt;</option>',
        '<option value="request">request</option>',
        '<option value="response" selected>response</option>',
        '<option value="ws-frame">ws-frame</option>',
      ],
      ['<option value="provider&lt;&quot;&amp;&gt;" selected>provider&lt;&quot;&amp;&gt;</option>'],
      [
        '<option value="a.test">a.test</option>',
        '<option value="b.test">b.test</option>',
        '<option value="c&lt;&quot;&amp;&gt;.test" selected>c&lt;&quot;&amp;&gt;.test</option>',
        '<option value="d.test">d.test</option>',
        '<option value="e.test">e.test</option>',
        '<option value="f.test">f.test</option>',
        '<option value="g.test" selected>g.test</option>',
      ],
    ]);
  });

  it.each([
    ["most-errors", ["a.test", "z.test", "m.test"]],
    ["severity", ["z.test", "m.test", "a.test"]],
    ["alphabetical", ["a.test", "m.test", "z.test"]],
  ] as const)("orders capture lanes by %s with the same displayed severity", (sort, hosts) => {
    const html = renderState({
      activeTab: "capture",
      captureViewMode: "timeline",
      captureTimelineLaneSort: sort,
      selectedCaptureEventKey: "1:selected:1000:request",
      captureEvents: [
        { host: "z.test", flowId: "selected", ts: 1000, status: 500 },
        { host: "a.test", flowId: "other", ts: 2000, errorText: "connection failed" },
        { host: "m.test", flowId: "selected", ts: 3000 },
        { host: "a.test", flowId: "other", ts: 4000 },
      ].map((event, index) =>
        Object.assign(event, {
          id: index + 1,
          kind: "request",
          direction: "outbound",
          protocol: "https",
        }),
      ),
    });

    expect(
      [...html.matchAll(/data-capture-lane-toggle="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(hosts);
    if (sort === "severity") {
      expect(html).toContain("severity 77.2");
      expect(html).toContain("severity 41.2");
      expect(html).toContain("severity 33.4");
      expect(html).toContain("1 errors (100%) · focused flow 100% · active now · 1 events");
    }
  });

  it("maps blocked and skipped evidence statuses to styled tones", () => {
    const html = renderState({
      evidence: gallery({
        counts: { blocked: 1, fail: 0, pass: 0, skipped: 1 },
        entries: [
          evidenceEntry("blocked", {
            coverage: [{ id: "qa.blocked", role: "primary" }],
            failureReason: "Environment unavailable",
          }),
          evidenceEntry("skipped", {
            coverage: [{ id: "qa.skipped", role: "primary" }],
            key: "1",
            kind: "vitest-test",
          }),
        ],
      }),
      selectedEvidenceEntryKey: "0",
    });

    expectMarkup(
      html,
      ["badge-pending", "badge-skip", "scenario-item-dot-pending", "scenario-item-dot-skip"],
      ["badge-blocked", "badge-skipped", "scenario-item-dot-blocked"],
    );
  });

  it("links executed UX Matrix cells to evidence entries and leaves proof gaps unlinked", () => {
    const html = renderState({
      evidence: gallery({
        counts: { blocked: 0, fail: 0, pass: 1, skipped: 0 },
        entries: [
          evidenceEntry("pass", {
            artifacts: [
              artifact("screenshot.png", "screenshot", "image"),
              artifact("recording.gif", "motion-preview-gif", "image"),
              artifact("recording.webm", "video", "video"),
            ],
            id: "ux-matrix.web-ui.first-run",
            kind: "ux-matrix-cell",
            title: "UX Matrix: web-ui / first-run",
          }),
        ],
        producerContext: {
          commands: null,
          kind: "ux-matrix",
          manifest: {
            href: "/api/evidence/artifact?artifactPath=manifest.json",
            path: "manifest.json",
            preview: null,
            runId: "run-1",
            runStatus: "pass",
          },
          matrix: {
            cells: [
              matrixCell("web-ui", "web-ui-playwright", "0"),
              matrixCell("cli", "cli-status", null),
            ],
            counts: { pass: 1, "proof-gap": 1 },
            path: "matrix.json",
            stages: ["first-run"],
            surfaces: ["cli", "web-ui"],
          },
          preflight: { adbDevices: null, memory: null },
          releaseLedger: null,
          rootPath: ".artifacts/qa-e2e/suite/script/ux-matrix-producer/run-1",
          scorecard: null,
        },
      }),
      selectedEvidenceEntryKey: "0",
    });

    expectMarkup(
      html,
      [
        'data-evidence-entry-key="0"',
        "evidence-matrix-cell-proof-gap",
        "not executed in this run",
        "Runner: cli-status",
        "Open media artifact",
        "Open video artifact",
      ],
      [
        "Coverage:",
        'src="/api/evidence/artifact?artifactPath=recording.gif"',
        "<video controls",
        'data-evidence-entry-key="null"',
      ],
    );
  });

  it("redacts secret-like capture payload fields in raw previews", () => {
    const payload =
      '{"message":"visible context","message":"duplicate context","completion_tokens":100,"cookies":["session=abc"],"apiToken":"secret-token","tokenValue":"token-value-secret","authTokens":["auth-token-secret"],"tokens":{"refresh":"refresh-token-secret"},"AWS_SECRET_ACCESS_KEY":"aws-secret","secretAccessKey":"access-secret","x-goog-api-key":"goog-secret","nested":{"password":"secret-password"}}';
    const html = renderQaLabUi(capturePayloadState(payload, "raw"));

    expectMarkup(html, [
      "visible context",
      "duplicate context",
      "completion_tokens",
      "100",
      "apiToken",
      "nested",
      "[redacted]",
    ]);
    expect(html).not.toMatch(
      /session=abc|secret-token|token-value-secret|auth-token-secret|refresh-token-secret|aws-secret|access-secret|goog-secret|secret-password/,
    );
  });

  it("redacts secret-like fields when captured JSON previews are truncated", () => {
    const payload =
      '{"apiToken":"secret-token","nested":{"password":"secret-password"},"message":"visible context"';
    for (const capturePayloadDetailLayout of ["raw", "formatted"] as const) {
      const html = renderQaLabUi(capturePayloadState(payload, capturePayloadDetailLayout));

      expectMarkup(html, ["visible context", "[redacted]"], ["secret-token", "secret-password"]);
    }
  });

  it("redacts secret-like SSE data fields in formatted payloads", () => {
    const payload = 'event: message\ndata: {"apiToken":"secret-token","message":"visible"}';
    const html = renderQaLabUi(
      capturePayloadState(payload, "formatted", {
        contentType: "text/event-stream",
        direction: "inbound",
        kind: "response",
        method: undefined,
      }),
    );

    expectMarkup(html, ["visible", "[redacted]"], ["secret-token"]);
  });

  it("redacts secret-like fields when capture cuts inside a JSON value", () => {
    const payload = '{"apiToken":"secret-token';
    const html = renderQaLabUi(capturePayloadState(payload, "raw"));

    expectMarkup(html, ["[redacted]"], ["secret-token"]);
  });

  it("keeps the bounded capture tail free of lone surrogates", () => {
    const payload = `${"a".repeat(350)}😀${"z".repeat(79)}`;
    const html = renderQaLabUi(capturePayloadState(payload, "raw", { contentType: "text/plain" }));
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

    expect(html).not.toMatch(loneSurrogate);
  });
});
