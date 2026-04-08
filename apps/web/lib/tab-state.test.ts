// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  HOME_TAB,
  HOME_TAB_ID,
  loadTabs,
  makeTabPermanent,
  openTab,
  reorderTabs,
  saveTabs,
  togglePinTab,
  inferTabType,
  type Tab,
  type TabState,
} from "./tab-state";

function baseState(): TabState {
  return {
    tabs: [HOME_TAB],
    activeTabId: HOME_TAB_ID,
  };
}

function fileTab(params: { id: string; path: string; title: string }): Tab {
  return {
    id: params.id,
    type: "file",
    path: params.path,
    title: params.title,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("inferTabType", () => {
  it("recognizes cloud virtual tabs", () => {
    expect(inferTabType("~cloud")).toBe("cloud");
  });

  it("recognizes integrations virtual tabs", () => {
    expect(inferTabType("~integrations")).toBe("integrations");
  });

  it("recognizes skills virtual tabs", () => {
    expect(inferTabType("~skills")).toBe("skills");
  });

  it("keeps cron virtual tabs recognized", () => {
    expect(inferTabType("~cron/job-1")).toBe("cron");
  });

  it("returns file for regular paths", () => {
    expect(inferTabType("knowledge/notes.md")).toBe("file");
  });

  it("returns app for .dench.app paths", () => {
    expect(inferTabType("myapp.dench.app")).toBe("app");
  });
});

describe("tab preview behavior", () => {
  it("replaces an existing preview tab when opening a different preview", () => {
    const state = openTab(baseState(), fileTab({
      id: "preview-1",
      path: "docs/one.md",
      title: "one.md",
    }), { preview: true });

    const next = openTab(state, fileTab({
      id: "preview-2",
      path: "docs/two.md",
      title: "two.md",
    }), { preview: true });

    expect(next.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "preview-2"]);
    expect(next.tabs[1]).toMatchObject({
      path: "docs/two.md",
      preview: true,
    });
    expect(next.activeTabId).toBe("preview-2");
  });

  it("keeps the preview tab when opening an explicit permanent tab", () => {
    const previewState = openTab(baseState(), fileTab({
      id: "preview-1",
      path: "docs/preview.md",
      title: "preview.md",
    }), { preview: true });

    const next = openTab(previewState, {
      id: "perm-chat",
      type: "chat",
      title: "New Chat",
    }, { preview: false });

    expect(next.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "preview-1", "perm-chat"]);
    expect(next.tabs.find((tab) => tab.id === "preview-1")?.preview).toBe(true);
    expect(next.tabs.find((tab) => tab.id === "perm-chat")?.preview).toBeUndefined();
    expect(next.activeTabId).toBe("perm-chat");
  });

  it("reuses state when opening a tab that is already active", () => {
    const state = openTab(baseState(), fileTab({
      id: "perm-1",
      path: "docs/permanent.md",
      title: "permanent.md",
    }), { preview: false });

    const next = openTab(state, fileTab({
      id: "duplicate-id",
      path: "docs/permanent.md",
      title: "permanent.md",
    }));

    expect(next).toBe(state);
  });

  it("promotes preview tabs to permanent when requested", () => {
    const previewState = openTab(baseState(), fileTab({
      id: "preview-1",
      path: "docs/preview.md",
      title: "preview.md",
    }), { preview: true });

    const next = makeTabPermanent(previewState, "preview-1");

    expect(next.tabs.find((tab) => tab.id === "preview-1")?.preview).toBeUndefined();
    expect(next.activeTabId).toBe("preview-1");
  });

  it("pinning a preview tab clears its preview status", () => {
    const previewState = openTab(baseState(), fileTab({
      id: "preview-1",
      path: "docs/preview.md",
      title: "preview.md",
    }), { preview: true });

    const next = togglePinTab(previewState, "preview-1");

    expect(next.tabs.find((tab) => tab.id === "preview-1")).toMatchObject({
      pinned: true,
      preview: undefined,
    });
  });

  it("reuses state when activating the already active tab", () => {
    const state = openTab(baseState(), fileTab({
      id: "perm-1",
      path: "docs/permanent.md",
      title: "permanent.md",
    }), { preview: false });

    const next = activateTab(state, "perm-1");

    expect(next).toBe(state);
  });

  it("can promote the dragged preview tab before reordering it", () => {
    const permanent = openTab(baseState(), fileTab({
      id: "perm-1",
      path: "docs/permanent.md",
      title: "permanent.md",
    }), { preview: false });
    const withPreview = openTab(permanent, fileTab({
      id: "preview-1",
      path: "docs/preview.md",
      title: "preview.md",
    }), { preview: true });

    const next = reorderTabs(makeTabPermanent(withPreview, "preview-1"), 2, 1);

    expect(next.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "preview-1", "perm-1"]);
    expect(next.tabs.find((tab) => tab.id === "preview-1")?.preview).toBeUndefined();
    expect(next.tabs.find((tab) => tab.id === "perm-1")?.preview).toBeUndefined();
  });

  it("does not change preview state when another tab is reordered", () => {
    const permanentA = openTab(baseState(), fileTab({
      id: "perm-1",
      path: "docs/permanent-a.md",
      title: "permanent-a.md",
    }), { preview: false });
    const permanentB = openTab(permanentA, fileTab({
      id: "perm-2",
      path: "docs/permanent-b.md",
      title: "permanent-b.md",
    }), { preview: false });
    const withPreview = openTab(permanentB, fileTab({
      id: "preview-1",
      path: "docs/preview.md",
      title: "preview.md",
    }), { preview: true });

    const next = reorderTabs(withPreview, 1, 2);

    expect(next.tabs.find((tab) => tab.id === "preview-1")?.preview).toBe(true);
  });

  it("persists preview tabs and keeps the preview tab active", () => {
    const permanent = openTab(baseState(), fileTab({
      id: "perm-1",
      path: "docs/permanent.md",
      title: "permanent.md",
    }), { preview: false });
    const withPreview = openTab(permanent, fileTab({
      id: "preview-1",
      path: "docs/preview.md",
      title: "preview.md",
    }), { preview: true });

    saveTabs(withPreview, "workspace-1");
    const loaded = loadTabs("workspace-1");

    expect(loaded.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "perm-1", "preview-1"]);
    expect(loaded.tabs.find((tab) => tab.id === "preview-1")?.preview).toBe(true);
    expect(loaded.activeTabId).toBe("preview-1");
  });

  it("restores preview tabs from storage on reload", () => {
    window.localStorage.setItem("dench:tabs:workspace-2", JSON.stringify({
      tabs: [
        HOME_TAB,
        { id: "preview-1", type: "file", title: "preview.md", path: "docs/preview.md", preview: true },
        { id: "perm-1", type: "file", title: "perm.md", path: "docs/perm.md" },
      ],
      activeTabId: "preview-1",
    }));

    const loaded = loadTabs("workspace-2");

    expect(loaded.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "preview-1", "perm-1"]);
    expect(loaded.tabs.find((tab) => tab.id === "preview-1")?.preview).toBe(true);
    expect(loaded.activeTabId).toBe("preview-1");
  });

  it("persists temporary blank chat tabs", () => {
    const withTemporaryChat = openTab(baseState(), {
      id: "chat-preview",
      type: "chat",
      title: "New Chat",
    }, { preview: true });

    saveTabs(withTemporaryChat, "workspace-3");
    const loaded = loadTabs("workspace-3");

    expect(loaded.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "chat-preview"]);
    expect(loaded.tabs.find((tab) => tab.id === "chat-preview")).toMatchObject({
      type: "chat",
      title: "New Chat",
      preview: true,
    });
    expect(loaded.activeTabId).toBe("chat-preview");
  });

  it("dedupes persisted chat tabs that point at the same session", () => {
    window.localStorage.setItem("dench:tabs:workspace-4", JSON.stringify({
      tabs: [
        HOME_TAB,
        { id: "chat-1", type: "chat", title: "Session", sessionId: "s1", preview: true },
        { id: "chat-2", type: "chat", title: "Session Duplicate", sessionId: "s1", pinned: true },
      ],
      activeTabId: "chat-2",
    }));

    const loaded = loadTabs("workspace-4");

    expect(loaded.tabs.map((tab) => tab.id)).toEqual([HOME_TAB_ID, "chat-1"]);
    expect(loaded.tabs.find((tab) => tab.id === "chat-1")).toMatchObject({
      type: "chat",
      sessionId: "s1",
      pinned: true,
      preview: undefined,
    });
    expect(loaded.activeTabId).toBe("chat-1");
  });
});
