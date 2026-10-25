import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabAccessEpoch, TabAccessPolicy } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type TabDocumentNavigation = {
  readonly confirmed: boolean;
  observe(event: Record<string, unknown>, send: (event: Record<string, unknown>) => void): void;
  accept(result: unknown): void;
};

type TabDocumentAccess = Pick<TabAccessPolicy, "invalidateTab" | "requireTab"> & {
  readonly fileAccessAllowed: boolean;
  provenTabIsCurrent(tabId: number, epoch: TabAccessEpoch): boolean;
  recordRootCommit(tabId: number, url: string): void;
};

type TabDocumentProvenance = Pick<TabAccessPolicy, "forwardDocumentEvent" | "navigateTab"> & {
  get(tabId: number): { navigation: TabDocumentNavigation } | undefined;
  observeTab(tab: BrowserTabSnapshot | undefined): void;
  revokeDocument(tabId: number): void;
  retireAttachment: TabAccessPolicy["retireTabDocument"];
  invalidateAll(): void;
  invalidateGroup(group?: { id: number }): void;
};

// Browser-serialized modules remain plain JavaScript. Keep test-only typing local
// so direct owner coverage does not alter the packaged resolution topology.
const { createTabDocumentProvenance } = await vi.importActual<{
  createTabDocumentProvenance: (options: { access: TabDocumentAccess }) => TabDocumentProvenance;
}>("./tab-document-provenance.js");

const originalUrl = "https://example.com/existing";
const blankResult = { frameId: "root", loaderId: "blank-loader" };
const blankFrame = { id: "root", loaderId: "blank-loader", url: "about:blank" };
type FrameChange = Partial<typeof blankFrame> & { parentId?: string; urlFragment?: string };
const frameEvent = (frame = blankFrame, sessionId?: string) => ({
  type: "cdpEvent",
  tabId: 7,
  ...(sessionId ? { sessionId } : {}),
  method: "Page.frameNavigated",
  params: { frame },
});
const contextEvent = {
  type: "cdpEvent",
  tabId: 7,
  method: "Runtime.executionContextsCleared",
  params: {},
};

class DocumentHarness {
  epoch: TabAccessEpoch = { revision: 1, groupRevision: 0, tabRevision: 1 };
  attachmentEpoch: TabAccessEpoch = { ...this.epoch, tabRevision: 2 };
  proven = new Set([this.epoch, this.attachmentEpoch]);
  isAttached = vi.fn<() => TabAccessEpoch | undefined>(() => this.attachmentEpoch);
  isCurrent = () => true;
  tab = { id: 7, url: originalUrl, groupId: 7, windowId: 1 };
  access: TabDocumentAccess = {
    fileAccessAllowed: false,
    provenTabIsCurrent: (id, epoch) => id === 7 && this.proven.has(epoch),
    requireTab: async () => this.tab,
    recordRootCommit() {},
    invalidateTab: (id) => {
      this.proven.clear();
      this.documents.revokeDocument(id);
    },
  };
  documents = createTabDocumentProvenance({ access: this.access });
  send = vi.fn();
  tree = { frameTree: { frame: { id: "root", loaderId: "original", url: originalUrl } } };
  sendCommand = vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>();
  emit = (event: Record<string, unknown>) => this.documents.forwardDocumentEvent(event, this.send);
  commitBlank = () => {
    this.tab.url = "about:blank";
    this.documents.observeTab(this.tab);
    this.emit(contextEvent);
    this.emit(frameEvent());
  };
  navigate(
    native = async (): Promise<unknown> => blankResult,
    params = { url: "about:blank", frameId: "root" },
  ) {
    this.sendCommand.mockImplementation(async (method) =>
      method === "Page.getFrameTree" ? this.tree : await native(),
    );
    return this.documents.navigateTab(
      7,
      this.epoch,
      params,
      this.isAttached,
      this.isCurrent,
      this.sendCommand,
    );
  }
  duringNavigation(effect: () => void) {
    return this.navigate(async () => {
      effect();
      return blankResult;
    });
  }
  confirmBlank = () => this.duringNavigation(this.commitBlank);
  expectRetired() {
    expect(this.documents.get(7)).toBeUndefined();
    expect(this.send).not.toHaveBeenCalled();
  }
}

let h: DocumentHarness;
beforeEach(() => {
  h = new DocumentHarness();
});

describe("commanded tab document provenance", () => {
  it("flushes queued native events after the responding root commits, including URL fragments", async () => {
    h.tab.url += "#section";
    Object.assign(h.tree.frameTree.frame, { urlFragment: "#section" });
    await expect(h.navigate()).resolves.toEqual(blankResult);
    expect(h.send).not.toHaveBeenCalled();
    h.commitBlank();
    const trace = {
      ...contextEvent,
      method: "Tracing.tracingComplete",
      params: { stream: "trace" },
    };
    h.emit(trace);
    expect(h.send.mock.calls).toEqual([[contextEvent], [frameEvent()], [trace]]);
  });

  it.each<[string, FrameChange]>([
    ["child root tree", { parentId: "parent" }],
    ["missing root id", { id: "" }],
    ["source URL disagreement", { url: "https://other.example/" }],
    ["root commit", {}],
    ["attachment revision", {}],
  ])("rejects preflight %s", async (name, frame) => {
    Object.assign(h.tree.frameTree.frame, frame);
    const navigating = h.navigate();
    if (name === "root commit") {
      h.emit(frameEvent({ ...blankFrame, url: originalUrl }));
    }
    if (name === "attachment revision") {
      h.documents.retireAttachment(7);
    }
    await expect(navigating).rejects.toThrow("current authorized root document");
    expect(h.sendCommand).toHaveBeenCalledExactlyOnceWith("Page.getFrameTree", {});
    expect(h.documents.get(7)).toBeUndefined();
  });

  it.each<[string, FrameChange, string?]>([
    ["child frame", { parentId: "parent" }],
    ["child session", {}, "child"],
    ["wrong root", { id: "other" }],
    ["uncommanded fragment", { urlFragment: "#other" }],
  ])("does not accept %s as root proof", async (source, frame, sessionId) => {
    const navigating = h.duringNavigation(() =>
      h.emit(frameEvent({ ...blankFrame, ...frame }, sessionId)),
    );
    if (source === "child frame" || source === "child session") {
      await expect(navigating).resolves.toEqual(blankResult);
      expect(h.documents.get(7)?.navigation.confirmed).toBe(false);
      expect(h.send).not.toHaveBeenCalled();
      h.documents.invalidateAll();
    } else {
      await expect(navigating).rejects.toThrow("access was revoked");
    }
    h.expectRetired();
  });

  it.each([
    { name: "wrong frame", result: { ...blankResult, frameId: "child" } },
    { name: "wrong loader", result: { ...blankResult, loaderId: "other" } },
    { name: "missing loader", result: { frameId: "root" } },
    { name: "aborted", result: { ...blankResult, errorText: "net::ERR_ABORTED" } },
    { name: "download", result: { ...blankResult, isDownload: true } },
    { name: "rejected", result: blankResult },
    { name: "competing commit", result: blankResult },
  ])("discards early events after native $name", async ({ name, result }) => {
    await expect(
      h.navigate(async () => {
        h.commitBlank();
        if (name === "rejected") {
          throw new Error("native failure");
        }
        if (name === "competing commit") {
          h.emit(frameEvent({ ...blankFrame, loaderId: "competitor" }));
        }
        return result;
      }),
    ).rejects.toThrow(name === "rejected" ? "native failure" : /confirm|revoked/);
    h.expectRetired();
    expect(h.proven.size).toBe(0);
  });

  it.each(["wrong loader", "missing loader", "competing document"])(
    "revokes a responded navigation on %s",
    async (change) => {
      await h.navigate();
      h.emit(contextEvent);
      h.emit(
        frameEvent({
          ...blankFrame,
          loaderId: change === "missing loader" ? "" : "other",
          url: change === "competing document" ? originalUrl : "about:blank",
        }),
      );
      h.expectRetired();
    },
  );

  it.each([
    { phase: "after confirmation", reason: "attachment" },
    { phase: "before response", reason: "command access" },
    { phase: "after confirmation", reason: "command access" },
    { phase: "before response", reason: "attachment access" },
    { phase: "before response", reason: "retireAttachment" },
    { phase: "before response", reason: "invalidateAll" },
    { phase: "before response", reason: "invalidateGroup" },
  ] as const)(
    "discards authority and queued events on $reason $phase",
    async ({ phase, reason }) => {
      let navigation: TabDocumentNavigation;
      const revocations = {
        attachment: () => h.isAttached.mockReturnValue(undefined),
        "command access": () => h.proven.delete(h.epoch),
        "attachment access": () => h.proven.delete(h.attachmentEpoch),
        retireAttachment: () => h.documents.retireAttachment(7),
        invalidateAll: () => h.documents.invalidateAll(),
        invalidateGroup: () => h.documents.invalidateGroup({ id: 7 }),
      };
      const revoke = revocations[reason];
      const navigating = h.duringNavigation(() => {
        h.commitBlank();
        const document = h.documents.get(7);
        assert(document);
        navigation = document.navigation;
        if (phase === "before response") {
          revoke();
        }
      });
      if (phase === "before response") {
        await expect(navigating).rejects.toThrow("access was revoked");
      } else {
        await navigating;
        h.send.mockClear();
        revoke();
        expect(() => navigation.observe(contextEvent, h.send)).toThrow("access was revoked");
      }
      h.isAttached.mockReturnValue(h.attachmentEpoch);
      h.proven.add(h.epoch).add(h.attachmentEpoch);
      expect(() => navigation.accept(blankResult)).toThrow("access was revoked");
      expect(() => navigation.observe(contextEvent, h.send)).toThrow("access was revoked");
      h.expectRetired();
    },
  );

  it.each([
    { name: "group move", tab: { groupId: -1 } },
    { name: "window move", tab: { windowId: 2 } },
    { name: "incognito", tab: { incognito: true } },
    { name: "file pending", tab: { pendingUrl: "file:///tmp/fixture" } },
    { name: "restricted document", tab: { url: "chrome://settings" } },
    { name: "lookalike blank", tab: { url: "about:blank#other" } },
    { name: "user blank", tab: {} },
  ])("retires controlled blank on $name", async ({ name, tab }) => {
    await h.confirmBlank();
    const document = h.documents.get(7);
    assert(document);
    const navigation = document.navigation;
    h.send.mockClear();
    if (name === "user blank") {
      h.emit(frameEvent({ ...blankFrame, loaderId: "user" }));
    } else {
      h.documents.observeTab(Object.assign(h.tab, tab));
    }
    expect(h.access.invalidateTab).toHaveBeenCalledWith(7);
    expect(() => navigation.observe(contextEvent, h.send)).toThrow("access was revoked");
    h.expectRetired();
    expect(h.proven.size).toBe(0);
  });

  it.each(["event count", "event bytes"])("rejects native %s overflow", async (limit) => {
    const events: Record<string, unknown>[] = [frameEvent()];
    if (limit === "event count") {
      for (let index = 1; index < 129; index++) {
        events.push({ ...contextEvent, params: { index } });
      }
    } else {
      const event = { ...contextEvent, params: { value: "" } };
      const overhead = JSON.stringify(events[0]).length + JSON.stringify(event).length;
      event.params.value = "x".repeat(256 * 1024 - overhead + 1);
      events.push(event);
    }
    const navigating = h.duringNavigation(() => {
      for (const event of events) {
        h.emit(event);
      }
      expect(h.send).not.toHaveBeenCalled();
    });
    await expect(navigating).rejects.toThrow("access was revoked");
    h.expectRetired();
  });

  it("stops flushing immediately when the receiver revokes attachment authority", async () => {
    h.send.mockImplementationOnce(() => h.documents.retireAttachment(7));
    await expect(h.confirmBlank()).rejects.toThrow("access was revoked");
    expect(h.send.mock.calls).toEqual([[contextEvent]]);
    expect(h.documents.get(7)).toBeUndefined();
  });
});
