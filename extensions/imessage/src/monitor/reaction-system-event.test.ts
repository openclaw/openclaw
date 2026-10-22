// Imessage tests cover reaction system event plugin behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { enqueueRoutedSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { enqueueIMessageReactionSystemEvent } from "./reaction-system-event.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: vi.fn(() => true),
}));

describe("enqueueIMessageReactionSystemEvent", () => {
  it.each([
    { targetGuid: "lobster-reply-guid", target: "msg lobster-reply-guid" },
    { targetGuid: undefined, target: 'message "private tapback quotation"' },
  ])("enqueues reactions without logging their content ($target)", ({ targetGuid, target }) => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
    const logVerbose = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
    onTestFinished(() => logVerbose.mockRestore());
    const text = `iMessage reaction added: 👎 by +15555550123 on ${target}`;

    const queued = enqueueIMessageReactionSystemEvent({
      decision: {
        text,
        contextKey: "imessage:reaction:added:3:lobster-reply-guid:+15555550123:👎",
        route: { agentId: "main", sessionKey: "agent:main:main" },
        reaction: {
          targetGuid,
          action: "added",
          emoji: "👎",
        },
      },
      runtime,
    });

    expect(queued).toBe(true);
    expect(enqueueRoutedSystemEvent).toHaveBeenCalledWith(
      text,
      { agentId: "main", sessionKey: "agent:main:main" },
      {
        contextKey: "imessage:reaction:added:3:lobster-reply-guid:+15555550123:👎",
      },
    );
    expect(runtime.log).toHaveBeenCalledWith(
      `imessage: reaction system event queued session=agent:main:main target=${targetGuid ?? "unknown"} action=added emoji=👎`,
    );
    expect(logVerbose).toHaveBeenCalledWith("imessage: reaction event enqueued");
  });
});
