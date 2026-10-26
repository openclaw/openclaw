import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import "../../test/dom.setup.ts";
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
  element,
  enterText,
  expectText,
  expectAbsent,
  detailView,
  submitForm,
} from "./view-dom.test-support.ts";
import {
  createWorkboardView,
  buttonByText,
  requireButton,
  openCardMenu,
  textButton,
  sessionPicker,
} from "./view.test-support.ts";

describe("WorkboardView", () => {
  it.each([
    ["direct", "agent:work:dashboard-panel-close", "work"],
    ["resolved", "agent:main:subagent:workboard-default-card-1", undefined],
    ["missing", undefined, undefined],
  ] as const)("binds the session summary to its %s owner", (name, expected, sessionAgentId) => {
    const sessionKey = name === "direct" ? expected : "subagent:workboard-default-card-1";
    const onOpenSession = vi.fn();
    const session = expected
      ? { sessionKey: expected, ...(sessionAgentId ? { agentId: sessionAgentId } : {}) }
      : undefined;
    const { state, container, renderView } = createWorkboardView({
      onOpenSession,
      sessions: expected ? [createGatewaySession({ key: expected, agentId: sessionAgentId })] : [],
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
      expect(mount).toHaveBeenCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({ session }),
      );
      if (name === "direct") {
        const handle = mount.mock.results[0]!.value;
        state.detailCardId = null;
        renderView();
        expect(handle.dispose).toHaveBeenCalledOnce();
        expectAbsent(container, "[data-test-session-summary]");
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
    const { state, container, renderView } = detailView(createWorkboardCard());
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
    const dialogToast = element<HTMLElement>(container, "openclaw-workboard-toast:not([hidden])");
    element<HTMLButtonElement>(dialogToast, 'button[aria-label="Close"]').click();
    await waitForFast(() => {
      expect(dialogToast?.querySelector('[role="alert"]')).toBeNull();
    });
    state.detailCardId = null;
    renderView({ pageError });
    const active = element<HTMLElement>(container, "openclaw-workboard-toast:not([hidden])");
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
    ["id", "a", "z", 1],
    ["legacy entry", "z", "a", undefined],
  ] as const)(
    "does not show an obsolete same-time failure after completion ordered by %s",
    (_label, failedId, completedId, completedSequence) => {
      const { state, container, renderView } = createWorkboardView();
      state.cards = [
        createWorkboardCard({
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
        }),
      ];
      renderView();
      expectAbsent(container, ".workboard-card__alert");
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
    const title = `${"x".repeat(158)}🚀tail`;
    const diagnostic = { firstSeenAt: 1, lastSeenAt: 1, count: 1, actions: [] };
    state.cards = [
      createWorkboardCard({
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
              detail: "Evidence needed.",
            },
          ],
        },
      }),
    ];
    renderView();
    expect(element(container, ".workboard-card__alert--error").textContent?.trim()).toBe(
      `${title} [redacted]`,
    );
    const tooltip = element(container, ".workboard-card__alert").getAttribute("title");
    expect(tooltip).toContain(title);
    expect(tooltip).not.toContain(sentinel);
    const card = element<HTMLElement>(container, ".workboard-card");
    const descriptionId = expectDefined(
      card.getAttribute("aria-describedby"),
      "alert description ID",
    );
    const description = expectDefined(document.getElementById(descriptionId), "alert description");
    for (const text of [
      title,
      "Boundary detail. [redacted]",
      "Release verification",
      "Evidence needed.",
    ]) {
      expect(description.textContent).toContain(text);
    }
    expect(description.textContent).not.toContain(sentinel);
  });

  it("does not render Invalid Date for Date-invalid card timestamps", () => {
    const { state, container, renderView } = createWorkboardView();
    const invalid = 8_640_000_000_000_001;
    state.cards = [
      createWorkboardCard({
        title: "Bad timestamp card",
        updatedAt: invalid,
        events: [{ id: "event-1", kind: "edited", at: invalid }],
        metadata: {
          attempts: [
            {
              id: "attempt-1",
              status: "failed",
              startedAt: invalid,
              endedAt: invalid,
              error: "Invalid-date attempt",
            },
          ],
          proof: [
            {
              id: "proof-1",
              status: "passed",
              createdAt: invalid,
              label: "Invalid-date proof",
            },
          ],
        },
      }),
    ];
    renderView();
    expect(container.textContent).toContain("Bad timestamp card");
    expectAbsent(container, ".workboard-card__updated");
    expect(container.textContent).not.toContain("Invalid Date");
    requireButton(openCardMenu(container), "View details").click();
    renderView();
    buttonByText(container.querySelector('[role="tablist"]')!, "Details")!.click();
    renderView();
    const details = element<HTMLElement>(container, "#workboard-detail-panel-details");
    expect(details.textContent).toContain("Invalid-date attempt");
    expect(details.textContent).toContain("Invalid-date proof");
    expect(details.textContent).not.toContain("Invalid Date");
  });

  it("opens board card details without hijacking action buttons", async () => {
    const onOpenSession = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      sessions: [createGatewaySession({ updatedAt: 2 })],
      onOpenSession,
    });
    state.cards = [
      createWorkboardCard({
        title: "Inspect a running task",
        status: "running",
        sessionKey: "agent:main:dashboard:1",
      }),
    ];
    renderView();
    const card = element<HTMLElement>(container, ".workboard-card");
    expect(card.getAttribute("aria-pressed")).toBeNull();
    expect(card.getAttribute("aria-haspopup")).toBe("dialog");
    requireButton(openCardMenu(card), "Open session").click();
    expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: "agent:main:dashboard:1" });
    expect(state.detailCardId).toBeNull();
    expectAbsent(container, ".workboard-detail");
    onOpenSession.mockClear();
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    await waitForFast(() => expectText(container, ".workboard-detail", "Inspect a running task"));
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("shows completed session identity without repeating a synthetic completion summary", () => {
    const onOpenSession = vi.fn();
    const sessionKey = "agent:main:completed-review";
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        createGatewaySession({
          key: sessionKey,
          displayName: "Release review",
          updatedAt: 2,
          status: "done",
          hasActiveRun: false,
        }),
      ],
      onOpenSession,
    });
    state.cards = [createWorkboardCard({ status: "done", sessionKey })];
    state.detailCardId = "card-1";
    renderView();
    for (const tab of ["Overview", "Session"]) {
      textButton(container.querySelector('[role="tablist"]')!, tab).click();
      renderView();
      const panel = element<HTMLElement>(container, ".workboard-detail__tabpanel:not([hidden])");
      expectText(panel, ".workboard-detail__session-name", "Release review");
      expect(panel.querySelector(".workboard-session-badge")?.textContent).toBe("Done");
      expect(panel.textContent).not.toContain("Run completed");
      requireButton(panel, "Open session").click();
      expect(onOpenSession).toHaveBeenLastCalledWith({ sessionKey });
    }
  });

  it("keeps queued session context readable until an outside pointer dismisses it", async () => {
    const { state, container, renderView } = createWorkboardView({
      sessions: [
        createGatewaySession({
          key: "agent:main:queued",
          displayName: undefined,
          updatedAt: 2,
          status: "queued",
        }),
      ],
    });
    state.cards = [createWorkboardCard({ status: "todo", sessionKey: "agent:main:queued" })];
    renderView();
    const status = element<HTMLElement>(container, "openclaw-workboard-session-status");
    expect(status.textContent).toContain("Queued");
    expectAbsent(container, ".workboard-card__session-marker");
    expect(container.querySelector(".workboard-card__session-name")?.textContent?.trim()).toBe(
      "Session",
    );
    flush();
    const trigger = element<HTMLButtonElement>(status, ".workboard-session-status__trigger");
    const panel = element<HTMLElement>(status, ".workboard-session-status__popover");
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
      renderView();
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      trigger.click();
      state.cards = [];
      renderView();
      expect(status.isConnected).toBe(false);
      expect(removeListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    } finally {
      removeListener.mockRestore();
    }
  });

  it("renders card event history", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({
        events: [
          { id: "event-1", kind: "moved", at: 1, fromStatus: "triage", toStatus: "backlog" },
          { id: "event-2", kind: "moved", at: 2, fromStatus: "review", toStatus: "done" },
        ],
      }),
    ];
    renderView();
    expectAbsent(container, ".workboard-events");
    requireButton(openCardMenu(container), "View details").click();
    renderView();
    expectText(container, ".workboard-detail", "Moved to Done", "Moved to Backlog");
  });

  it("renders card metadata badges and hides archived cards", () => {
    const { state, container, renderView } = createWorkboardView();
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
            skills: ["review", "test"],
            workspace: { kind: "worktree", path: "/tmp/workboard", branch: "proof" },
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
        metadata: { archivedAt: 7 },
      }),
    ];
    renderView();
    expect(container.querySelector(".workboard-card")?.textContent).not.toContain("Plugin");
    for (const count of ["1 failed", "1 comments", "7 proof"]) {
      element(container, `.workboard-card__counts [aria-label="${count}"]`);
    }
    expectText(container, ".workboard-card__alert", "Stale");
    expect(container.querySelector(".workboard-card__alert")?.getAttribute("title")).toContain(
      "No recent activity.",
    );
    expect(container.textContent).not.toContain("Archived task");
    const archivedToggle = element<HTMLInputElement>(
      container,
      '.workboard-filter-archived input[role="switch"]',
    );
    archivedToggle.checked = true;
    archivedToggle.dispatchEvent(new Event("change", { bubbles: true }));
    renderView();
    expect(container.textContent).toContain("Archived task");
    expect(archivedToggle.checked).toBe(true);
    requireButton(openCardMenu(container), "View details").click();
    renderView();
    expectText(
      container,
      ".workboard-detail",
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
    const { state, container, renderView } = createWorkboardView({ client });
    state.cards = [archivedCard];
    state.showArchived = true;
    renderView();
    const article = element(container, ".workboard-card--archived");
    expect(article.getAttribute("draggable")).toBe("false");
    const menu = openCardMenu(article);
    expectAbsent(menu, ".workboard-card__move-select");
    requireButton(menu, "Restore from archive");
    expect(article.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }))).toBe(
      false,
    );
    expect(state.draggedCardId).toBeNull();
    state.draggedCardId = archivedCard.id;
    container
      .querySelector(".workboard-column--running")
      ?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(client.request).not.toHaveBeenCalled();
    state.draggedCardId = null;
    state.detailCardId = archivedCard.id;
    renderView();
    const drawer = element(container, ".workboard-detail");
    element<HTMLElement>(drawer, "workboard-inline-text");
    flush();
    expect(drawer.textContent).toContain(archivedCard.title);
    expectAbsent(drawer, ".workboard-card__move-select");
    requireButton(drawer, "Restore from archive");
    expect(client.request).not.toHaveBeenCalled();
  });

  it("shows stale lifecycle on executed linked cards", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(60 * 60 * 1000);
    try {
      const { state, container, renderView } = createWorkboardView({
        sessions: [createGatewaySession({ updatedAt: 1, hasActiveRun: false })],
      });
      state.cards = [
        createWorkboardCard({
          status: "running",
          execution: createWorkboardExecution(),
        }),
      ];
      renderView();
      await vi.waitFor(() => expectText(container, ".workboard-session-status__trigger", "Stale"));
      expectText(container, ".workboard-session-status__detail", "No recent session activity");
      expect(container.textContent).not.toContain("codex autonomous");
      expectAbsent(
        container,
        ".workboard-card__session-marker",
        ".workboard-live",
        'button[aria-label="Stop session"]',
      );
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
    const { state, container, renderView } = detailView(card, {
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
    renderView();
    requireButton(container, "Edit card").click();
    renderView();
    expect(state.draftSessionKey).toBe(sessionKey);
    expect(sessionPicker(container).value).toBe(sessionKey);
    enterText(
      element<HTMLInputElement>(container, ".workboard-draft__title"),
      "Renamed without unlinking",
    );
    submitForm(element<HTMLFormElement>(container, ".workboard-draft"));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { title: "Renamed without unlinking" },
    });
    expect(state.cards[0]?.execution?.sessionKey).toBe("agent:main:execution-linked-session");
    renderView();
    state.detailTab = "session";
    renderView();
    element(container, "[data-test-session-summary]");
  });

  it("preserves explicit archive visibility (success=true, showArchived=false)", async () => {
    const card = createWorkboardCard();
    const client = createWorkboardTestClient(() => ({
      card: { ...card, metadata: { archivedAt: 2 } },
    }));
    const { state, container, renderView } = detailView(card, {
      client,
      onRequestUpdate: () => renderView(),
    });
    renderView();
    requireButton(container.querySelector(".workboard-detail__menu")!, "Archive card").click();
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.archive", {
      id: card.id,
      archived: true,
    });
    expectAbsent(container, ".workboard-detail");
  });
});
