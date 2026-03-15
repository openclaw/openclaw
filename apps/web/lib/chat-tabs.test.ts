import { describe, expect, it } from "vitest";
import { HOME_TAB, openTab, type TabState } from "./tab-state";
import {
  bindParentSessionToChatTab,
  closeChatTabsForSession,
  createBlankChatTab,
  createParentChatTab,
  createSubagentChatTab,
  openOrFocusParentChatTab,
  openOrFocusSubagentChatTab,
  resolveChatIdentityForTab,
  syncParentChatTabTitles,
  syncSubagentChatTabTitles,
} from "./chat-tabs";

function baseState(): TabState {
  return {
    tabs: [HOME_TAB],
    activeTabId: HOME_TAB.id,
  };
}

describe("chat tab helpers", () => {
  it("reuses an existing parent chat tab for the same session (prevents duplicate live tabs)", () => {
    const existing = createParentChatTab({ sessionId: "parent-1", title: "Parent" });
    const state = openTab(baseState(), existing);

    const next = openOrFocusParentChatTab(state, { sessionId: "parent-1", title: "Renamed" });

    expect(next.tabs.filter((tab) => tab.type === "chat")).toHaveLength(1);
    expect(next.activeTabId).toBe(existing.id);
  });

  it("reuses an existing subagent tab for the same child session key (prevents duplicate child viewers)", () => {
    const existing = createSubagentChatTab({
      sessionKey: "agent:child-1:subagent:abc",
      parentSessionId: "parent-1",
      title: "Child",
    });
    const state = openTab(baseState(), existing);

    const next = openOrFocusSubagentChatTab(state, {
      sessionKey: "agent:child-1:subagent:abc",
      parentSessionId: "parent-1",
      title: "Child updated",
    });

    expect(next.tabs.filter((tab) => tab.type === "chat")).toHaveLength(1);
    expect(next.activeTabId).toBe(existing.id);
  });

  it("binds a newly-created parent session id onto a draft chat tab without disturbing sibling tabs", () => {
    const draft = createBlankChatTab();
    const sibling = createParentChatTab({ sessionId: "existing-1", title: "Existing" });
    const state = {
      tabs: [HOME_TAB, draft, sibling],
      activeTabId: draft.id,
    } satisfies TabState;

    const next = bindParentSessionToChatTab(state, draft.id, "new-session-1");

    expect(next.tabs.find((tab) => tab.id === draft.id)?.sessionId).toBe("new-session-1");
    expect(next.tabs.find((tab) => tab.id === sibling.id)?.sessionId).toBe("existing-1");
  });

  it("closes a deleted parent session and all of its subagent tabs (prevents orphan child tabs)", () => {
    const parent = createParentChatTab({ sessionId: "parent-1", title: "Parent" });
    const child = createSubagentChatTab({
      sessionKey: "agent:child-1:subagent:abc",
      parentSessionId: "parent-1",
      title: "Child",
    });
    const unrelated = createParentChatTab({ sessionId: "parent-2", title: "Other" });
    const state = {
      tabs: [HOME_TAB, parent, child, unrelated],
      activeTabId: child.id,
    } satisfies TabState;

    const next = closeChatTabsForSession(state, "parent-1");

    expect(next.tabs.map((tab) => tab.id)).not.toContain(parent.id);
    expect(next.tabs.map((tab) => tab.id)).not.toContain(child.id);
    expect(next.tabs.map((tab) => tab.id)).toContain(unrelated.id);
  });

  it("syncs parent and subagent titles from persisted session metadata", () => {
    const parent = createParentChatTab({ sessionId: "parent-1", title: "Draft title" });
    const child = createSubagentChatTab({
      sessionKey: "agent:child-1:subagent:abc",
      parentSessionId: "parent-1",
      title: "Child draft",
    });
    const state = {
      tabs: [HOME_TAB, parent, child],
      activeTabId: parent.id,
    } satisfies TabState;

    const parentSynced = syncParentChatTabTitles(state, [{ id: "parent-1", title: "Real title" }]);
    const fullySynced = syncSubagentChatTabTitles(parentSynced, [
      { childSessionKey: "agent:child-1:subagent:abc", task: "Long task", label: "Research branch" },
    ]);

    expect(fullySynced.tabs.find((tab) => tab.id === parent.id)?.title).toBe("Real title");
    expect(fullySynced.tabs.find((tab) => tab.id === child.id)?.title).toBe("Research branch");
  });

  it("resolves chat identity for parent and subagent tabs", () => {
    const parent = createParentChatTab({ sessionId: "parent-1", title: "Parent" });
    const child = createSubagentChatTab({
      sessionKey: "agent:child-1:subagent:abc",
      parentSessionId: "parent-1",
      title: "Child",
    });

    expect(resolveChatIdentityForTab(parent)).toEqual({
      sessionId: "parent-1",
      subagentKey: null,
    });
    expect(resolveChatIdentityForTab(child)).toEqual({
      sessionId: "parent-1",
      subagentKey: "agent:child-1:subagent:abc",
    });
  });
});
