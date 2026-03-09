/**
 * Tests for buildWorkspaceSyncParams — the pure function that decides
 * which URL params the workspace URL sync effect should write.
 *
 * The primary invariant: terminal state must survive alongside other
 * URL param changes. A previous bug caused the sync effect to strip
 * ?terminal=1 whenever it fired for non-terminal reasons, closing the
 * terminal drawer on navigation.
 */
import { describe, it, expect } from "vitest";
import { buildWorkspaceSyncParams, type WorkspaceSyncState } from "./workspace-links";

function defaultState(overrides: Partial<WorkspaceSyncState> = {}): WorkspaceSyncState {
  return {
    activePath: null,
    activeSessionId: null,
    activeSubagentKey: null,
    fileChatSessionId: null,
    browseDir: null,
    showHidden: false,
    previewPath: null,
    terminalOpen: false,
    cronView: "overview",
    cronCalMode: "month",
    cronDate: null,
    cronRunFilter: "all",
    cronRun: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Terminal param preservation (regression: terminal closing on navigation)
// ---------------------------------------------------------------------------

describe("terminal param in workspace URL sync", () => {
  it("includes terminal=1 when terminal is open (prevents terminal param being stripped)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ terminalOpen: true }),
      new URLSearchParams(),
    );
    expect(params.get("terminal")).toBe("1");
  });

  it("omits terminal param when terminal is closed (prevents stale terminal=1 in URL)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ terminalOpen: false }),
      new URLSearchParams(),
    );
    expect(params.has("terminal")).toBe(false);
  });

  it("preserves terminal=1 when navigating to a file (prevents terminal close on file open)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "knowledge/notes.md", terminalOpen: true }),
      new URLSearchParams("terminal=1"),
    );
    expect(params.get("terminal")).toBe("1");
    expect(params.get("path")).toBe("knowledge/notes.md");
  });

  it("preserves terminal=1 when switching between files (prevents terminal close on navigation)", () => {
    const current = new URLSearchParams("path=old-file.md&terminal=1");
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "new-file.md", terminalOpen: true }),
      current,
    );
    expect(params.get("terminal")).toBe("1");
    expect(params.get("path")).toBe("new-file.md");
  });

  it("preserves terminal=1 when switching to chat (prevents terminal close on mode switch)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activeSessionId: "sess-42", terminalOpen: true }),
      new URLSearchParams("terminal=1"),
    );
    expect(params.get("terminal")).toBe("1");
    expect(params.get("chat")).toBe("sess-42");
  });

  it("preserves terminal=1 alongside browse mode (prevents terminal close in browse)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ browseDir: "/Users/me/projects", terminalOpen: true }),
      new URLSearchParams("terminal=1"),
    );
    expect(params.get("terminal")).toBe("1");
    expect(params.get("browse")).toBe("/Users/me/projects");
  });

  it("does not produce a URL diff when only terminal is present in current URL and state matches", () => {
    const current = new URLSearchParams("terminal=1");
    const params = buildWorkspaceSyncParams(
      defaultState({ terminalOpen: true }),
      current,
    );
    expect(params.toString()).toBe(current.toString());
  });

  it("does not produce a URL diff when file+terminal in current URL and state matches", () => {
    const current = new URLSearchParams("path=doc.md&terminal=1");
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "doc.md", terminalOpen: true }),
      current,
    );
    expect(params.toString()).toBe(current.toString());
  });
});

// ---------------------------------------------------------------------------
// Core param building (non-terminal)
// ---------------------------------------------------------------------------

describe("buildWorkspaceSyncParams core behavior", () => {
  it("sets path when activePath is present", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "knowledge/readme.md" }),
      new URLSearchParams(),
    );
    expect(params.get("path")).toBe("knowledge/readme.md");
  });

  it("sets chat + subagent when in chat mode", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activeSessionId: "sess-1", activeSubagentKey: "child-a" }),
      new URLSearchParams(),
    );
    expect(params.get("chat")).toBe("sess-1");
    expect(params.get("subagent")).toBe("child-a");
  });

  it("path takes priority over chat (only one navigation mode at a time)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "file.md", activeSessionId: "sess-1" }),
      new URLSearchParams(),
    );
    expect(params.get("path")).toBe("file.md");
    expect(params.has("chat")).toBe(false);
  });

  it("preserves entry param from current URL when path is set (entry modal is independent)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "leads" }),
      new URLSearchParams("entry=leads:abc"),
    );
    expect(params.get("entry")).toBe("leads:abc");
  });

  it("does not carry entry param when in chat mode (entry only meaningful with path)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activeSessionId: "sess-1" }),
      new URLSearchParams("entry=leads:abc"),
    );
    expect(params.has("entry")).toBe(false);
  });

  it("preserves object-view params from current URL (managed by ObjectView's own effect)", () => {
    const current = new URLSearchParams("path=leads&viewType=kanban&search=acme&sort=W10%3D&page=2&pageSize=25&cols=name,status&view=Active&filters=e30%3D");
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "leads" }),
      current,
    );
    expect(params.get("viewType")).toBe("kanban");
    expect(params.get("search")).toBe("acme");
    expect(params.get("view")).toBe("Active");
    expect(params.get("page")).toBe("2");
    expect(params.get("pageSize")).toBe("25");
  });

  it("does not carry object-view params in chat mode", () => {
    const current = new URLSearchParams("viewType=kanban&search=acme");
    const params = buildWorkspaceSyncParams(
      defaultState({ activeSessionId: "sess-1" }),
      current,
    );
    expect(params.has("viewType")).toBe(false);
    expect(params.has("search")).toBe(false);
  });

  it("includes browse dir and hidden flag", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ browseDir: "/tmp", showHidden: true }),
      new URLSearchParams(),
    );
    expect(params.get("browse")).toBe("/tmp");
    expect(params.get("hidden")).toBe("1");
  });

  it("includes preview path", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "doc.md", previewPath: "other.md" }),
      new URLSearchParams(),
    );
    expect(params.get("preview")).toBe("other.md");
  });

  it("includes cron view params for ~cron path", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "~cron", cronView: "calendar", cronCalMode: "week", cronDate: "2026-03-09" }),
      new URLSearchParams(),
    );
    expect(params.get("cronView")).toBe("calendar");
    expect(params.get("cronCalMode")).toBe("week");
    expect(params.get("cronDate")).toBe("2026-03-09");
  });

  it("omits default cron view (overview) to keep URL clean", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "~cron", cronView: "overview" }),
      new URLSearchParams(),
    );
    expect(params.has("cronView")).toBe(false);
  });

  it("includes cron run filter for ~cron/ job paths", () => {
    const params = buildWorkspaceSyncParams(
      defaultState({ activePath: "~cron/job-1", cronRunFilter: "error", cronRun: 12345 }),
      new URLSearchParams(),
    );
    expect(params.get("cronRunFilter")).toBe("error");
    expect(params.get("cronRun")).toBe("12345");
  });

  it("returns empty params when no state is set (bare / route)", () => {
    const params = buildWorkspaceSyncParams(
      defaultState(),
      new URLSearchParams(),
    );
    expect(params.toString()).toBe("");
  });
});
