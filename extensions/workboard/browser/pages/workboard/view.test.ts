import "../../test/dom.setup.ts";
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { render as litRender, type LitElement } from "lit";
import type {
  ControlUiAgentPickerProps,
  ControlUiComponents,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { setWorkboardCards } from "../../lib/workboard/card-state.ts";
import { getWorkboardState, resetWorkboardConnectionState } from "../../lib/workboard/index.ts";
import {
  createGatewaySession,
  createWorkboardCard,
  createWorkboardExecution,
  createWorkboardTestClient,
} from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { renderWorkboard } from "./view.ts";
const renderedRoots = new Set<ReturnType<typeof litRender>>();
function render(...args: Parameters<typeof litRender>) {
  const root = litRender(...args);
  renderedRoots.add(root);
  return root;
}
afterEach(() => {
  for (const root of renderedRoots) {
    root.setConnected(false);
  }
  renderedRoots.clear();
});
type ControlUiSelectPickerProps = Parameters<ControlUiComponents["mountSelectPicker"]>[1];
type SelectPicker = HTMLElement & ControlUiSelectPickerProps;
type AgentPicker = HTMLElement & ControlUiAgentPickerProps;

type WorkboardRenderProps = Parameters<typeof renderWorkboard>[0];
function createLoadedWorkboardState() {
  const host = {};
  const state = getWorkboardState(host);
  state.loaded = true;
  return { host, state };
}

function createWorkboardRenderProps(
  host: WorkboardRenderProps["host"],
  overrides: Partial<WorkboardRenderProps> = {},
): WorkboardRenderProps {
  return {
    host,
    client: null,
    connected: true,
    agentsList: null,
    sessions: [],
    onOpenSession: () => undefined,
    onRefresh: () => undefined,
    ...overrides,
  };
}

function renderInto(container: HTMLElement, props: WorkboardRenderProps) {
  workboardTestHost().connection.connected = props.connected;
  if (!container.isConnected) {
    document.body.append(container);
  }
  render(renderWorkboard(props), container);
}

function createWorkboardView(
  overrides: Partial<WorkboardRenderProps> = {},
  host: WorkboardRenderProps["host"] = {},
) {
  const state = getWorkboardState(host);
  state.loaded = true;
  const container = document.createElement("div");
  const props = createWorkboardRenderProps(host, overrides);
  const renderView = (next: Partial<WorkboardRenderProps> = {}) =>
    renderInto(container, { ...props, ...next });
  return { host, state, container, renderView };
}

function buttonByLabel(container: Element, label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
    ) ?? null
  );
}

function buttonByText(container: Element, text: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

function element<T extends Element = HTMLElement>(
  root: ParentNode | null | undefined,
  selector: string,
): T {
  return expectDefined(root?.querySelector<T>(selector), selector);
}

function requireButton(root: Element, label: string) {
  return expectDefined(buttonByLabel(root, label), label);
}

function textButton(root: Element, text: string) {
  return expectDefined(buttonByText(root, text), text);
}

async function inlineEditor(container: Element, field: "title" | "notes" | "labels") {
  const trigger = await waitForFast(() =>
    element<HTMLButtonElement>(container, `.workboard-detail__text-trigger--${field}`),
  );
  const owner = expectDefined(
    trigger.closest<HTMLElement>("workboard-inline-text"),
    "inline editor",
  );
  const popover = owner.querySelector<HTMLElement>("[popover]");
  if (popover) {
    popover.showPopover = vi.fn();
  }
  return {
    trigger,
    owner,
    popover,
    open: async () => {
      trigger.click();
      return waitForFast(() =>
        element<HTMLInputElement | HTMLTextAreaElement>(owner, "input, textarea"),
      );
    },
  };
}

function draftPicker(container: Element, label: string) {
  return expectDefined(
    [
      ...container.querySelectorAll<SelectPicker>(".workboard-draft [data-test-select-picker]"),
    ].find((picker) => picker.accessibleLabel === label),
    `card ${label} picker`,
  );
}

function sessionPicker(container: Element) {
  return draftPicker(container, "Session");
}

function filterPicker(container: Element, label: string) {
  return expectDefined(
    [
      ...container.querySelectorAll<SelectPicker>(
        label === "Agent"
          ? ".workboard-agent-filter [data-test-select-picker]"
          : ".workboard-filter-popover [data-test-select-picker]",
      ),
    ].find((picker) => picker.accessibleLabel === label),
    `filter picker ${label}`,
  );
}

function statusButton(container: Element, label: string) {
  return requireButton(
    element(container, '.workboard-status-tabs[role="group"][aria-label="Status"]'),
    label,
  );
}

function toast(container: Element) {
  return element(container, "openclaw-workboard-toast:not([hidden])");
}

describe("renderWorkboard", () => {
  it("retries only pending bulk edits after the second card fails", async () => {
    const first = createWorkboardCard({ id: "first", agentId: "writer" });
    const second = createWorkboardCard({ id: "second", agentId: "writer", position: 2000 });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 },
      })
      .mockRejectedValueOnce(new Error("Second card update rejected"))
      .mockResolvedValueOnce({
        card: { ...second, agentId: "main", updatedAt: second.updatedAt + 1 },
      });
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      connected: true,
      canWrite: true,
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
    });
    state.cards = [first, second];
    state.selectedCardIds = new Set([first.id, second.id]);
    renderView();
    requireButton(container, "Edit properties").click();
    renderView();
    const picker = element<SelectPicker>(
      container,
      ".workboard-bulk-dialog [data-test-select-picker]",
    );
    expect(picker.accessibleLabel).toBe("Agent");
    picker.onSelect("main");
    renderView();
    requireButton(container, "Apply changes").click();
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.cards.find((card) => card.id === first.id)?.agentId).toBe("main");
    expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
    expect(state.selectedCardIds).toEqual(new Set([second.id]));
    expect(state.bulkDialog?.cardIds).toEqual([second.id]);
    expect(state.bulkResult).toEqual({ completed: 1, total: 2 });
    renderView();
    await waitForFast(() => {
      const errorToast = container.querySelector("openclaw-workboard-toast:not([hidden])");
      expect(errorToast?.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
        "Applied to 1 of 2 cards. Second card update rejected",
      );
    });
    requireButton(container, "Apply changes").click();
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request.mock.calls).toEqual(
      [first, second, second].map((card) => [
        "workboard.cards.update",
        { id: card.id, expectedUpdatedAt: card.updatedAt, patch: { agentId: "main" } },
      ]),
    );
    expect(state.cards.every((card) => card.agentId === "main")).toBe(true);
    expect(state.selectedCardIds.size).toBe(0);
    expect(state.bulkDialog).toBeNull();
    expect(state.bulkResult).toEqual({ completed: 1, total: 1 });
    expect(state.error).toBeNull();
  });

  it.each(["write revocation", "disconnect", "activation disposal"] as const)(
    "stops a bulk assignment after live host %s while the first write is pending",
    async (change) => {
      const first = createWorkboardCard({ id: "first", agentId: "writer" });
      const second = createWorkboardCard({ id: "second", agentId: "writer", position: 2000 });
      const firstWrite = createDeferred<{
        card: typeof first;
      }>();
      const request = vi
        .fn()
        .mockImplementationOnce(() => firstWrite.promise)
        .mockResolvedValue({ card: { ...second, agentId: "main" } });
      const { state, container, renderView } = createWorkboardView({
        client: { request },
        connected: true,
        canWrite: true,
        agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
      });
      state.cards = [first, second];
      state.selectedCardIds = new Set([first.id, second.id]);
      renderView();
      const picker = expectDefined(
        [
          ...container.querySelectorAll<SelectPicker>(
            ".workboard-selection [data-test-select-picker]",
          ),
        ].find((item) => item.accessibleLabel === "Assign agent…"),
        "bulk assignment",
      );
      picker.onSelect("main");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      expect(state.bulkSaving).toBe(true);
      const connection = workboardTestHost().connection;
      if (change === "disconnect") {
        connection.connected = false;
      } else if (change === "write revocation") {
        connection.canWrite = false;
      } else {
        workboardTestHost().dispose();
      }
      firstWrite.resolve({ card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 } });
      await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("workboard.cards.update", {
        id: first.id,
        expectedUpdatedAt: first.updatedAt,
        patch: { agentId: "main" },
      });
      expect(state.cards.find((card) => card.id === first.id)?.agentId).toBe("main");
      expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
      expect(state.selectedCardIds).toEqual(new Set([second.id]));
      expect(state.bulkResult).toEqual({ completed: 1, total: 2 });
      expect(state.error).toContain("Applied to 1 of 2 cards.");
    },
  );

  it("clears selection and stops pending work on board scope changes but retains query/status selection", async () => {
    const first = createWorkboardCard({
      id: "first",
      metadata: { automation: { boardId: "one" } },
      agentId: "writer",
    });
    const second = createWorkboardCard({
      id: "second",
      metadata: { automation: { boardId: "one" } },
      agentId: "writer",
    });
    const pending = createDeferred<{
      card: typeof first;
    }>();
    const request = vi.fn().mockImplementation(() => pending.promise);
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      canWrite: true,
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
    });
    state.cards = [first, second];
    state.boardFilter = "one";
    state.selectedCardIds = new Set([first.id, second.id]);
    renderView();
    state.query = "unmatched";
    state.statusFilter = new Set(["done"]);
    renderView();
    expect(state.selectedCardIds).toEqual(new Set([first.id, second.id]));
    const assign = expectDefined(
      [
        ...container.querySelectorAll<SelectPicker>(
          ".workboard-selection [data-test-select-picker]",
        ),
      ].find((picker) => picker.accessibleLabel === "Assign agent…"),
      "assignment",
    );
    assign.onSelect("main");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    state.boardFilter = "two";
    renderView();
    expect(state.selectedCardIds.size).toBe(0);
    expect(state.bulkDialog).toBeNull();
    // Returning to the original scope cannot revive the pending batch.
    state.boardFilter = "one";
    renderView();
    pending.resolve({ card: { ...first, agentId: "main", updatedAt: first.updatedAt + 1 } });
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.cards.find((card) => card.id === second.id)?.agentId).toBe("writer");
    expect(state.selectedCardIds.size).toBe(0);
  });

  it("drops a live card outside the selected local agent scope before actions and during pending work", async () => {
    const first = createWorkboardCard({
      id: "first",
      agentId: "writer",
      metadata: { automation: { boardId: "one" } },
    });
    const second = createWorkboardCard({ ...first, id: "second", position: 2000 });
    const outside = { ...second, agentId: "main", updatedAt: second.updatedAt + 1 };
    const pending = createDeferred<{
      card: typeof first;
    }>();
    const request = vi.fn().mockImplementation(() => pending.promise);
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      canWrite: true,
      scopeAgentId: undefined,
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
    });
    state.boardFilter = "one";
    state.agentFilter = "writer";
    state.cards = [first, second];
    state.selectedCardIds = new Set([first.id, second.id]);
    renderView();
    state.query = "unmatched";
    state.statusFilter = new Set(["done"]);
    setWorkboardCards(state, [first, outside]);
    renderView();
    expect(state.selectedCardIds).toEqual(new Set([first.id]));
    // Keep a second eligible selection, then move it remotely while the first request is pending.
    setWorkboardCards(state, [first, second]);
    state.selectedCardIds.add(second.id);
    renderView();
    requireButton(container, "Archive").click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    setWorkboardCards(state, [first, outside]);
    pending.resolve({
      card: { ...first, metadata: { ...first.metadata, archivedAt: first.updatedAt + 1 } },
    });
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.cards.find((card) => card.id === second.id)).toEqual(outside);
    expect(state.selectedCardIds.size).toBe(0);
  });

  it.each(["none", "before cleanup", "after cleanup"] as const)(
    "deletes linked selections without adopting unrelated edits: %s",
    async (concurrentEdit) => {
      const parent = createWorkboardCard({ id: "parent" });
      const child = createWorkboardCard({
        id: "child",
        position: 2000,
        metadata: {
          links: [{ id: "link", type: "parent", targetCardId: parent.id, createdAt: 1 }],
        },
      });
      const previousUpdatedAt = child.updatedAt + (concurrentEdit === "before cleanup" ? 1 : 0);
      const cleanupUpdatedAt = previousUpdatedAt + 1;
      const latest = {
        ...child,
        metadata: undefined,
        updatedAt: cleanupUpdatedAt + (concurrentEdit === "after cleanup" ? 1 : 0),
        title: concurrentEdit === "none" ? child.title : "Edited by another client",
      };
      const request = vi.fn().mockImplementation(async (_method, params) => {
        if (params.id === parent.id) {
          if (concurrentEdit !== "none") {
            setWorkboardCards(state, [
              parent,
              {
                ...latest,
                updatedAt:
                  concurrentEdit === "before cleanup" ? previousUpdatedAt : latest.updatedAt,
              },
            ]);
          }
          return {
            deleted: true,
            referenceUpdates: [{ id: child.id, previousUpdatedAt, updatedAt: cleanupUpdatedAt }],
          };
        }
        if (params.expectedUpdatedAt !== latest.updatedAt) {
          throw new GatewayProtocolRequestError({
            code: "workboard_conflict",
            message: "Card changed. Review and retry.",
            details: { type: "workboard_card_conflict", card: latest },
          });
        }
        return { deleted: true };
      });
      const { state, container, renderView } = createWorkboardView({
        client: { request },
        canWrite: true,
      });
      state.cards = [parent, child];
      state.selectedCardIds = new Set([parent.id, child.id]);
      renderView();
      element<HTMLButtonElement>(container, ".workboard-selection__delete").click();
      renderView();
      element<HTMLButtonElement>(container, '.workboard-bulk-dialog button[type="submit"]').click();
      await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(2, "workboard.cards.delete", {
        id: child.id,
        expectedUpdatedAt: concurrentEdit === "before cleanup" ? child.updatedAt : cleanupUpdatedAt,
      });
      if (concurrentEdit === "none") {
        expect(state.cards).toEqual([]);
        expect(state.selectedCardIds.size).toBe(0);
        expect(state.error).toBeNull();
      } else {
        expect(state.cards).toEqual([latest]);
        expect(state.selectedCardIds).toEqual(new Set([child.id]));
        expect(state.error).toContain("Card changed. Review and retry.");
      }
    },
  );

  it.each(["move", "archive", "delete"] as const)(
    "stops bulk %s on a newer card revision and retains it for retry",
    async (action) => {
      const first = createWorkboardCard({ id: "first" });
      const second = createWorkboardCard({ id: "second", position: 2000 });
      const newer = { ...second, title: "Changed elsewhere", updatedAt: second.updatedAt + 10 };
      const pending = createDeferred<unknown>();
      const request = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementation(async () => {
          throw new GatewayProtocolRequestError({
            code: "workboard_conflict",
            message: "Card changed. Review and retry.",
            details: { type: "workboard_card_conflict", card: newer },
          });
        });
      const { state, container, renderView } = createWorkboardView({
        client: { request },
        canWrite: true,
      });
      state.cards = [first, second];
      state.selectedCardIds = new Set([first.id, second.id]);
      renderView();
      if (action === "move") {
        element<SelectPicker>(container, ".workboard-selection [data-test-select-picker]").onSelect(
          "done",
        );
      } else {
        requireButton(container, action === "archive" ? "Archive" : "Delete").click();
        if (action === "delete") {
          setWorkboardCards(state, [first, newer]);
          renderView();
          element<HTMLButtonElement>(
            container,
            '.workboard-bulk-dialog button[type="submit"]',
          ).click();
        }
      }
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
      // Refresh while processing the first card must not replace the observed revision.
      setWorkboardCards(state, [first, newer]);
      pending.resolve(
        action === "delete"
          ? { deleted: true }
          : {
              card: {
                ...first,
                status: action === "move" ? "done" : first.status,
                metadata:
                  action === "archive" ? { archivedAt: first.updatedAt + 1 } : first.metadata,
              },
            },
      );
      await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(
        2,
        `workboard.cards.${action}`,
        expect.objectContaining({ id: second.id, expectedUpdatedAt: second.updatedAt }),
      );
      expect(state.cards.find((card) => card.id === second.id)).toEqual(newer);
      expect(state.selectedCardIds).toEqual(new Set([second.id]));
      expect(state.error).toContain("Card changed. Review and retry.");
    },
  );

  it("does not bulk-delete a card archived during the first delete", async () => {
    const first = createWorkboardCard({ id: "first" });
    const second = createWorkboardCard({ id: "second", position: 2000 });
    const archived = { ...second, metadata: { archivedAt: second.updatedAt + 1 } };
    const firstWrite = createDeferred<{
      deleted: boolean;
    }>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue({ deleted: true });
    const { state, container, renderView } = createWorkboardView({
      client: { request },
      connected: true,
      canWrite: true,
    });
    state.cards = [first, second];
    state.selectedCardIds = new Set([first.id, second.id]);
    renderView();
    element<HTMLButtonElement>(container, ".workboard-selection__delete").click();
    renderView();
    expect(state.bulkDialog?.cardIds).toEqual([first.id, second.id]);
    element<HTMLButtonElement>(container, '.workboard-bulk-dialog button[type="submit"]').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    setWorkboardCards(state, [first, archived]);
    firstWrite.resolve({ deleted: true });
    await vi.waitFor(() => expect(state.bulkSaving).toBe(false));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("workboard.cards.delete", {
      id: first.id,
      expectedUpdatedAt: first.updatedAt,
    });
    expect(state.cards).toEqual([archived]);
    expect(state.selectedCardIds.size).toBe(0);
    expect(state.bulkDialog).toBeNull();
  });

  it("disposes the agent:work:dashboard-panel-close session summary when card details close", () => {
    const { state, container, renderView } = createWorkboardView();
    state.detailCardId = "card-1";
    state.detailTab = "session";
    state.cards = [
      createWorkboardCard({
        sessionKey: "agent:work:dashboard-panel-close",
        agentId: "reassigned",
      }),
    ];
    const mount = vi.mocked(workboardTestHost().host.components.mountSessionSummary);
    renderView({
      sessions: [
        createGatewaySession({ key: "agent:work:dashboard-panel-close", agentId: "work" }),
      ],
    });
    expect(mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({
        session: { sessionKey: "agent:work:dashboard-panel-close", agentId: "work" },
      }),
    );
    const handle = mount.mock.results[0]!.value;
    state.detailCardId = null;
    renderView();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-test-session-summary]")).toBeNull();
  });

  it.each([
    {
      name: "resolved",
      owners: ["main"],
      expected: "agent:main:subagent:workboard-default-card-1",
    },
    { name: "missing", owners: [], expected: undefined },
  ])(
    "uses only an identified execution for a $name provisional session",
    ({ owners, expected }) => {
      const onOpenSession = vi.fn();
      const { state, container, renderView } = createWorkboardView({
        onOpenSession,
        sessions: owners.map((owner) =>
          createGatewaySession({ key: `agent:${owner}:subagent:workboard-default-card-1` }),
        ),
        sessionResolution: expected
          ? {
              key: "subagent:workboard-default-card-1",
              status: "resolved",
              session: createGatewaySession({ key: expected }),
            }
          : {
              key: "subagent:workboard-default-card-1",
              status: owners.length > 1 ? "ambiguous" : "unavailable",
            },
      });
      state.cards = [
        createWorkboardCard({ agentId: "worker", sessionKey: "subagent:workboard-default-card-1" }),
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
          expect.objectContaining({ session: { sessionKey: expected } }),
        );
        expectDefined(open, "resolved session action").click();
        expect(onOpenSession).toHaveBeenCalledWith({ sessionKey: expected });
      } else {
        expect(mount).not.toHaveBeenCalled();
        expect(open).toBeNull();
      }
    },
  );

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
        expect(visible[0]?.shadowRoot?.querySelector('[role="alert"]')?.textContent).toBe(message);
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
    const dialogToast = element(container, "openclaw-workboard-toast:not([hidden])");
    element<HTMLButtonElement>(dialogToast.shadowRoot, 'button[aria-label="Close"]').click();
    await waitForFast(() => {
      expect(dialogToast.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    });
    state.detailCardId = null;
    state.bulkDialog = null;
    state.draftOpen = "details" === "discard";
    state.draftDiscardOpen = false;
    renderView({ pageError });
    const active = element<LitElement>(container, "openclaw-workboard-toast:not([hidden])");
    await active.updateComplete;
    expect(active.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    // Recovery makes a subsequent identical failure a new visible outcome.
    renderView({ pageError: undefined });
    await active.updateComplete;
    expect(active.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    renderView({ pageError });
    await expectError(pageError);
  });

  it("keeps refresh context accessible while loading", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.loading = true;
    state.lastRefreshAt = new Date("2026-06-03T18:47:00Z").getTime();
    renderView();
    expect(buttonByLabel(container, "Compact")).not.toBeNull();
    expect(
      container.querySelector(".workboard-refresh")?.parentElement?.getAttribute("title"),
    ).toContain("Refreshing");
    expect(container.querySelector(".workboard-refresh")?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector(".workboard-refresh")?.textContent).not.toContain("Refreshing");
    state.loading = false;
    state.lastRefreshError = "Card refresh unavailable";
    renderView();
    await waitForFast(() =>
      expect(
        toast(container).shadowRoot?.querySelector('[role="alert"]')?.textContent?.trim(),
      ).toBe("Card refresh unavailable"),
    );
    expect(buttonByLabel(container, "Refresh")?.disabled).toBe(false);
    state.lastRefreshError = null;
    renderView();
    await waitForFast(() =>
      expect(toast(container).shadowRoot?.querySelector('[role="alert"]')).toBeNull(),
    );
  });

  it("highlights only the current drag destination and clears it on exit", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.cards = [createWorkboardCard({ title: "Drag feedback" })];
    state.draggedCardId = "card-1";
    renderView();
    expect(container.querySelector(".workboard-card")?.classList).toContain(
      "workboard-card--dragging",
    );
    expect(container.querySelector(".workboard-column--drop-target")).toBeNull();
    const running = container.querySelector(".workboard-column--running")!;
    const todo = container.querySelector(".workboard-column--todo")!;
    running.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    renderView();
    expect(container.querySelectorAll(".workboard-column--drop-target")).toHaveLength(1);
    expect(running.classList).toContain("workboard-column--drop-target");
    todo.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    renderView();
    expect(container.querySelectorAll(".workboard-column--drop-target")).toHaveLength(1);
    expect(todo.classList).toContain("workboard-column--drop-target");
    todo.dispatchEvent(new MouseEvent("dragleave", { relatedTarget: todo.firstElementChild }));
    expect(state.dragOverStatus).toBe("todo");
    todo.dispatchEvent(new Event("dragleave"));
    renderView();
    expect(container.querySelector(".workboard-column--drop-target")).toBeNull();
    running.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    container.querySelector(".workboard-card")!.dispatchEvent(new Event("dragend"));
    renderView();
    expect(state.draggedCardId).toBeNull();
    expect(state.dragOverStatus).toBeNull();
    expect(container.querySelector(".workboard-card--dragging")).toBeNull();
    expect(container.querySelector(".workboard-column--drop-target")).toBeNull();
  });

  it("moves the resolved active list card when a drop has no transfer payload", async () => {
    const card = createWorkboardCard({ title: "Fallback drag move" });
    const moved = { ...card, status: "running" as const, position: 1000 };
    const request = vi.fn(async () => ({ card: moved }));
    const { state, container, renderView } = createWorkboardView({
      client: { request } as unknown as GatewayBrowserClient,
    });
    state.viewMode = "list";
    state.cards = [card];
    state.draggedCardId = card.id;
    renderView();
    container
      .querySelector(".workboard-column--running")
      ?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: card.id,
      status: "running",
      position: 1000,
    });
    expect(state.cards).toContainEqual(moved);
  });

  it("keeps a stale edit draft disabled until it is cancelled", async () => {
    const { host, state, container, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ title: "Canonical title" })];
    state.draftOpen = true;
    state.editingCardId = "card-1";
    state.draftTitle = "Unsaved edit";
    resetWorkboardConnectionState(host);
    renderView();
    state.mutationReadiness = "stale_edit_draft";
    renderView();
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-modal__actions .primary")?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Unsaved edit",
    );
    const cancelButton = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]');
    expect(cancelButton?.disabled).toBe(false);
    cancelButton?.click();
    expect(state.draftOpen).toBe(false);
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
    const card = element(container, ".workboard-card");
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

  it("filters cards by multiple selected statuses from menu", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [
      createWorkboardCard({ id: "ready", title: "Ready card", status: "ready" }),
      createWorkboardCard({ id: "blocked", title: "Blocked card", status: "blocked" }),
      createWorkboardCard({ id: "done", title: "Done card", status: "done" }),
    ];
    renderView();
    const selectStatus = (label: string) =>
      textButton(
        element(container, '[role="dialog"][aria-label="Status"]'),
        label === "All" ? "All work" : label,
      );
    selectStatus("Ready").click();
    renderView();
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Ready card");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Blocked card");
    selectStatus("Blocked").click();
    renderView();
    expect(state.statusFilter).toEqual(new Set(["ready", "blocked"]));
    expect(selectStatus("Ready").getAttribute("aria-pressed")).toBe("true");
    expect(selectStatus("Blocked").getAttribute("aria-pressed")).toBe("true");
    expect(selectStatus("All").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Blocked card");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Done card");
    selectStatus("All").click();
    renderView();
    expect(selectStatus("All").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Done card");
  });

  it("keeps zero-result status filters selectable and clearable", () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ id: "ready", title: "Ready card", status: "ready" })];
    renderView();
    const running = statusButton(container, "Running");
    expect(running.disabled).toBe(false);
    running.click();
    renderView();
    expect(container.querySelector(".workboard-empty-state")?.textContent).toContain(
      "No cards match this view",
    );
    textButton(container.querySelector(".workboard-empty-state")!, "Clear filters").click();
    renderView();
    expect(state.statusFilter.size).toBe(0);
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Ready card");
  });

  it("keeps keyboard focus usable when search updates chips and chips are removed", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.statusFilter = new Set(["ready", "blocked"]);
    state.priorityFilter = new Set(["high"]);
    state.searchOpen = true;
    renderView();
    const search = element<HTMLInputElement>(container, "#workboard-search-input");
    search.focus();
    search.value = "release";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    renderView();
    expect(document.activeElement).toBe(search);
    const removeSearch = requireButton(container, "Remove filter: Search: “release”");
    const visibleRect = new DOMRect(0, 0, 120, 32);
    const visibleRects = Object.assign([visibleRect], {
      item: (index: number) => (index === 0 ? visibleRect : null),
    });
    // This DOM harness has no layout; model the chips visible in the desktop toolbar.
    for (const chip of container.querySelectorAll<HTMLButtonElement>(
      ".workboard-filter-chip__remove",
    )) {
      vi.spyOn(chip, "getClientRects").mockReturnValue(visibleRects);
    }
    removeSearch.focus();
    removeSearch.click();
    renderView();
    await Promise.resolve();
    expect(state.query).toBe("");
    const removePriority = requireButton(container, "Remove filter: Priority: High");
    expect(document.activeElement).toBe(removePriority);
    expect(state.statusFilter).toEqual(new Set(["ready", "blocked"]));
    removePriority.click();
    renderView();
    await Promise.resolve();
    expect(document.activeElement).toBe(buttonByLabel(container, "Filters"));
    expect(container.querySelectorAll(".workboard-filter-chip")).toHaveLength(0);
  });

  it("clears the mobile agent chip through global scope without clearing other filters", () => {
    const onClearAgentScope = vi.fn();
    const { state, container, renderView } = createWorkboardView({
      scopeAgentId: "writer",
      agentsList: { defaultId: "main", agents: [{ id: "main" }, { id: "writer" }] },
      onClearAgentScope,
    });
    state.priorityFilter = new Set(["high"]);
    state.statusFilter = new Set(["ready"]);
    state.cards = [
      createWorkboardCard({
        id: "writer-card",
        title: "Writer card",
        agentId: "writer",
        status: "ready",
        priority: "high",
      }),
      createWorkboardCard({
        id: "main-card",
        title: "Main card",
        agentId: "main",
        status: "ready",
        priority: "high",
      }),
      createWorkboardCard({
        id: "low-card",
        title: "Low priority",
        agentId: "main",
        status: "ready",
        priority: "low",
      }),
    ];
    renderView();
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Main card");
    requireButton(container, "Remove filter: Agent: writer").click();
    expect(onClearAgentScope).toHaveBeenCalledOnce();
    renderView({ scopeAgentId: null });
    expect(buttonByLabel(container, "Remove filter: Agent: writer")).toBeNull();
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Main card");
    expect(container.querySelector(".workboard-board")?.textContent).toContain("Writer card");
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain("Low priority");
    expect(state.priorityFilter).toEqual(new Set(["high"]));
    expect(state.statusFilter).toEqual(new Set(["ready"]));
  });

  it("keeps list group actions independent of its disclosure while collapsed", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "list";
    state.cards = [createWorkboardCard({ id: "todo-card", title: "Review notes", status: "todo" })];
    state.collapsedStatuses.add("todo");
    renderView();
    const group = element(container, 'section[aria-label="Todo, 1"]');
    const actions = element<HTMLButtonElement>(group, "button[popovertarget]");
    actions.click();
    expect(group.querySelector("h2 button")?.getAttribute("aria-expanded")).toBe("false");
    textButton(group, "Select all").click();
    renderView();
    expect(state.selectedCardIds).toEqual(new Set(["todo-card"]));
    expect(group.querySelector('[role="listitem"]')).toBeNull();
    requireButton(group, "New card in Todo").click();
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.draftStatus).toBe("todo");
    expect(state.collapsedStatuses).toContain("todo");
  });

  it("supports showing, collapsing, and hiding empty columns", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [createWorkboardCard({ title: "Keep visible" })];
    renderView();
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);
    expect(container.querySelector(".workboard-column--collapsed")).toBeNull();
    buttonByLabel(container, "Collapse empty")?.click();
    renderView();
    expect(state.emptyColumnMode).toBe("collapse");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(9);
    expect(container.querySelectorAll(".workboard-column--collapsed")).toHaveLength(8);
    expect(container.querySelector(".workboard-column--todo")?.classList).not.toContain(
      "workboard-column--collapsed",
    );
    buttonByLabel(container, "Collapse Todo column")?.click();
    renderView();
    expect(state.collapsedStatuses).toContain("todo");
    expect(container.querySelector(".workboard-column--todo")?.classList).toContain(
      "workboard-column--collapsed",
    );
    buttonByLabel(container, "Expand Todo column")?.click();
    renderView();
    expect(state.collapsedStatuses).not.toContain("todo");
    buttonByLabel(container, "Hide empty")?.click();
    renderView();
    expect(state.emptyColumnMode).toBe("hide");
    expect(container.querySelectorAll(".workboard-column")).toHaveLength(1);
    expect(container.querySelector(".workboard-column--todo")).not.toBeNull();
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
    const details = element(container, "#workboard-detail-panel-details");
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
    const card = element<HTMLElement>(container, ".workboard-card");
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

  it("keeps board keyboard selection intact when opening an action from the card menu", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: true });
    state.viewMode = "board";
    state.cards = [
      createWorkboardCard({ id: "first", title: "First row" }),
      createWorkboardCard({ id: "second", title: "Second row" }),
    ];
    renderView();
    const rows = container.querySelectorAll<HTMLElement>(".workboard-card");
    const first = expectDefined(rows[0], "first list row");
    const second = expectDefined(rows[1], "second list row");
    expect(first.getAttribute("aria-pressed")).toBeNull();
    expect(second.getAttribute("aria-pressed")).toBeNull();
    first.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    renderView();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(first.getAttribute("aria-haspopup")).toBeNull();
    expect(state.detailCardId).toBeNull();
    second.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    renderView();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(second.getAttribute("aria-pressed")).toBe("true");
    element<HTMLButtonElement>(second, ".workboard-card__menu-trigger").click();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
    expect(state.detailCardId).toBeNull();
    requireButton(second, "Edit card").click();
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.editingCardId).toBe("second");
    expect(state.detailCardId).toBeNull();
    expect(state.selectedCardIds).toEqual(new Set(["first", "second"]));
  });

  it("passes dialog labels and cancellation back to the plugin draft owner", async () => {
    const { host, state } = createLoadedWorkboardState();
    state.lastDispatchSummary = {
      started: 0,
      failures: 0,
      promoted: 0,
      blocked: 0,
      reclaimed: 0,
      orchestrated: 0,
    };
    state.draftOpen = true;
    state.draftTitle = "Unsaved task";
    const container = document.createElement("div");
    const props = createWorkboardRenderProps(host, {
      onRequestUpdate: () => renderInto(container, props),
    });
    renderInto(container, props);
    expect(element<HTMLElement>(container, ".workboard > openclaw-workboard-toast").hidden).toBe(
      true,
    );
    const dialog = container.querySelector("[data-test-dialog]")!;
    expect(dialog.getAttribute("aria-label")).toBe("New card");
    expect(dialog.getAttribute("aria-description")).toContain("Queue work");
    state.draftSaving = true;
    renderInto(container, props);
    const blocked = new Event("cancel", { cancelable: true });
    dialog.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);
    expect(state.draftOpen).toBe(true);
    state.draftSaving = false;
    renderInto(container, props);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(state.draftDiscardOpen).toBe(true);
    expect(state.draftOpen).toBe(true);
    textButton(container.querySelector(".workboard-discard")!, "Discard").click();
    expect(state.draftOpen).toBe(false);
    expect(container.querySelector(".workboard-draft")).toBeNull();
    await waitForFast(() =>
      expect(toast(container).shadowRoot?.querySelector("[role=status]")?.textContent?.trim()).toBe(
        "No cards were started.",
      ),
    );
  });

  it("shows unfinished parent dependencies without blocking stale local starts", () => {
    const { state, container, renderView } = createWorkboardView({
      onRequestUpdate: () => undefined,
    });
    state.cards = [
      createWorkboardCard({ id: "parent-1", title: "Finish art pass" }),
      createWorkboardCard({
        id: "child-1",
        title: "Ship game shell",
        position: 2000,
        metadata: {
          links: [{ id: "link-1", type: "parent", targetCardId: "parent-1", createdAt: 1 }],
        },
      }),
    ];
    renderView();
    const childCard = [...container.querySelectorAll<HTMLElement>(".workboard-card")].find((card) =>
      card.textContent?.includes("Ship game shell"),
    );
    const start = childCard?.querySelector<HTMLButtonElement>(".workboard-card__start");
    expect(childCard?.textContent).toContain("1 blocked");
    expect(start?.disabled).toBe(false);
    expect(start?.getAttribute("aria-label")).toBe("Run default agent");
    childCard
      ?.querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    const detail = container.querySelector(".workboard-detail");
    expect(detail?.textContent).toContain("Dependencies");
    expect(detail?.textContent).toContain("Finish art pass");
    expect(detail?.textContent).toContain("Todo");
    const detailRunButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start--autonomous",
      ),
    ];
    const detailOpenButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start--manual",
      ),
    ];
    expect(detailRunButtons.length).toBeGreaterThan(0);
    expect(detailRunButtons.every((button) => button.disabled)).toBe(false);
    expect(detailOpenButtons.length).toBeGreaterThan(0);
    expect(detailOpenButtons.every((button) => button.disabled)).toBe(false);
  });

  it("hides autonomous model override actions for non-admin operators", () => {
    const { state, container, renderView } = createWorkboardView({ canModelOverride: false });
    state.cards = [createWorkboardCard({ title: "Start with default model" })];
    renderView();
    const startButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-card__start"),
    ];
    expect(startButtons.map((button) => button.textContent?.trim())).toEqual(["Start"]);
    expect(startButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Run default agent",
    ]);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="View details"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    const detailStartButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(".workboard-detail .workboard-card__start"),
    ];
    expect(detailStartButtons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Run default agent",
      "Open OpenAI",
      "Open Claude",
    ]);
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
      const panel = element(container, ".workboard-detail__tabpanel:not([hidden])");
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
    const status = element<
      LitElement & {
        presentation: {
          label: string;
        };
      }
    >(container, "openclaw-workboard-session-status");
    expect(status.presentation.label).toBe("Queued");
    expect(container.querySelector(".workboard-card__session-marker")).toBeNull();
    expect(
      container.querySelector(".workboard-card__session-marker .session-run-spinner"),
    ).toBeNull();
    expect(container.querySelector(".workboard-card__session-name")?.textContent?.trim()).toBe(
      "Session",
    );
    await status.updateComplete;
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
      status.remove();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      expect(removeListener).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    } finally {
      removeListener.mockRestore();
    }
  });

  it("hides write controls for read-only operators", () => {
    const { state, container, renderView } = createWorkboardView({ canWrite: false });
    state.cards = [createWorkboardCard({ title: "Inspect only" })];
    renderView();
    expect(buttonByLabel(container, "Edit card")).toBeNull();
    expect(buttonByLabel(container, "Delete card")).toBeNull();
    expect(container.querySelectorAll<HTMLButtonElement>(".workboard-card__start")).toHaveLength(0);
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-heading__actions .btn.primary"),
    ).toBeNull();
    expect(container.querySelector<HTMLSelectElement>(".workboard-card__move-select")).toBeNull();
    expect(container.querySelector(".workboard-card")?.getAttribute("draggable")).toBe("false");
    expect(container.querySelector(".workboard-card")?.getAttribute("role")).toBe("button");
  });

  it("appends a status move after archived cards on its own board only", async () => {
    const { state, container, renderView } = createWorkboardView();
    const movingCard = createWorkboardCard({
      title: "Move within Operations",
      metadata: { automation: { boardId: "ops" } },
    });
    state.boardFilter = "ops";
    state.cards = [
      movingCard,
      createWorkboardCard({
        id: "archived-ops-running",
        title: "Archived Operations run",
        status: "running",
        position: 3000,
        metadata: { archivedAt: 10, automation: { boardId: "ops" } },
      }),
      createWorkboardCard({
        id: "product-running",
        title: "Unrelated Product run",
        status: "running",
        position: 9000,
        metadata: { automation: { boardId: "product" } },
      }),
    ];
    const moved = { ...movingCard, status: "running" as const, position: 4000 };
    const request = vi.fn(async () => ({ card: moved }));
    renderView({ client: { request } as unknown as GatewayBrowserClient });
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect).not.toBeNull();
    moveSelect!.value = "running";
    moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: movingCard.id,
      status: "running",
      position: 4000,
    });
    expect(state.cards).toContainEqual(moved);
  });

  it("moves a focused status control with keyboard arrows", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.cards = [createWorkboardCard({ title: "Keyboard arrow move" })];
    const request = vi.fn(async () => ({
      card: { ...state.cards[0], status: "scheduled", position: 1000, updatedAt: 2 },
    }));
    renderView({ client: { request } as unknown as GatewayBrowserClient });
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    const dispatched = moveSelect!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toBe(false);
    expect(request).toHaveBeenCalledWith("workboard.cards.move", {
      id: "card-1",
      status: "scheduled",
      position: 1000,
    });
    expect(state.cards[0]).toMatchObject({ status: "scheduled", updatedAt: 2 });
  });

  it("does not queue status-control moves while a card is busy", async () => {
    const { state, container, renderView } = createWorkboardView();
    state.busyCardIds.add("card-1");
    state.cards = [createWorkboardCard({ title: "Busy move" })];
    const request = vi.fn();
    renderView({ client: { request } as unknown as GatewayBrowserClient });
    const moveSelect = container.querySelector<HTMLSelectElement>(".workboard-card__move-select");
    expect(moveSelect?.disabled).toBe(true);
    moveSelect!.value = "blocked";
    moveSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    const dispatched = moveSelect!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
    expect(dispatched).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(state.cards[0]).toMatchObject({ status: "todo", updatedAt: 1 });
  });

  it.each([
    {
      name: "the selected named agent filter",
      scopeAgentId: null,
      agentFilter: "ops",
      expectedAgentId: "ops",
    },
    {
      name: "the unassigned default-agent filter",
      scopeAgentId: null,
      agentFilter: "default",
      expectedAgentId: "",
    },
  ])("initializes new cards from $name", ({ agentFilter, expectedAgentId }) => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        agents: [
          { id: "main", name: "Main" },
          { id: "writer", name: "Writer" },
          { id: "ops", name: "Ops" },
          { id: "workboard-dispatcher", kind: "system", name: "Dispatcher" },
        ],
      },
      scopeAgentId: null,
    });
    state.agentFilter = agentFilter;
    renderView();
    container
      .querySelector<HTMLButtonElement>(".workboard-heading__actions .workboard-create")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.draftAgentId).toBe(expectedAgentId);
    expect(
      container.querySelector<
        HTMLElement & {
          value: string;
        }
      >(".workboard-draft .workboard-agent-select [data-test-agent-picker]")?.value,
    ).toBe(expectedAgentId);
  });

  it("keeps a selected named agent while its roster has not loaded", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: null,
      defaultAgentId: "main",
      scopeAgentId: "writer",
    });
    state.agentFilter = "all";
    renderView();
    container
      .querySelector<HTMLButtonElement>(".workboard-heading__actions .workboard-create")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderView();
    expect(state.draftOpen).toBe(true);
    expect(state.draftAgentId).toBe("writer");
    expect(
      container.querySelector<
        HTMLElement & {
          value: string;
        }
      >(".workboard-draft .workboard-agent-select [data-test-agent-picker]")?.value,
    ).toBe("writer");
  });

  it("keeps a new default-agent card visible in research scope before metadata loads", async () => {
    const created = createWorkboardCard({ id: "created", title: "New default-agent work" });
    const client = createWorkboardTestClient({ "workboard.cards.create": { card: created } });
    const { state, container, renderView } = createWorkboardView({
      client,
      defaultAgentId: "research",
      scopeAgentId: "research",
    });
    state.cards = [
      createWorkboardCard({ id: "assigned", title: "Assigned default work", agentId: "research" }),
      createWorkboardCard({ id: "other", title: "Other agent work", agentId: "writer" }),
    ];
    renderView();
    textButton(container, "New card").click();
    renderView();
    const title = element<HTMLInputElement>(container, ".workboard-draft__title");
    title.value = created.title;
    title.dispatchEvent(new InputEvent("input", { bubbles: true }));
    container
      .querySelector<HTMLFormElement>(".workboard-draft")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(state.draftOpen).toBe(false));
    renderView();
    expect(client.request).toHaveBeenCalledWith(
      "workboard.cards.create",
      expect.objectContaining({ title: created.title, agentId: "" }),
    );
    expect(container.querySelector(".workboard-board")?.textContent).toContain(created.title);
    expect(container.querySelector(".workboard-board")?.textContent).not.toContain(
      "Other agent work",
    );
    statusButton(container, "Todo").click();
    renderView();
    statusButton(container, "All").click();
    renderView();
    expect(container.querySelector(".workboard-board")?.textContent).toContain(created.title);
    expect(container.querySelector(".workboard-board")?.textContent).toContain(
      "Assigned default work",
    );
  });

  it("reapplies card templates after editing their text fields", async () => {
    const client = createWorkboardTestClient({
      "workboard.cards.create": { card: createWorkboardCard({ title: "Release: " }) },
    });
    const { state, container, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => undefined,
    });
    state.draftOpen = true;
    renderView();
    const template = textButton(container, "Release");
    const fields = [
      [".workboard-draft__title", "Release: "],
      [".workboard-draft__notes", "Scope:\nVerification:\nCloseout:"],
      [".workboard-draft__labels", "release"],
    ] as const;
    template.click();
    renderView();
    for (const [selector, value] of fields) {
      const input = element<HTMLInputElement | HTMLTextAreaElement>(container, selector);
      expect(input.value).toBe(value);
      input.value = `Edited ${value}`;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    template.click();
    renderView();
    for (const [selector, value] of fields) {
      expect(container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)?.value).toBe(
        value,
      );
    }
    container
      .querySelector<HTMLFormElement>(".workboard-draft")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await waitForFast(() => expect(state.draftOpen).toBe(false));
    expect(client.request).toHaveBeenCalledExactlyOnceWith(
      "workboard.cards.create",
      expect.objectContaining({
        title: "Release: ",
        notes: "Scope:\nVerification:\nCloseout:",
        labels: ["release"],
        priority: "urgent",
        templateId: "release",
      }),
    );
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
    const archivedToggle = element<HTMLInputElement>(
      container,
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

  it("filters cards by persisted boards and keeps empty archived boards selectable", () => {
    const onBoardFilterChange = vi.fn();
    const { state, container, renderView } = createWorkboardView({ onBoardFilterChange });
    state.boards = [
      { id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
      { id: "ops", name: "Operations", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
      {
        id: "archive",
        name: "Old work",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        archivedAt: 7,
      },
    ];
    state.cards = [
      createWorkboardCard({ id: "card-default", title: "Default work" }),
      createWorkboardCard({
        id: "card-ops",
        title: "Ops work",
        position: 2000,
        metadata: { automation: { boardId: "ops" } },
      }),
    ];
    renderView();
    const boardFilter = filterPicker(container, "Filter by board");
    expect(boardFilter.options.map((option) => option.label)).toEqual(
      expect.arrayContaining(["Default board", "Operations (ops)", "Old work (archive)"]),
    );
    boardFilter.onSelect("ops");
    renderView();
    expect(onBoardFilterChange).toHaveBeenCalledWith("ops");
    expect(container.textContent).not.toContain("Default work");
    expect(container.textContent).toContain("Ops work");
  });

  it("filters cards by linked agent", () => {
    const agentsList: NonNullable<WorkboardRenderProps["agentsList"]> = {
      defaultId: "main",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    };
    const { state, container, renderView } = createWorkboardView({ agentsList });
    state.cards = [
      createWorkboardCard({ title: "Main work", agentId: "main" }),
      createWorkboardCard({ id: "card-2", title: "Ops work", agentId: "ops", position: 2000 }),
      createWorkboardCard({
        id: "card-3",
        title: "Dispatcher work",
        agentId: "workboard-dispatcher",
        position: 3000,
      }),
    ];
    renderView();
    const agentFilter = filterPicker(container, "Agent");
    for (const label of [
      "All agents",
      "Unassigned (uses Main)",
      "Main (default)",
      "Ops",
      "workboard-dispatcher (not configured)",
    ]) {
      expect(agentFilter.options.map((option) => option.label)).toContain(label);
    }
    agentFilter.onSelect("ops");
    renderView();
    expect(container.textContent).not.toContain("Main work");
    expect(container.textContent).toContain("Ops work");
    expect(state.agentFilter).toBe("ops");
    filterPicker(container, "Agent").onSelect("workboard-dispatcher");
    renderView();
    expect(container.textContent).not.toContain("Ops work");
    expect(container.textContent).toContain("Dispatcher work");
    expect(state.agentFilter).toBe("workboard-dispatcher");
  });

  it("limits assignment choices to configured agents and preserves an unknown current assignee", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        agents: [
          { id: "main", name: "Main" },
          { id: "main", name: "Main duplicate" },
          { id: "ops", name: "Ops" },
        ],
      },
    });
    state.draftOpen = true;
    state.draftTitle = "Assign me";
    state.draftAgentId = "workboard-dispatcher";
    state.cards = [createWorkboardCard({ title: "Assign me", agentId: "workboard-dispatcher" })];
    renderView();
    const draft = container.querySelector<HTMLElement>(".workboard-draft");
    const agentSelect = element<AgentPicker>(
      draft,
      ".workboard-agent-select [data-test-agent-picker]",
    );
    expect(agentSelect?.options.map((option) => option.label)).toEqual([
      "Main",
      "Main",
      "Ops",
      "workboard-dispatcher (not configured)",
    ]);
    expect(agentSelect?.options.find((option) => option.label === "Main")?.badge).toBe("Default");
    expect(agentSelect?.options.find((option) => option.label === "Ops")?.badge).toBeUndefined();
    expect(agentSelect.options.find((option) => option.value === "main")?.badge).toBeUndefined();
    agentSelect.onSelect("");
    renderView();
    expect(state.draftAgentId).toBe("");
    expect(agentSelect.value).toBe("");
  });

  it("keeps inherited detail assignment current across default and connection changes", async () => {
    const card = createWorkboardCard({ agentId: "ops" });
    const client = createWorkboardTestClient({
      "workboard.cards.update": { card: createWorkboardCard({ updatedAt: 2 }) },
    });
    const agents = [
      { id: "main", name: "Main" },
      { id: "ops", name: "Ops" },
    ];
    const { state, container, renderView } = createWorkboardView({
      client,
      agentsList: { defaultId: "main", agents },
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const picker = element<AgentPicker>(
      container,
      ".workboard-detail__agent-picker [data-test-agent-picker]",
    );
    expect(picker.options.find((option) => option.value === "")).toMatchObject({
      label: "Main",
      badge: "Default",
    });
    picker.onSelect("");
    await vi.waitFor(() => expect(state.cards[0]?.agentId).toBeUndefined());
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { agentId: "" },
    });
    renderView({ agentsList: { defaultId: "ops", agents } });
    expect(picker.value).toBe("");
    expect(picker.options.find((option) => option.value === picker.value)).toMatchObject({
      label: "Ops",
      badge: "Default",
    });
    renderView({ connected: false });
    expect(picker.disabled).toBe(true);
    renderView({ client: null });
    expect(picker.disabled).toBe(true);
    renderView();
    expect(picker.disabled).toBe(false);
  });

  it("preflights model-specific starts for ACP runtime agents", () => {
    const { state, container, renderView } = createWorkboardView({
      agentsList: {
        defaultId: "main",
        agents: [{ id: "main", name: "Main", agentRuntime: { id: "codex", source: "agent" } }],
      },
    });
    state.detailCardId = "card-1";
    state.cards = [createWorkboardCard({ title: "ACP-backed work", agentId: "main" })];
    renderView();
    const engineButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        ".workboard-detail .workboard-card__start:not(.workboard-card__start--default)",
      ),
    ];
    expect(engineButtons).toHaveLength(4);
    expect(engineButtons.every((button) => button.disabled)).toBe(true);
    expect(engineButtons[0]?.getAttribute("aria-label")).toContain("uses the codex ACP runtime");
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
    await element<LitElement>(drawer, "workboard-inline-text").updateComplete;
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

  it.each(["title", "notes"] as const)(
    "preserves an inline %s draft through lost connectivity and client availability",
    async (field) => {
      const card = createWorkboardCard({
        title: "Original title",
        notes: "Original notes",
        labels: ["original"],
      });
      const value = "Edited text";
      const patch = { [field]: value };
      const client = createWorkboardTestClient(() => ({
        card: { ...card, ...patch, updatedAt: card.updatedAt + 1 },
      }));
      const { state, container, renderView } = createWorkboardView({ client });
      state.cards = [card];
      state.detailCardId = card.id;
      renderView();
      const editor = await inlineEditor(container, field);
      const { owner } = editor;
      const input = await editor.open();
      input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const save = textButton(owner, "Save");
      for (const unavailable of [
        { connected: false, client },
        { connected: true, client: null },
      ]) {
        renderView(unavailable);
        await waitForFast(() => {
          expect(input.disabled).toBe(true);
          expect(save.disabled).toBe(true);
        });
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe(value);
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
        );
        expect(client.request).not.toHaveBeenCalled();
      }
      renderView({ connected: true, client });
      await waitForFast(() => expect(save.disabled).toBe(false));
      expect(input.value).toBe(value);
      save.click();
      await waitForFast(() =>
        expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
          id: card.id,
          expectedUpdatedAt: card.updatedAt,
          patch,
        }),
      );
      await waitForFast(() => expect(state.cards[0]).toMatchObject(patch));
    },
  );

  it("resumes dirty labels after light dismissal and clears them only on explicit cancel", async () => {
    const card = createWorkboardCard({ labels: ["original"] });
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const editor = await inlineEditor(container, "labels");
    const { trigger } = editor;
    const popup = expectDefined(editor.popover, "labels popover");
    const matches = vi.spyOn(popup, "matches").mockReturnValue(false);
    onTestFinished(() => matches.mockRestore());
    const input = await editor.open();
    input.value = "original, pending";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    popup.dispatchEvent(new Event("toggle"));
    await waitForFast(() => expect(popup.querySelector("input")).toBeNull());
    trigger.click();
    await waitForFast(() =>
      expect(popup.querySelector<HTMLInputElement>("input")?.value).toBe("original, pending"),
    );
    textButton(popup, "Cancel").click();
    await waitForFast(() => expect(popup.querySelector("input")).toBeNull());
    trigger.click();
    await waitForFast(() =>
      expect(popup.querySelector<HTMLInputElement>("input")?.value).toBe("original"),
    );
    expect(state.cards[0]?.labels).toEqual(["original"]);
  });

  it.each([
    { field: "title", change: "permission", dismiss: "none" },
    { field: "notes", change: "archive", dismiss: "none" },
    { field: "labels", change: "permission", dismiss: "before" },
    { field: "labels", change: "archive", dismiss: "after" },
  ] as const)(
    "retains dirty inline $field when live $change removes editability (dismiss=$dismiss)",
    async ({ field, change, dismiss }) => {
      const card = createWorkboardCard({ title: "Original", notes: "Original", labels: [] });
      const client = createWorkboardTestClient({});
      let canWrite = true;
      const { state, container, renderView } = createWorkboardView({
        client,
        onRequestUpdate: () => renderView({ canWrite }),
      });
      state.cards = [card];
      state.detailCardId = card.id;
      state.showArchived = false;
      renderView({ canWrite });
      const editor = await inlineEditor(container, field);
      const { trigger, owner, popover } = editor;
      let input = await editor.open();
      input.value = "Unsaved change";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      const dismissLabels = async () => {
        expectDefined(popover, "labels popover").dispatchEvent(new Event("toggle"));
        await waitForFast(() => expect(owner.querySelector("input")).toBeNull());
      };
      if (dismiss === "before") {
        await dismissLabels();
      }
      if (change === "permission") {
        canWrite = false;
      } else {
        state.cards = [{ ...card, metadata: { ...card.metadata, archivedAt: 1 } }];
      }
      renderView({ canWrite });
      if (dismiss === "after") {
        await waitForFast(() => expect(input.readOnly).toBe(true));
        await dismissLabels();
      }
      if (dismiss !== "none") {
        await waitForFast(() => expect(trigger.disabled).toBe(false));
        trigger.click();
        input = await waitForFast(() => element<HTMLInputElement>(owner, "input"));
      }
      await waitForFast(() => expect(input.readOnly).toBe(true));
      expect(input.disabled).toBe(false);
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe("Unsaved change");
      expect(owner.querySelector("input, textarea")).toBe(input);
      const save = textButton(owner, "Save");
      expect(save.disabled).toBe(true);
      save.click();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      );
      expect(client.request).not.toHaveBeenCalled();
      const close = element<HTMLButtonElement>(container, ".workboard-detail__close");
      close.click();
      expect(state.detailCardId).toBe(card.id);
      expect(input.isConnected).toBe(true);
      textButton(container.querySelector(".workboard-discard")!, "Keep editing").click();
      expect(input.value).toBe("Unsaved change");
      expect(input.readOnly).toBe(true);
      expect(input.disabled).toBe(false);
      close.click();
      textButton(container.querySelector(".workboard-discard")!, "Discard").click();
      expect(state.detailCardId).toBeNull();
      expect(input.isConnected).toBe(false);
      expect(client.request).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    { field: "priority", original: "normal", next: "high" },
    { field: "status", original: "todo", next: "ready" },
  ] as const)(
    "restores native $field selection after rejection so the same option can retry",
    async ({ field, original, next }) => {
      const card = createWorkboardCard({ priority: "normal", status: "todo" });
      let attempts = 0;
      let canonical = card;
      const mutationMethod = field === "status" ? "workboard.cards.move" : "workboard.cards.update";
      const client = createWorkboardTestClient((method) => {
        if (method === "workboard.cards.list") {
          return { cards: [canonical], boards: [] };
        }
        if (method !== mutationMethod) {
          throw new Error(`Unexpected request: ${method}`);
        }
        attempts += 1;
        if (attempts === 1) {
          canonical = { ...card, updatedAt: card.updatedAt + 1 };
          throw new GatewayProtocolRequestError({
            code: "workboard_conflict",
            message: "Review and retry the property.",
            details: { type: "workboard_card_conflict", card: canonical },
          });
        }
        canonical = { ...card, [field]: next, updatedAt: card.updatedAt + 2 };
        return { card: canonical };
      });
      const { state, container, renderView } = createWorkboardView({
        client,
        onRequestUpdate: () => renderView(),
      });
      state.cards = [card];
      state.detailCardId = card.id;
      renderView();
      const propertyOption = (value: string) =>
        element<HTMLInputElement>(
          container,
          `[name="workboard-detail-${field}-${card.id}"][value="${value}"]`,
        );
      propertyOption(next).click();
      await waitForFast(() => expect(state.error).toContain("Review and retry"));
      await waitForFast(() => {
        expect(state.loading).toBe(false);
        expect(state.mutationReadiness).toBe("ready");
        expect(propertyOption(next).disabled).toBe(false);
      });
      const choice = propertyOption(next);
      const prior = propertyOption(original);
      expect(attempts).toBe(1);
      expect(state.cards[0]?.[field]).toBe(original);
      expect(choice.checked).toBe(false);
      expect(prior.checked).toBe(true);
      choice.click();
      await waitForFast(() => expect(state.cards[0]?.[field]).toBe(next));
      expect(attempts).toBe(2);
      expect(choice.checked).toBe(true);
    },
  );

  it("guards automation navigation while keeping modified clicks native", async () => {
    const card = createWorkboardCard({ title: "Draft automation card" });
    const { state, container, renderView } = createWorkboardView({
      client: createWorkboardTestClient({}),
      onRequestUpdate: () => renderView(),
      detailBoardAutomation: {
        jobId: "job-review",
        status: "loaded",
        job: {
          id: "job-review",
          name: "Review board",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Review the board" },
          state: {},
        },
      },
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    const link = element<HTMLAnchorElement>(
      container,
      '.workboard-detail a[href*="/automations?job="]',
    );
    const allowed: boolean[] = [];
    link.addEventListener("click", (event) => {
      allowed.push(!event.defaultPrevented);
      event.preventDefault(); // Record navigation admission without leaving the test page.
    });
    const click = (init: MouseEventInit = {}) =>
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    click();
    expect(allowed).toEqual([true]);
    const trigger = await waitForFast(() =>
      element<HTMLButtonElement>(container, ".workboard-detail__text-trigger--title"),
    );
    trigger.click();
    const input = await waitForFast(() =>
      element<HTMLInputElement>(container, ".workboard-detail__text-editor--title input"),
    );
    input.value = "Unsaved title";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    for (const modifier of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
    ]) {
      click(modifier);
      expect(allowed.at(-1)).toBe(true);
      expect(container.querySelector(".workboard-discard")).toBeNull();
    }
    click();
    expect(allowed.at(-1)).toBe(false);
    expect(input.isConnected).toBe(true);
    textButton(container.querySelector(".workboard-discard")!, "Keep editing").click();
    expect(input.value).toBe("Unsaved title");
    click();
    expect(allowed.at(-1)).toBe(false);
    textButton(container.querySelector(".workboard-discard")!, "Discard").click();
    expect(allowed.at(-1)).toBe(true);
    expect(allowed.filter(Boolean)).toHaveLength(6);
  });

  it("keeps label pills mounted while editing and preserves failed input until Escape", async () => {
    const card = createWorkboardCard({ title: "Label editing", labels: ["review"] });
    const client = createWorkboardTestClient(() => {
      throw new Error("Labels unavailable");
    });
    const { state, container, renderView } = createWorkboardView({
      client,
      onRequestUpdate: () => renderView(),
    });
    state.cards = [card];
    state.detailCardId = card.id;
    renderView();
    await waitForFast(() =>
      expect(container.querySelector(".workboard-detail__labels-popover")).not.toBeNull(),
    );
    const popup = element<HTMLElement>(container, ".workboard-detail__labels-popover");
    // Native top-layer geometry is covered in the browser; this suite covers editor ownership.
    popup.showPopover = vi.fn();
    const trigger = element<HTMLButtonElement>(
      container,
      ".workboard-detail__text-trigger--labels",
    );
    trigger.click();
    await waitForFast(() => expect(popup.querySelector("input")).not.toBeNull());
    expect(trigger.isConnected).toBe(true);
    expect(trigger.textContent).toContain("review");
    const input = element<HTMLInputElement>(popup, "input");
    input.value = " review, quality, review ";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    buttonByText(popup, "Save")!.click();
    await waitForFast(() => expect(state.error).toContain("Labels unavailable"));
    expect(client.request).toHaveBeenCalledWith("workboard.cards.update", {
      id: card.id,
      expectedUpdatedAt: card.updatedAt,
      patch: { labels: ["review", "quality"] },
    });
    expect(input.value).toBe(" review, quality, review ");
    expect(trigger.isConnected).toBe(true);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    input.dispatchEvent(escape);
    await waitForFast(() => expect(popup.querySelector("input")).toBeNull());
    expect(escape.defaultPrevented).toBe(true);
    expect(state.detailCardId).toBe(card.id);
    expect(state.cards[0]?.labels).toEqual(["review"]);
    expect(document.activeElement).toBe(trigger);
  });

  it("opens an edit modal and submits card updates", async () => {
    const { host, state } = createLoadedWorkboardState();
    state.cards = [
      createWorkboardCard({
        title: "Rename me",
        notes: "Old notes",
        labels: ["ui"],
        metadata: { comments: [{ id: "comment-1", body: "Needs owner check", createdAt: 2 }] },
      }),
    ];
    const request = vi.fn(async (method: string) =>
      method === "workboard.cards.comment"
        ? {
            card: {
              ...state.cards[0],
              updatedAt: 2,
              metadata: {
                comments: [
                  ...(state.cards[0]?.metadata?.comments ?? []),
                  { id: "comment-2", body: "Ship after CI", createdAt: 3 },
                ],
              },
            },
          }
        : { card: { ...state.cards[0], title: "Renamed", priority: "high", updatedAt: 3 } },
    );
    const props = createWorkboardRenderProps(host, {
      client: { request } as unknown as GatewayBrowserClient,
      onRequestUpdate: () => undefined,
    });
    const container = document.createElement("div");
    renderInto(container, props);
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderInto(container, props);
    expect(container.querySelector("[data-test-dialog]")?.textContent).toContain("Edit card");
    expect(container.querySelector("[data-test-dialog]")?.textContent).toContain(
      "Needs owner check",
    );
    const title = container.querySelector<HTMLInputElement>(".workboard-draft__title");
    expect(title?.value).toBe("Rename me");
    title!.value = "Renamed";
    title!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const commentInput = container.querySelector<HTMLTextAreaElement>(".workboard-comments__input");
    commentInput!.value = "Ship after CI";
    commentInput!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    renderInto(container, props);
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Create"))
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: "card-1",
      body: "Ship after CI",
    });
    expect(state.cards[0]?.metadata?.comments?.at(-1)?.body).toBe("Ship after CI");
    renderInto(container, props);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Renamed",
    );
    expect(state.editingCardBase?.updatedAt).toBe(2);
    const priority = element<HTMLInputElement>(
      container,
      '.workboard-draft input[name="priority"][value="high"]',
    );
    priority.click();
    container
      .querySelector<HTMLFormElement>(".workboard-draft")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("workboard.cards.update", {
      id: "card-1",
      expectedUpdatedAt: 2,
      patch: { title: "Renamed", priority: "high" },
    });
    expect(
      request.mock.calls.filter(([method]) => method === "workboard.cards.update"),
    ).toHaveLength(1);
    expect(state.cards[0]).toMatchObject({ title: "Renamed", priority: "high", updatedAt: 3 });
    renderInto(container, props);
    expect(container.querySelector("[data-test-dialog]")).toBeNull();
    container
      .querySelector<HTMLButtonElement>('button[aria-label="Edit card"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    renderInto(container, props);
    expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
      "Renamed",
    );
    expect(container.querySelector<HTMLInputElement>('input[name="priority"]:checked')?.value).toBe(
      "high",
    );
  });

  it.each(["create", "conflict"] as const)(
    "shows %s failure inside the active card editor and preserves retryable input",
    async (operation) => {
      const card = createWorkboardCard({ title: "Original title", notes: "Original notes" });
      const current = { ...card, priority: "high" as const, updatedAt: 2 };
      const message =
        operation === "conflict" ? "Card changed. Review and retry." : `${operation} unavailable`;
      const error =
        operation === "conflict"
          ? new GatewayProtocolRequestError({
              code: "workboard_conflict",
              message,
              details: { type: "workboard_card_conflict", card: current },
            })
          : new Error(message);
      const method = operation === "create" ? "workboard.cards.create" : "workboard.cards.update";
      const saved = { ...current, title: "Unsaved title", notes: "Unsaved notes", updatedAt: 3 };
      const client = createWorkboardTestClient({ [method]: { card: saved } });
      client.request.mockImplementationOnce(async () => {
        throw error;
      });
      const { state, container, renderView } = createWorkboardView({ client });
      state.cards = operation === "create" ? [] : [card];
      renderView();
      expectDefined(
        operation === "create"
          ? buttonByText(container, "New card")
          : buttonByLabel(container, "Edit card"),
        "open card editor",
      ).click();
      renderView();
      const inputs: [string, string][] = [
        [".workboard-draft__title", "Unsaved title"],
        [".workboard-draft__notes", "Unsaved notes"],
      ];
      for (const [selector, value] of inputs) {
        const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
        input.value = value;
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      }
      const submit = () => {
        container
          .querySelector<HTMLFormElement>(".workboard-draft")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      };
      submit();
      await waitForFast(() => expect(state.error).toContain(message));
      renderView();
      expect(client.request).toHaveBeenCalledWith(method, expect.anything());
      const errorToast = toast(container.querySelector("[data-test-dialog]")!);
      await waitForFast(() =>
        expect(errorToast.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull(),
      );
      const alert = element(errorToast.shadowRoot, '[role="alert"]');
      expect(alert.textContent).toContain(message);
      expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(errorToast.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(container.querySelector<HTMLInputElement>(".workboard-draft__title")?.value).toBe(
        "Unsaved title",
      );
      expect(container.querySelector<HTMLTextAreaElement>(".workboard-draft__notes")?.value).toBe(
        "Unsaved notes",
      );
      if (operation === "conflict") {
        expect(alert.textContent).toContain("Your unsaved edits remain in the form.");
        expect(
          container.querySelector<HTMLInputElement>('input[name="priority"]:checked')?.value,
        ).toBe("high");
      }
      submit();
      await waitForFast(() => {
        expect(state.draftSaving).toBe(false);
        expect(state.busyCardIds.size).toBe(0);
      });
      renderView();
      expect(client.request).toHaveBeenCalledTimes(2);
      expect(state.error).toBeNull();
      expect(state.draftOpen).toBe(false);
    },
  );

  it("shows a failed note inside the active detail drawer and allows retry", async () => {
    const card = createWorkboardCard({ title: "Review this card" });
    const body = "Keep this note until it saves.";
    const client = createWorkboardTestClient({
      "workboard.cards.comment": {
        card: { ...card, metadata: { comments: [{ id: "note", body, createdAt: 2 }] } },
      },
    });
    client.request.mockImplementationOnce(async () => {
      throw new Error("Note unavailable");
    });
    const { state, container, renderView } = createWorkboardView({ client });
    state.cards = [card];
    renderView();
    requireButton(container, "View details").click();
    state.detailTab = "activity";
    renderView();
    const note = container.querySelector<HTMLTextAreaElement>(".workboard-detail__note")!;
    note.value = body;
    note.dispatchEvent(new InputEvent("input", { bubbles: true }));
    renderView();
    textButton(container, "Add note").click();
    await waitForFast(() => expect(state.error).toBe("Note unavailable"));
    renderView();
    const errorToast = toast(container.querySelector("[data-test-dialog]")!);
    await waitForFast(() =>
      expect(errorToast.shadowRoot?.querySelector('[role="alert"]')).not.toBeNull(),
    );
    const alert = element(errorToast.shadowRoot, '[role="alert"]');
    expect(alert.textContent).toContain("Note unavailable");
    expect(alert.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(errorToast.closest('[inert], [aria-hidden="true"]')).toBeNull();
    expect(note.value).toBe(body);
    textButton(container, "Add note").click();
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    renderView();
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(state.error).toBeNull();
    expect(container.querySelector(".workboard-detail__comments")?.textContent).toContain(body);
    expect(note.value).toBe("");
  });

  it("preserves a pending details note across close and clears it after successful submission", async () => {
    const card = createWorkboardCard({ title: "Investigate proof gap", status: "review" });
    const comment = { id: "comment-1", body: "Need Linux proof.", createdAt: 2 };
    const pending = createDeferred<{
      card: typeof card;
    }>();
    const client = createWorkboardTestClient(() => pending.promise);
    const { state, container, renderView } = createWorkboardView({ client });
    state.cards = [card];
    renderView();
    buttonByLabel(container, "View details")!.click();
    renderView();
    state.detailTab = "activity";
    renderView();
    const note = element<HTMLTextAreaElement>(container, ".workboard-detail__note");
    note.value = ` ${comment.body} `;
    note.dispatchEvent(new InputEvent("input", { bubbles: true }));
    renderView();
    buttonByText(container, "Add note")!.click();
    renderView();
    expect(note.disabled).toBe(true);
    buttonByLabel(container.querySelector(".workboard-detail")!, "Close")!.click();
    renderView();
    buttonByLabel(container, "View details")!.click();
    renderView();
    expect(state.detailCommentBody).toBe(` ${comment.body} `);
    pending.resolve({ card: { ...card, metadata: { comments: [comment] } } });
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    renderView();
    expect(client.request).toHaveBeenCalledWith("workboard.cards.comment", {
      id: card.id,
      body: comment.body,
    });
    expect(container.querySelector(".workboard-detail__comments")?.textContent).toContain(
      comment.body,
    );
    expect(state.detailCommentBody).toBe("");
    expect(state.detailCommentDrafts.has(card.id)).toBe(false);
  });

  it("keeps another card's editor draft when an earlier note finishes", async () => {
    const first = createWorkboardCard({ title: "First card" });
    const second = createWorkboardCard({ id: "card-2", title: "Second card" });
    const body = "Review this card.";
    const pending = createDeferred<{
      card: typeof first;
    }>();
    const client = createWorkboardTestClient(() => pending.promise);
    const { state, container, renderView } = createWorkboardView({ client });
    state.cards = [first, second];
    renderView();
    const editCard = (title: string) => {
      const card = expectDefined(
        [...container.querySelectorAll("article.workboard-card")].find(
          (candidate) => candidate.querySelector("h3")?.textContent === title,
        ),
        "card to edit",
      );
      requireButton(card, "Edit card").click();
      renderView();
    };
    const typeNote = () => {
      const input = element<HTMLTextAreaElement>(container, ".workboard-comments__input");
      input.value = body;
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return input;
    };
    editCard(first.title);
    typeNote();
    element<HTMLButtonElement>(container, ".workboard-comments__submit").click();
    renderView();
    requireButton(container, "Cancel").click();
    renderView();
    editCard(second.title);
    const nextNote = typeNote();
    renderView();
    pending.resolve({
      card: { ...first, metadata: { comments: [{ id: "note-1", body, createdAt: 2 }] } },
    });
    await waitForFast(() => expect(state.busyCardIds.size).toBe(0));
    renderView();
    expect(state.editingCardId).toBe(second.id);
    expect(state.draftCommentBody).toBe(body);
    expect(nextNote.value).toBe(body);
    expect(
      container.querySelector<HTMLButtonElement>(".workboard-comments__submit")?.disabled,
    ).toBe(false);
    expect(state.cards.find((card) => card.id === first.id)?.metadata?.comments?.[0]?.body).toBe(
      body,
    );
  });

  it("offers existing sessions when creating a card", () => {
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    const container = document.createElement("div");
    render(
      renderWorkboard(
        createWorkboardRenderProps(host, {
          sessions: [
            {
              key: "agent:main:dashboard:1",
              kind: "direct",
              displayName: "Existing session",
              updatedAt: 2,
            },
            createGatewaySession({ key: "global", kind: "global", agentId: "main" }),
            createGatewaySession({ key: "unknown", kind: "unknown", agentId: "main" }),
            createGatewaySession({ key: "agent:writer:unknown", agentId: "writer" }),
          ],
        }),
      ),
      container,
    );
    const picker = sessionPicker(container);
    expect(picker.options.map((option) => option.label)).toContain("No linked session");
    expect(picker.options.map((option) => option.label)).toContain("Existing session");
    expect(picker.options.map((option) => option.value)).toEqual([
      "",
      "agent:main:dashboard:1",
      "agent:writer:unknown",
    ]);
  });

  it("shows a missing current session key instead of a false empty selection", () => {
    const { host, state } = createLoadedWorkboardState();
    state.draftOpen = true;
    state.draftSessionKey = "agent:main:archived-session";
    const container = document.createElement("div");
    renderInto(container, createWorkboardRenderProps(host));
    const picker = sessionPicker(container);
    expect(picker.value).toBe("agent:main:archived-session");
    expect(picker.options).toContainEqual({
      value: "agent:main:archived-session",
      label: "agent:main:archived-session",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
