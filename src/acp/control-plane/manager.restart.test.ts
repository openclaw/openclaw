/** Gateway shutdown must not leave a stopped manager behind for the next boot. */
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { describe, expect, it } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import {
  baseCfg,
  createRuntime,
  hoisted,
  installAcpSessionManagerTestLifecycle,
  readySessionMeta,
} from "./manager.test-helpers.js";

const { disposeAcpSessionManager, getAcpSessionManager } = await import("./manager.js");

describe("ACP session manager restart", () => {
  installAcpSessionManagerTestLifecycle();

  it("builds a fresh manager that submits prompts after shutdown disposal", async () => {
    const state = createRuntime();
    const sessionKey = "agent:codex:acp:restart";
    hoisted.requireAcpRuntimeBackendMock.mockReturnValue({ id: "acpx", runtime: state.runtime });
    hoisted.readAcpSessionEntryMock.mockReturnValue({ sessionKey, acp: readySessionMeta() });
    const beforeRestart = getAcpSessionManager();

    await disposeAcpSessionManager("gateway-shutdown");

    const afterRestart = getAcpSessionManager();
    const events: AcpRuntimeEvent[] = [];
    await afterRestart.runTurn({
      provenance: "system",
      cfg: baseCfg,
      sessionKey,
      text: "after restart",
      mode: "prompt",
      requestId: "after-restart-turn",
      admittedRunContext: createTestAdmittedRunContext("after-restart-turn"),
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(events).not.toContainEqual({ type: "done", status: "cancelled", stopReason: "cancel" });
    expect(state.runTurn).toHaveBeenCalledOnce();
    expect(afterRestart).not.toBe(beforeRestart);
  });
});
