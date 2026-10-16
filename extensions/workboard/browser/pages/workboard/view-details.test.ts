import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardExecution,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import {
  fill,
  query,
  createWorkboardView,
  buttonByLabel,
  buttonByText,
  requireButton,
  textButton,
  sessionPicker,
  submitForm,
} from "./view.test-support.ts";

function expectText(element: Element | null, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(element?.textContent).toContain(fragment);
  }
}

function detailView(
  card: Parameters<typeof createWorkboardCard>[0] = {},
  props: Parameters<typeof createWorkboardView>[0] = {},
  session?: Parameters<typeof createGatewaySession>[0],
) {
  const view = createWorkboardView({
    ...props,
    ...(session && { sessions: [createGatewaySession(session)] }),
  });
  view.state.cards = [createWorkboardCard(card)];
  return view;
}

describe("WorkboardView", () => {
  it.each([
    ["direct", "agent:work:dashboard-panel-close", "work"],
    ["resolved", "agent:main:subagent:workboard-default-card-1", undefined],
    ["missing", undefined, undefined],
  ])("binds the session summary to its %s owner", (name, expected, sessionAgentId) => {
    const sessionKey = name === "direct" ? expected : "subagent:workboard-default-card-1";
    const onOpenSession = vi.fn();
    const { find, state, renderView } = createWorkboardView({
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
            : { key: "subagent:workboard-default-card-1", status: "unavailable" },
    });
    state.cards = [
      createWorkboardCard({ agentId: name === "direct" ? "reassigned" : "worker", sessionKey }),
    ];
    state.detailCardId = "card-1";
    state.detailTab = "session";
    const mount = vi.mocked(workboardTestHost().host.components.mountSessionSummary);
    renderView();
    const open = find<HTMLButtonElement>(".workboard-detail .workboard-detail__session-link");
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
        expect(find("[data-test-session-summary]")).toBeNull();
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
    const { get, all, state, renderView } = detailView();
    state.detailCardId = "card-1";
    const pageError = "Metadata unavailable. Linked session unavailable.";
    const expectError = async (message: string) => {
      await waitForFast(() => {
        const visible = all("openclaw-workboard-toast:not([hidden])");
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
    const dialogToast = get("openclaw-workboard-toast:not([hidden])");
    query<HTMLButtonElement>(dialogToast, 'button[aria-label="Close"]').click();
    await waitForFast(() => {
      expect(dialogToast?.querySelector('[role="alert"]')).toBeNull();
    });
    state.detailCardId = null;
    renderView({ pageError });
    const active = get("openclaw-workboard-toast:not([hidden])");
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
    { label: "id", failedId: "a", completedId: "z", completedSequence: 1 },
    { label: "legacy entry", failedId: "z", completedId: "a", completedSequence: undefined },
  ])(
    "does not show an obsolete same-time failure after completion ordered by $label",
    ({ failedId, completedId, completedSequence }) => {
      const { find, container, renderView } = detailView({
        status: "blocked",
        runId: "current-run",
        metadata: {
          notifications: (
            [
              [failedId, "failed", 1, "Obsolete run failure."],
              [completedId, "completed", completedSequence, "Run completed."],
            ] as const
          ).map(([id, kind, sequence, message]) => ({
            id,
            kind,
            sequence,
            message,
            createdAt: 2,
            runId: "current-run",
          })),
        },
      });
      renderView();
      expect(find(".workboard-card__alert")).toBeNull();
      expect(container.textContent).not.toContain("Obsolete run failure.");
    },
  );

  it("preserves full diagnostic text in the list card's accessible description", () => {
    const sentinel = "SYNTHETIC_PRIVATE_OUTPUT";
    const title = `${"x".repeat(158)}🚀tail`;
    const diagnostic = { firstSeenAt: 1, lastSeenAt: 1, count: 1, actions: [] };
    vi.mocked(workboardTestHost().host.redact).mockImplementation((text) =>
      text.replaceAll(sentinel, "[redacted]"),
    );
    const { get, find, state, renderView } = detailView({
      metadata: {
        diagnostics: [
          {
            ...diagnostic,
            kind: "orphaned_session",
            severity: "error",
            title: `${title} ${sentinel}`,
            detail: `Boundary detail. ${sentinel}`,
          },
          {
            ...diagnostic,
            kind: "missing_proof",
            severity: "warning",
            title: "Release verification",
            detail: "The supporting evidence is still missing.",
          },
        ],
      },
    });
    state.viewMode = "list";
    renderView();
    const alert = find(".workboard-card__alert");
    expect(find(".workboard-card__alert--error")?.textContent?.trim()).toBe(`${title} [redacted]`);
    expect(alert?.getAttribute("title")).toContain(title);
    const card = get(".workboard-card");
    const descriptionId = expectDefined(
      card.getAttribute("aria-describedby"),
      "alert description ID",
    );
    const description = expectDefined(document.getElementById(descriptionId), "alert description");
    expectText(
      description,
      title,
      "Boundary detail. [redacted]",
      "Release verification",
      "The supporting evidence is still missing.",
    );
    expect(description.textContent).not.toContain(sentinel);
    expect(alert?.getAttribute("title")).not.toContain(sentinel);
  });

  it("does not render Invalid Date for Date-invalid card timestamps", () => {
    const invalidTime = 8_640_000_000_000_001;
    const error = "Attempt evidence survives invalid dates";
    const label = "Proof evidence survives invalid dates";
    const { get, find, container, renderView } = detailView({
      title: "Bad timestamp card",
      updatedAt: invalidTime,
      events: [{ id: "event-1", kind: "edited", at: invalidTime }],
      metadata: {
        attempts: [
          {
            id: "attempt-1",
            status: "failed",
            startedAt: invalidTime,
            endedAt: invalidTime,
            error,
          },
        ],
        proof: [{ id: "proof-1", status: "passed", createdAt: invalidTime, label }],
      },
    });
    renderView();
    expect(container.textContent).toContain("Bad timestamp card");
    expect(find(".workboard-card__updated")).toBeNull();
    expect(container.textContent).not.toContain("Invalid Date");
    buttonByLabel(container, "View details")!.click();
    renderView();
    buttonByText(find('[role="tablist"]')!, "Details")!.click();
    renderView();
    const details = get("#workboard-detail-panel-details");
    expectText(details, error, label);
    expect(details.textContent).not.toContain("Invalid Date");
  });

  it("opens board card details without hijacking action buttons", async () => {
    const onOpenSession = vi.fn();
    const { get, find, state, renderView } = detailView(
      { title: "Inspect a running task", status: "running", sessionKey: "agent:main:dashboard:1" },
      { onOpenSession },
      { updatedAt: 2 },
    );
    state.viewMode = "board";
    renderView();
    const card = get(".workboard-card");
    expect(card.getAttribute("aria-pressed")).toBeNull();
    expect(card.getAttribute("aria-haspopup")).toBe("dialog");
    requireButton(card, "Open session").click();
    expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:dashboard:1" });
    expect(state.detailCardId).toBeNull();
    expect(find(".workboard-detail")).toBeNull();
    onOpenSession.mockClear();
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    await waitForFast(() =>
      expect(find(".workboard-detail")?.textContent).toContain("Inspect a running task"),
    );
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("shows completed session identity without repeating a synthetic completion summary", () => {
    const onOpenSession = vi.fn();
    const sessionKey = "agent:main:completed-review";
    const { get, find, state, renderView } = detailView(
      { status: "done", sessionKey },
      { onOpenSession },
      {
        key: sessionKey,
        displayName: "Release review",
        updatedAt: 2,
        status: "done",
        hasActiveRun: false,
      },
    );
    state.detailCardId = "card-1";
    renderView();
    for (const tab of ["Overview", "Session"]) {
      textButton(find('[role="tablist"]')!, tab).click();
      renderView();
      const panel = get(".workboard-detail__tabpanel:not([hidden])");
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
    const { get, find, state, container, renderView } = detailView(
      { status: "todo", sessionKey: "agent:main:queued" },
      {},
      { key: "agent:main:queued", displayName: undefined, updatedAt: 2, status: "queued" },
    );
    renderView();
    const status = get("openclaw-workboard-session-status");
    expect(status.textContent).toContain("Queued");
    expect(find(".workboard-card__session-marker")).toBeNull();
    expect(find(".workboard-card__session-name")?.textContent?.trim()).toBe("Session");
    flush();
    const trigger = query<HTMLButtonElement>(status, ".workboard-session-status__trigger");
    const panel = query<HTMLElement>(status, ".workboard-session-status__popover");
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
    const { find, container, renderView } = detailView({
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
    });
    renderView();
    expect(find(".workboard-events")).toBeNull();
    requireButton(container, "View details").click();
    renderView();
    expectText(find(".workboard-detail"), "Moved to Done", "Moved to Backlog");
  });

  it("renders card metadata badges and hides archived cards", () => {
    const { get, find, state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
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
      createWorkboardCard({ id: "card-2", title: "Archived task", metadata: { archivedAt: 7 } }),
    ];
    renderView();
    expect(find(".workboard-card")?.textContent).not.toContain("Plugin");
    expect(find('.workboard-card__counts [aria-label="1 failed"]')).not.toBeNull();
    expect(find('.workboard-card__counts [aria-label="1 comments"]')).not.toBeNull();
    expect(find('.workboard-card__counts [aria-label="7 proof"]')).not.toBeNull();
    expect(find(".workboard-card__alert")?.textContent).toContain("Stale");
    expect(find(".workboard-card__alert")?.getAttribute("title")).toContain("No recent activity.");
    expect(container.textContent).not.toContain("Archived task");
    const archivedToggle = get<HTMLInputElement>('.workboard-filter-archived input[role="switch"]');
    archivedToggle.checked = true;
    archivedToggle.dispatchEvent(new Event("change", { bubbles: true }));
    renderView();
    expect(container.textContent).toContain("Archived task");
    expect(archivedToggle.checked).toBe(true);
    requireButton(container, "View details").click();
    renderView();
    expectText(
      find(".workboard-detail"),
      "1 attempts",
      "1 links",
      "pnpm test 1",
      "pnpm test 7",
      "https://example.com/proof-7",
      "Worker protocol",
      "Worker asked for owner input.",
      "Card automation",
      "ops",
      "review, test",
      "worktree · /tmp/workboard · proof",
    );
  });

  it("keeps visible archived cards inspectable and restorable without move or drag controls", async () => {
    const archivedCard = createWorkboardCard({
      title: "Archived historical task",
      metadata: { archivedAt: 10 },
    });
    const client = createWorkboardTestClient({});
    const { request } = client;
    const { find, state, renderView } = createWorkboardView({ client });
    state.cards = [archivedCard];
    state.showArchived = true;
    renderView();
    const article = find(".workboard-card--archived");
    expect(article).not.toBeNull();
    expect(article?.getAttribute("draggable")).toBe("false");
    expect(article?.querySelector(".workboard-card__move-select")).toBeNull();
    expect(buttonByLabel(article!, "Restore from archive")).not.toBeNull();
    expect(
      article!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(state.draggedCardId).toBeNull();
    state.draggedCardId = archivedCard.id;
    find(".workboard-column--running")?.dispatchEvent(
      new Event("drop", { bubbles: true, cancelable: true }),
    );
    expect(request).not.toHaveBeenCalled();
    state.draggedCardId = null;
    state.detailCardId = archivedCard.id;
    renderView();
    const drawer = find(".workboard-detail");
    query<HTMLElement>(drawer, "workboard-inline-text");
    flush();
    expect(drawer?.textContent).toContain(archivedCard.title);
    expect(drawer?.querySelector(".workboard-card__move-select")).toBeNull();
    expect(buttonByLabel(drawer!, "Restore from archive")).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("shows stale lifecycle on executed linked cards", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(60 * 60 * 1000);
    try {
      const { find, container, renderView } = detailView(
        {
          status: "running",
          execution: createWorkboardExecution(),
        },
        {},
        { updatedAt: 1, hasActiveRun: false },
      );
      renderView();
      await vi.waitFor(() =>
        expect(find(".workboard-session-status__trigger")?.textContent).toContain("Stale"),
      );
      expect(find(".workboard-session-status__detail")?.textContent).toContain(
        "No recent session activity",
      );
      expect(find(".workboard-card__session-marker")).toBeNull();
      expect(container.textContent).not.toContain("codex autonomous");
      expect(find(".workboard-live")).toBeNull();
      expect(find('button[aria-label="Stop session"]')).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("preserves the authoritative top-level session when editing a Workboard card", async () => {
    const sessionKey = "agent:main:top-level-linked-session";
    const card = createWorkboardCard({
      sessionKey,
      execution: createWorkboardExecution({ sessionKey: "agent:main:execution-linked-session" }),
    });
    const client = createWorkboardTestClient(() => ({
      card: { ...card, title: "Renamed without unlinking", updatedAt: 2 },
    }));
    const { request } = client;
    const { find, state, container, renderView } = createWorkboardView({
      client,
      sessions: [
        createGatewaySession({
          key: sessionKey,
          displayName: "Active linked session",
          updatedAt: 1,
          hasActiveRun: undefined,
        }),
      ],
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    requireButton(container, "Edit card").click();
    renderView();
    expect(state.draftSessionKey).toBe(sessionKey);
    expect(sessionPicker(container).value).toBe(sessionKey);
    fill(
      query<HTMLInputElement>(container, ".workboard-draft__title"),
      "Renamed without unlinking",
    );
    submitForm(query<HTMLFormElement>(container, ".workboard-draft"));
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
    expect(find("[data-test-session-summary]")).not.toBeNull();
  });

  it("preserves explicit archive visibility (success=true, showArchived=false)", async () => {
    const card = createWorkboardCard({ title: "Archive from drawer" });
    const client = createWorkboardTestClient(() => ({
      card: { ...card, metadata: { ...card.metadata, archivedAt: 2 } },
    }));
    const { find, state, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => renderView(),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    state.showArchived = false;
    renderView();
    requireButton(find(".workboard-detail__menu")!, "Archive card").click();
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: card.id,
      archived: true,
    });
    expect(find(".workboard-detail")).toBeNull();
  });
});
