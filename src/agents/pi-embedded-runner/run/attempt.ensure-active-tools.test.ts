import { describe, expect, it, vi } from "vitest";
import { ensureActiveToolsBeforePrompt } from "./attempt.ensure-active-tools.js";

function createFakeSession(
  initialTools: { name: string }[],
  onSet?: (names: string[]) => { name: string }[],
) {
  const state = { tools: initialTools };
  return {
    state,
    session: {
      agent: { state },
      setActiveToolsByName: vi.fn((names: string[]) => {
        state.tools = onSet ? onSet(names) : names.map((name) => ({ name }));
      }),
    },
  };
}

describe("ensureActiveToolsBeforePrompt", () => {
  it("is a no-op for raw model runs", () => {
    const { session } = createFakeSession([]);
    const warn = vi.fn();
    ensureActiveToolsBeforePrompt({
      session,
      isRawModelRun: true,
      sessionToolAllowlist: ["read", "edit"],
      effectiveToolCount: 17,
      warn,
    });
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is a no-op when the allowlist is empty", () => {
    const { session } = createFakeSession([]);
    const warn = vi.fn();
    ensureActiveToolsBeforePrompt({
      session,
      isRawModelRun: false,
      sessionToolAllowlist: [],
      effectiveToolCount: 0,
      warn,
    });
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("re-applies and warns when state.tools was wiped before prompt dispatch (issue #74377)", () => {
    const allowlist = ["read", "edit", "write", "exec"];
    const { session, state } = createFakeSession([]);
    const warn = vi.fn();
    ensureActiveToolsBeforePrompt({
      session,
      isRawModelRun: false,
      sessionToolAllowlist: allowlist,
      effectiveToolCount: 17,
      warn,
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(allowlist);
    expect(state.tools).toHaveLength(allowlist.length);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("active tools were empty at prompt dispatch"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restored to 4/4"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("effective=17"));
  });

  it("re-applies idempotently and stays silent when state.tools was already populated", () => {
    const allowlist = ["read", "edit"];
    const { session } = createFakeSession([{ name: "read" }, { name: "edit" }]);
    const warn = vi.fn();
    ensureActiveToolsBeforePrompt({
      session,
      isRawModelRun: false,
      sessionToolAllowlist: allowlist,
      effectiveToolCount: 2,
      warn,
    });
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when re-apply restores fewer entries than the allowlist (Pi registry missing names)", () => {
    const allowlist = ["read", "edit", "ghost-tool"];
    const { session } = createFakeSession(
      [{ name: "read" }, { name: "edit" }, { name: "ghost-tool" }],
      // Simulate Pi dropping unknown names — only the first two survive.
      (names) => names.slice(0, 2).map((name) => ({ name })),
    );
    const warn = vi.fn();
    ensureActiveToolsBeforePrompt({
      session,
      isRawModelRun: false,
      sessionToolAllowlist: allowlist,
      effectiveToolCount: 3,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restored only 2/3"));
  });

  it("still warns 'restored to 0/N' when state was empty and re-apply also yields nothing", () => {
    const allowlist = ["read", "edit"];
    const { session } = createFakeSession([], () => []);
    const warn = vi.fn();
    ensureActiveToolsBeforePrompt({
      session,
      isRawModelRun: false,
      sessionToolAllowlist: allowlist,
      effectiveToolCount: 17,
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("restored to 0/2"));
  });

  it("does not throw when no warn callback is provided", () => {
    const { session } = createFakeSession([]);
    expect(() =>
      ensureActiveToolsBeforePrompt({
        session,
        isRawModelRun: false,
        sessionToolAllowlist: ["read"],
        effectiveToolCount: 1,
      }),
    ).not.toThrow();
  });
});
