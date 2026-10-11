import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardExecution,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  createLoadedWorkboardState,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
  textButton,
  sessionPicker,
} from "./view.test-support.ts";

describe("WorkboardView", () => {
  it.each([
    {
      name: "direct",
      expected: "agent:work:dashboard-panel-close",
      sessionAgentId: "work",
    },
    {
      name: "resolved",
      expected: "agent:main:subagent:workboard-default-card-1",
      sessionAgentId: undefined,
    },
    { name: "missing", expected: undefined, sessionAgentId: undefined },
  ])("binds the session summary to its $name owner", ({ name, expected, sessionAgentId }) => {
    const sessionKey = name === "direct" ? expected : "subagent:workboard-default-card-1";
    const onOpenSession = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      onOpenSession,
      sessions: expected
        ? [
            createGatewaySession({
              key: expected,
              ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
            }),
          ]
        : [],
      sessionResolution:
        name === "direct"
          ? undefined
          : expected
            ? {
                key: "subagent:workboard-default-card-1",
                status: "resolved",
                session: createGatewaySession({ key: expected }),
              }
            : {
                key: "subagent:workboard-default-card-1",
                status: "unavailable",
              },
    });
    state.cards = [
      createWorkboardCard({ agentId: name === "direct" ? "reassigned" : "worker", sessionKey }),
    ];
    state.detailCardId = "card-1";
    state.detailTab = "session";
    const mount = vi.mocked(workboardTestHost().host.components.mountSessionSummary);
    renderView();
    const open = container.querySelector<HTMLButtonElement>(
      ".workboard-detail .workboard-detail__session-link",
    );
    if (expected) {
      const session = {
        sessionKey: expected,
        ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
      };
      expect(mount).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ session }),
      );
      if (name === "direct") {
        const handle = mount.mock.results[0]!.value;
        state.detailCardId = null;
        renderView();
        expect(handle.dispose).toHaveBeenCalledOnce();
        expect(container.querySelector("[data-test-session-summary]")).toBeNull();
      } else {
        expectDefined(open, "resolved session action").click();
        expect(onOpenSession).toHaveBeenCalledWith(session);
      }
    } else {
      expect(mount).not.toHaveBeenCalled();
      expect(open).toBeNull();
    }
  });

  it("preserves error visibility and dismissal through details dialogs", async () => {
    const { state, container, renderView } = createWorkboardView();
    const card = createWorkboardCard();
    state.cards = [card];
    state.detailCardId = card.id;
    const pageError = "Metadata unavailable. Linked session unavailable.";
    const expectError = async (message: string) => {
      await waitForFast(() => {
        const visible = container.querySelectorAll("openclaw-workboard-toast:not([hidden])");
        expect(visible).toHaveLength(1);
        expect(visible[0]?.querySelector('[role="alert"]')?.textContent).toBe(message);
      });
    };
    renderView({ pageError });
    await expectError(pageError);
    state.error = "Save denied";
    renderView({ pageError });
    await expectError("Save denied");
    state.error = null;
    renderView({ pageError });
    await expectError(pageError);
    const dialogToast = expectDefined(
      container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])"),
      "openclaw-workboard-toast:not([hidden])",
    );
    expectDefined(
      dialogToast?.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
      'button[aria-label="Close"]',
    ).click();
    await waitForFast(() => {
      expect(dialogToast?.querySelector('[role="alert"]')).toBeNull();
    });
    state.detailCardId = null;
    state.bulkDialog = null;
    state.draftOpen = false;
    state.draftDiscardOpen = false;
    renderView({ pageError });
    const active = expectDefined(
      container.querySelector<HTMLElement>("openclaw-workboard-toast:not([hidden])"),
      "openclaw-workboard-toast:not([hidden])",
    );
    flush();
    expect(active?.querySelector('[role="alert"]')).toBeNull();
    // Recovery makes a subsequent identical failure a new visible outcome.
    renderView({ pageError: undefined });
    flush();
    expect(active?.querySelector('[role="alert"]')).toBeNull();
    renderView({ pageError });
    await expectError(pageError);
  });

  it.each([
    { label: "id", failedId: "a", completedId: "z", failedSequence: 1, completedSequence: 1 },
    {
      label: "legacy entry",
      failedId: "z",
      completedId: "a",
      failedSequence: 1,
      completedSequence: undefined,
    },
  ])(
    "does not show an obsolete same-time failure after completion ordered by $label",
    ({ failedId, completedId, completedSequence }) => {
      const { state, container, renderView } = createWorkboardView();
      state.cards = [
        createWorkboardCard({
          status: "blocked",
          runId: "current-run",
          metadata: {
            notifications: [
              {
                id: failedId,
                kind: "failed",
                createdAt: 2,
                sequence: 1,
                runId: "current-run",
                message: "Obsolete run failure.",
              },
              {
                id: completedId,
                kind: "completed",
                createdAt: 2,
                sequence: completedSequence,
                runId: "current-run",
                message: "Run completed.",
              },
            ],
          },
        }),
      ];
      renderView();
      expect(container.querySelector(".workboard-card__alert")).toBeNull();
      expect(container.textContent).not.toContain("Obsolete run failure.");
    },
  );

  it("preserves full diagnostic text in the list card's accessible description", () => {
    const sentinel = "SYNTHETIC_PRIVATE_OUTPUT";
    vi.mocked(workboardTestHost().host.redact).mockImplementation((text) =>
      text.replaceAll(sentinel, "[redacted]"),
    );
    const { state, container, renderView } = createWorkboardView();
    state.viewMode = "list";
    state.cards = [
      createWorkboardCard({
        id: "card-boundary",
        title: "Boundary badge",
        metadata: {
          diagnostics: [
            {
              kind: "orphaned_session",
              severity: "error",
              title: `${"x".repeat(158)}🚀tail ${sentinel}`,
              detail: `Boundary detail. ${sentinel}`,
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
              actions: [],
            },
            {
              kind: "missing_proof",
              severity: "warning",
              title: "Release verification",
              detail: "The supporting evidence is still missing.",
              firstSeenAt: 1,
              lastSeenAt: 1,
              count: 1,
              actions: [],
            },
          ],
        },
      }),
    ];
    renderView();
    expect(container.querySelector(".workboard-card__alert--error")?.textContent?.trim()).toBe(
      `${"x".repeat(158)}🚀tail [redacted]`,
    );
    expect(container.querySelector(".workboard-card__alert")?.getAttribute("title")).toContain(
      `${"x".repeat(158)}🚀tail`,
    );
    const card = expectDefined(
      container.querySelector<HTMLElement>(".workboard-card"),
      ".workboard-card",
    );
    const descriptionId = expectDefined(
      card.getAttribute("aria-describedby"),
      "alert description ID",
    );
    const description = expectDefined(document.getElementById(descriptionId), "alert description");
    expect(description.textContent).toContain(`${"x".repeat(158)}🚀tail`);
    expect(description.textContent).toContain("Boundary detail.");
    expect(description.textContent).toContain("Release verification");
    expect(description.textContent).toContain("The supporting evidence is still missing.");
    expect(description.textContent).toContain("Boundary detail. [redacted]");
    expect(description.textContent).not.toContain(sentinel);
    expect(container.querySelector(".workboard-card__alert")?.getAttribute("title")).not.toContain(
      sentinel,
    );
  });

  it("does not render Invalid Date for Date-invalid card timestamps", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Bad timestamp card",
        updatedAt: 8_640_000_000_000_001,
        events: [{ id: "event-1", kind: "edited", at: 8_640_000_000_000_001 }],
        metadata: {
          attempts: [
            {
              id: "attempt-1",
              status: "failed",
              startedAt: 8_640_000_000_000_001,
              endedAt: 8_640_000_000_000_001,
              error: "Attempt evidence survives invalid dates",
            },
          ],
          proof: [
            {
              id: "proof-1",
              status: "passed",
              createdAt: 8_640_000_000_000_001,
              label: "Proof evidence survives invalid dates",
            },
          ],
        },
      }),
    ];
    renderView();
    expect(container.textContent).toContain("Bad timestamp card");
    expect(container.querySelector(".workboard-card__updated")).toBeNull();
    expect(container.textContent).not.toContain("Invalid Date");
    buttonByLabel(container, "View details")!.click();
    renderView();
    buttonByText(container.querySelector('[role="tablist"]')!, "Details")!.click();
    renderView();
    const details = expectDefined(
      container.querySelector<HTMLElement>("#workboard-detail-panel-details"),
      "#workboard-detail-panel-details",
    );
    expect(details.textContent).toContain("Attempt evidence survives invalid dates");
    expect(details.textContent).toContain("Proof evidence survives invalid dates");
    expect(details.textContent).not.toContain("Invalid Date");
  });

  it("opens board card details without hijacking action buttons", async () => {
    const onOpenSession = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        {
          key: "agent:main:dashboard:1",
          kind: "direct",
          displayName: "Dashboard session",
          updatedAt: 2,
          hasActiveRun: true,
          status: "running",
        },
      ],
      onOpenSession,
    });
    state.viewMode = "board";
    state.cards = [
      createWorkboardCard({
        title: "Inspect a running task",
        status: "running",
        sessionKey: "agent:main:dashboard:1",
      }),
    ];
    renderView();
    const card = expectDefined(
      container.querySelector<HTMLElement>(".workboard-card"),
      ".workboard-card",
    );
    expect(card.getAttribute("aria-pressed")).toBeNull();
    expect(card.getAttribute("aria-haspopup")).toBe("dialog");
    requireButton(card, "Open session").click();
    expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:dashboard:1" });
    expect(state.detailCardId).toBeNull();
    expect(container.querySelector(".workboard-detail")).toBeNull();
    onOpenSession.mockClear();
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    await waitForFast(() =>
      expect(container.querySelector(".workboard-detail")?.textContent).toContain(
        "Inspect a running task",
      ),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("shows completed session identity without repeating a synthetic completion summary", () => {
    const onOpenSession = vi.fn();
    const sessionKey = "agent:main:completed-review";
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        {
          key: sessionKey,
          kind: "direct",
          displayName: "Release review",
          updatedAt: 2,
          status: "done",
          hasActiveRun: false,
        },
      ],
      onOpenSession,
    });
    state.cards = [createWorkboardCard({ status: "done", sessionKey })];
    state.detailCardId = "card-1";
    renderView();
    for (const tab of ["Overview", "Session"]) {
      textButton(container.querySelector('[role="tablist"]')!, tab).click();
      renderView();
      const panel = expectDefined(
        container.querySelector<HTMLElement>(".workboard-detail__tabpanel:not([hidden])"),
        ".workboard-detail__tabpanel:not([hidden])",
      );
      expect(panel.querySelector(".workboard-detail__session-name")?.textContent).toContain(
        "Release review",
      );
      expect(panel.querySelector(".workboard-session-badge")?.textContent).toBe("Done");
      expect(panel.textContent).not.toContain("Run completed");
      requireButton(panel, "Open session").click();
      expect(onOpenSession).toHaveBeenLastCalledWith({ sessionKey });
    }
  });

  it("keeps queued session context readable until an outside pointer dismisses it", async () => {
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        {
          key: "agent:main:queued",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: true,
          status: "queued",
        },
      ],
    });
    state.cards = [createWorkboardCard({ status: "todo", sessionKey: "agent:main:queued" })];
    renderView();
    const status = expectDefined(
      container.querySelector<HTMLElement>("openclaw-workboard-session-status"),
      "openclaw-workboard-session-status",
    );
    expect(status.textContent).toContain("Queued");
    expect(container.querySelector(".workboard-card__session-marker")).toBeNull();
    expect(
      container.querySelector(".workboard-card__session-marker .session-run-spinner"),
    ).toBeNull();
    expect(container.querySelector(".workboard-card__session-name")?.textContent?.trim()).toBe(
      "Session",
    );
    flush();
    const trigger = expectDefined(
      status.querySelector<HTMLButtonElement>(".workboard-session-status__trigger"),
      ".workboard-session-status__trigger",
    );
    const panel = expectDefined(
      status.querySelector<HTMLElement>(".workboard-session-status__popover"),
      ".workboard-session-status__popover",
    );
    if (typeof panel.showPopover !== "function") {
      Object.defineProperty(panel, "showPopover", { configurable: true, value: vi.fn() });
    }
    const removeListener = vi.spyOn(document, "removeEventListener");
    try {
      // Pointer activation focuses the button before its click opens the explanation.
      trigger.focus();
      trigger.click();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(state.detailCardId).toBeNull();
      panel.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
      expect(trigger.getAttribute("aria-expanded")).toBe("true");

      // A nonfocusable outside target must dismiss even if the trigger retains focus.
      container.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
      expect(document.activeElement).toBe(trigger);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      trigger.click();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      state.cards = [];
      renderView();
      expect(status.isConnected).toBe(false);
      expect(removeListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    } finally {
      removeListener.mockRestore();
    }
  });

  it("renders card event history", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({
        title: "Tracked task",
        status: "review",
        updatedAt: 2,
        events: [
          { id: "event-1", kind: "moved", at: 1, fromStatus: "triage", toStatus: "backlog" },
          { id: "event-2", kind: "moved", at: 2, fromStatus: "backlog", toStatus: "todo" },
          { id: "event-3", kind: "moved", at: 3, fromStatus: "todo", toStatus: "scheduled" },
          { id: "event-4", kind: "moved", at: 4, fromStatus: "scheduled", toStatus: "ready" },
          { id: "event-5", kind: "moved", at: 5, fromStatus: "ready", toStatus: "running" },
          { id: "event-6", kind: "moved", at: 6, fromStatus: "running", toStatus: "review" },
          { id: "event-7", kind: "moved", at: 7, fromStatus: "review", toStatus: "done" },
        ],
      }),
    ];
    renderView();
    expect(container.querySelector(".workboard-events")).toBeNull();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Moved to Done");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Moved to Backlog");
  });

  it("renders card metadata badges and hides archived cards", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        title: "Metadata rich",
        metadata: {
          templateId: "plugin",
          attempts: [{ id: "run-1", status: "blocked", startedAt: 1, endedAt: 2 }],
          failureCount: 1,
          comments: [{ id: "comment-1", body: "Needs owner check", createdAt: 3 }],
          links: [{ id: "link-1", type: "relates_to", url: "https://example.com", createdAt: 4 }],
          workerProtocol: {
            state: "blocked",
            detail: "Worker asked for owner input.",
            updatedAt: 12,
          },
          automation: {
            tenant: "ops",
            boardId: "quality",
            skills: ["review", "test"],
            workspace: { kind: "worktree", path: "/tmp/workboard", branch: "proof" },
            dispatchCount: 3,
            summary: "Ready for review.",
          },
          proof: Array.from({ length: 7 }, (_, index) => ({
            id: `proof-${index + 1}`,
            status: "passed",
            command: `pnpm test ${index + 1}`,
            url: `https://example.com/proof-${index + 1}`,
            createdAt: 5 + index,
          })),
          stale: { detectedAt: 6, reason: "No recent activity." },
        },
      }),
      createWorkboardCard({
        id: "card-2",
        title: "Archived task",
        position: 2000,
        metadata: { archivedAt: 7 },
      }),
    ];
    renderView();
    expect(container.querySelector(".workboard-card")?.textContent).not.toContain("Plugin");
    expect(
      container.querySelector('.workboard-card__counts [aria-label="1 failed"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.workboard-card__counts [aria-label="1 comments"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('.workboard-card__counts [aria-label="7 proof"]'),
    ).not.toBeNull();
    expect(container.querySelector(".workboard-card__alert")?.textContent).toContain("Stale");
    expect(container.querySelector(".workboard-card__alert")?.getAttribute("title")).toContain(
      "No recent activity.",
    );
    expect(container.textContent).not.toContain("Archived task");
    const archivedToggle = expectDefined(
      container.querySelector<HTMLInputElement>('.workboard-filter-archived input[role="switch"]'),
      '.workboard-filter-archived input[role="switch"]',
    );
    archivedToggle.checked = true;
    archivedToggle.dispatchEvent(new Event("change", { bubbles: true }));
    renderView();
    expect(container.textContent).toContain("Archived task");
    expect(archivedToggle.checked).toBe(true);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("1 attempts");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("1 links");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("pnpm test 1");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("pnpm test 7");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "https://example.com/proof-7",
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Worker protocol");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "Worker asked for owner input.",
    );
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("Card automation");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("ops");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain("review, test");
    expect(container.querySelector(".workboard-detail")?.textContent).toContain(
      "worktree · /tmp/workboard · proof",
    );
  });

  it("keeps visible archived cards inspectable and restorable without move or drag controls", async () => {
    const archivedCard = createWorkboardCard({
      title: "Archived historical task",
      metadata: { archivedAt: 10 },
    });
    const request = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
    });
    state.cards = [archivedCard];
    state.showArchived = true;
    renderView();
    const article = container.querySelector<HTMLElement>(".workboard-card--archived");
    expect(article).not.toBeNull();
    expect(article?.getAttribute("draggable")).toBe("false");
    expect(article?.querySelector(".workboard-card__move-select")).toBeNull();
    expect(buttonByLabel(article!, "Restore from archive")).not.toBeNull();
    expect(
      article!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(state.draggedCardId).toBeNull();
    state.draggedCardId = archivedCard.id;
    container
      .querySelector(".workboard-column--running")
      ?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(request).not.toHaveBeenCalled();
    state.draggedCardId = null;
    state.detailCardId = archivedCard.id;
    renderView();
    const drawer = container.querySelector<HTMLElement>(".workboard-detail");
    expectDefined(
      drawer?.querySelector<HTMLElement>("workboard-inline-text"),
      "workboard-inline-text",
    );
    flush();
    expect(drawer?.textContent).toContain(archivedCard.title);
    expect(drawer?.querySelector(".workboard-card__move-select")).toBeNull();
    expect(buttonByLabel(drawer!, "Restore from archive")).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("shows stale lifecycle on executed linked cards", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(60 * 60 * 1000);
    try {
      const { host, state } = createLoadedWorkboardState();
      state.cards = [
        createWorkboardCard({
          title: "Watch stale run",
          status: "running",
          execution: {
            id: "exec-1",
            kind: "agent-session",
            engine: "codex",
            mode: "autonomous",
            status: "running",
            model: "openai/gpt-5.5",
            sessionKey: "agent:main:dashboard:1",
            startedAt: 1,
            updatedAt: 1,
          },
        }),
      ];
      const { container, renderView } = createWorkboardView(
        {
          sessions: [
            {
              key: "agent:main:dashboard:1",
              kind: "direct",
              displayName: "Dashboard session",
              updatedAt: 1,
              hasActiveRun: false,
              status: "running",
            },
          ],
        },
        host,
      );
      renderView();
      await vi.waitFor(() =>
        expect(
          container.querySelector(".workboard-session-status__trigger")?.textContent,
        ).toContain("Stale"),
      );
      expect(container.querySelector(".workboard-session-status__detail")?.textContent).toContain(
        "No recent session activity",
      );
      expect(container.querySelector(".workboard-card__session-marker")).toBeNull();
      expect(container.textContent).not.toContain("codex autonomous");
      expect(container.querySelector(".workboard-live")).toBeNull();
      expect(container.querySelector('button[aria-label="Stop session"]')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([
    {
      scenario: "an execution-owned linked session",
      sessionKey: "agent:main:execution-linked-session",
      topLevelSessionKey: undefined,
    },
    {
      scenario: "the authoritative top-level session",
      sessionKey: "agent:main:top-level-linked-session",
      topLevelSessionKey: "agent:main:top-level-linked-session",
    },
  ])("preserves $scenario when editing a Workboard card", async (testCase) => {
    const card = createWorkboardCard({
      title: "Keep my linked session",
      ...(testCase.topLevelSessionKey ? { sessionKey: testCase.topLevelSessionKey } : {}),
      execution: createWorkboardExecution({ sessionKey: "agent:main:execution-linked-session" }),
    });
    const request = vi.fn(async () => ({
      card: { ...card, title: "Renamed without unlinking", updatedAt: 2 },
    }));
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
      onRequestUpdate: () => undefined,
      sessions: [
        {
          key: testCase.sessionKey,
          kind: "direct",
          displayName: "Active linked session",
          updatedAt: 1,
          status: "running",
        },
      ],
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const editButton = buttonByLabel(container, "Edit card");
    expect(editButton).not.toBeNull();
    editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(state.draftSessionKey).toBe(testCase.sessionKey);
    expect(sessionPicker(container).value).toBe(testCase.sessionKey);
    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title).not.toBeNull();
    title!.value = "Renamed without unlinking";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { title: "Renamed without unlinking" },
    });
    expect(state.cards[0]?.execution?.sessionKey).toBe("agent:main:execution-linked-session");
    renderView();
    state.detailTab = "session";
    renderView();
    expect(container.querySelector("[data-test-session-summary]")).not.toBeNull();
  });

  it("preserves explicit archive visibility (success=true, showArchived=false)", async () => {
    const card = createWorkboardCard({ title: "Archive from drawer", notes: "", labels: [] });
    const client = createWorkboardTestClient(() => {
      return { card: { ...card, metadata: { ...card.metadata, archivedAt: 2 } } };
    });
    const { state, container, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => renderView(),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    state.showArchived = false;
    renderView();
    requireButton(container.querySelector(".workboard-detail__menu")!, "Archive card").click();
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: card.id,
      archived: true,
    });
    expect(container.querySelector(".workboard-detail")).toBeNull();
  });
});
