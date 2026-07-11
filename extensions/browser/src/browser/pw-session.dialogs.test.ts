// Browser tests cover pw sessionialogs plugin behavior.
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import type { Dialog, Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armObservedDialogResponseOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  getObservedBrowserStateForPage,
  isBrowserObservedDialogBlockedError,
  markObservedDialogsHandledRemotelyForPage,
  respondOrArmObservedDialogOnPage,
  respondToObservedDialogOnPage,
} from "./pw-session.js";

type Handler = (arg: unknown) => void;

function createPageHarness() {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return page;
    },
  };
  return {
    page: page as unknown as Page,
    emit: (event: string, arg: unknown) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(arg);
      }
    },
  };
}

function createDialog(
  overrides: Partial<{
    type: string;
    message: string;
    defaultValue: string;
  }> = {},
) {
  return {
    type: vi.fn(() => overrides.type ?? "confirm"),
    message: vi.fn(() => overrides.message ?? "Continue?"),
    defaultValue: vi.fn(() => overrides.defaultValue ?? ""),
    accept: vi.fn(async (_promptText?: string) => {}),
    dismiss: vi.fn(async () => {}),
  } as unknown as Dialog & {
    accept: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };
}

describe("observed browser dialogs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces pending dialogs and lets callers respond by id", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ message: "Ship it?" });

    emit("dialog", dialog);

    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", type: "confirm", message: "Ship it?" },
    ]);

    const closed = await respondToObservedDialogOnPage({
      page,
      dialogId: "d1",
      accept: true,
      promptText: "yes",
    });

    expect(dialog.accept).toHaveBeenCalledWith("yes");
    expect(closed.closedBy).toBe("agent");
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", closedBy: "agent" },
    ]);
  });

  it("keeps arm-next-dialog behavior through the observed dialog path", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Heads up" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
    emit("dialog", dialog);
    await Promise.resolve();

    expect(observed.signal.aborted).toBe(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    });
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "armed" },
    ]);
    observed.cleanup();
  });

  it("atomically arms before a dialog can appear during guarded setup", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Race" });
    const runResponse = vi.fn(
      async (
        respond: () => ReturnType<typeof respondToObservedDialogOnPage>,
        mode: "pending" | "armed",
      ) => {
        expect(mode).toBe("armed");
        return await respond();
      },
    );

    const prepared = respondOrArmObservedDialogOnPage({
      page,
      accept: false,
      timeoutMs: 1000,
      runResponse,
    });
    expect(prepared).toEqual({ kind: "armed" });
    emit("dialog", dialog);
    await vi.waitFor(() => expect(dialog.dismiss).toHaveBeenCalledOnce());

    expect(runResponse).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    });
  });

  it("runs a pending dialog response through the supplied owner", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog();
    emit("dialog", dialog);
    const runResponse = vi.fn(
      async (
        respond: () => ReturnType<typeof respondToObservedDialogOnPage>,
        mode: "pending" | "armed",
      ) => {
        expect(mode).toBe("pending");
        return await respond();
      },
    );

    const prepared = respondOrArmObservedDialogOnPage({
      page,
      dialogId: "d1",
      accept: true,
      runResponse,
    });
    expect(prepared.kind).toBe("responding");
    if (prepared.kind === "responding") {
      await prepared.response;
    }

    expect(dialog.accept).toHaveBeenCalledOnce();
    expect(runResponse).toHaveBeenCalledOnce();
  });

  it("keeps an armed dialog pending and aborts its action when its owner fails", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const observed = createObservedDialogAbortSignalForPage({ page });
    const dialog = createDialog({ type: "alert", message: "Unsafe" });
    respondOrArmObservedDialogOnPage({
      page,
      accept: false,
      timeoutMs: 1000,
      runResponse: async () => {
        throw new Error("guard rejected response");
      },
    });

    emit("dialog", dialog);
    await vi.waitFor(() => expect(observed.signal.aborted).toBe(true));

    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", message: "Unsafe" },
    ]);
    observed.cleanup();
  });

  it("does not expose a reserved dialog to a concurrent responder", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    emit("dialog", createDialog());
    let release!: () => void;
    const owner = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepared = respondOrArmObservedDialogOnPage({
      page,
      accept: true,
      runResponse: async (respond) => {
        await owner;
        return await respond();
      },
    });

    expect(() => respondOrArmObservedDialogOnPage({ page, accept: false })).toThrow(
      "A dialog response is already in progress",
    );
    release();
    if (prepared.kind === "responding") {
      await prepared.response;
    }
  });

  it("reconciles remote handling before a reserved response dispatches", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog();
    emit("dialog", dialog);
    let release!: () => void;
    const owner = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepared = respondOrArmObservedDialogOnPage({
      page,
      accept: false,
      runResponse: async (respond) => {
        await owner;
        return await respond();
      },
    });
    if (prepared.kind !== "responding") {
      throw new Error("expected pending dialog response");
    }

    const remotelyHandled = markObservedDialogsHandledRemotelyForPage(page);
    expect(remotelyHandled.dialogs.pending).toEqual([]);
    expect(remotelyHandled.dialogs.recent).toMatchObject([{ id: "d1", closedBy: "remote" }]);

    release();
    const closed = await prepared.response;
    expect(closed.closedBy).toBe("remote");
    expect(dialog.dismiss).not.toHaveBeenCalled();
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toHaveLength(1);
  });

  it("does not reconcile a remotely settled action over a dispatched response", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    let finishResponse!: () => void;
    const responsePending = new Promise<void>((resolve) => {
      finishResponse = resolve;
    });
    const dialog = createDialog();
    const pendingDismiss = vi.fn(async () => {
      await responsePending;
    });
    dialog.dismiss = pendingDismiss;
    emit("dialog", dialog);
    const prepared = respondOrArmObservedDialogOnPage({ page, accept: false });
    if (prepared.kind !== "responding") {
      throw new Error("expected pending dialog response");
    }

    expect(pendingDismiss).toHaveBeenCalledOnce();
    const whileDispatched = markObservedDialogsHandledRemotelyForPage(page);
    expect(whileDispatched.dialogs.pending).toMatchObject([{ id: "d1" }]);
    expect(whileDispatched.dialogs.recent).toEqual([]);

    finishResponse();
    await prepared.response;
    const settled = getObservedBrowserStateForPage(page);
    expect(settled.dialogs.pending).toEqual([]);
    expect(settled.dialogs.recent).toMatchObject([{ id: "d1", closedBy: "agent" }]);
    expect(settled.dialogs.recent).toHaveLength(1);
  });

  it("retires a dispatched dialog object when its protocol response fails", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const observed = createObservedDialogAbortSignalForPage({ page });
    const dialog = createDialog();
    dialog.dismiss.mockRejectedValueOnce(new Error("dialog protocol failed"));
    respondOrArmObservedDialogOnPage({ page, accept: false, timeoutMs: 1000 });

    emit("dialog", dialog);
    await vi.waitFor(() => expect(observed.signal.aborted).toBe(true));

    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    observed.cleanup();
  });

  it("uses the default arm-next-dialog timeout for non-finite timeoutMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Still armed" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: Number.NaN });
    await vi.advanceTimersByTimeAsync(119_999);
    emit("dialog", dialog);
    await Promise.resolve();

    expect(observed.signal.aborted).toBe(false);
    expect(dialog.dismiss).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    });
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "armed" },
    ]);
    observed.cleanup();
  });

  it("does not arm next-dialog responses while the process clock is invalid", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(Number.NaN);
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog({ type: "alert", message: "Still pending" });

      armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
      emit("dialog", dialog);

      expect(dialog.dismiss).not.toHaveBeenCalled();
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
        { id: "d1", type: "alert", message: "Still pending" },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not arm next-dialog responses when the expiry would overflow Date bounds", () => {
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(MAX_DATE_TIMESTAMP_MS);
      const { page, emit } = createPageHarness();
      ensurePageState(page);
      const dialog = createDialog({ type: "alert", message: "Still pending" });

      armObservedDialogResponseOnPage({ page, accept: false, timeoutMs: 1000 });
      emit("dialog", dialog);

      expect(dialog.dismiss).not.toHaveBeenCalled();
      expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
        { id: "d1", type: "alert", message: "Still pending" },
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("aborts in-flight actions while keeping unarmed dialogs pending", async () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    const dialog = createDialog({ type: "alert", message: "Heads up" });
    const observed = createObservedDialogAbortSignalForPage({ page });

    emit("dialog", dialog);

    expect(observed.signal.aborted).toBe(true);
    expect(isBrowserObservedDialogBlockedError(observed.signal.reason)).toBe(true);
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toMatchObject([
      { id: "d1", type: "alert", message: "Heads up" },
    ]);

    expect(dialog.dismiss).not.toHaveBeenCalled();
    await respondToObservedDialogOnPage({ page, dialogId: "d1", accept: false });
    observed.cleanup();

    expect(dialog.dismiss).toHaveBeenCalledOnce();
    expect(getObservedBrowserStateForPage(page).dialogs.pending).toEqual([]);
    expect(getObservedBrowserStateForPage(page).dialogs.recent).toMatchObject([
      { id: "d1", type: "alert", closedBy: "agent" },
    ]);
  });

  it("moves remotely handled pending dialogs into recent state", () => {
    const { page, emit } = createPageHarness();
    ensurePageState(page);
    emit("dialog", createDialog({ type: "confirm", message: "Continue?" }));

    const state = markObservedDialogsHandledRemotelyForPage(page);

    expect(state.dialogs.pending).toEqual([]);
    expect(state.dialogs.recent).toMatchObject([
      { id: "d1", type: "confirm", message: "Continue?", closedBy: "remote" },
    ]);
  });
});
