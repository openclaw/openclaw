/** @jsxImportSource @solidjs/web */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { prepareChatMessageRender } from "../../../../ui/src/lib/chat/message-display.ts";
import { GroupedMessage } from "../../../../ui/src/pages/chat/components/chat-message-bubble-view.tsx";
import { StreamGroupParts } from "../../../../ui/src/pages/chat/components/chat-message-stream-view.tsx";
import { SidebarPanel } from "../../../../ui/src/pages/chat/components/chat-sidebar-content.tsx";
import { threadFixture } from "../../../../ui/src/pages/chat/components/chat-transcript-fixture.test-support.tsx";
import {
  threadProps,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "../../../../ui/src/pages/chat/components/chat-transcript.test-support.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import { githubReferenceOptions } from "./github-text-references.ts";

const text =
  "Original PR **openclaw/clawsweeper#1558 merged**; Follow-up PR **openclaw/clawsweeper#1576 opened**; PR openclaw/openclaw#1576; unqualified PR #1576.";
const context = githubReferenceOptions();

describe("GitHub reference presentation parity", () => {
  it.each(["persisted", "streaming", "sidebar"] as const)(
    "uses per-reference identity in %s content",
    (surface) => {
      const container = document.createElement("div");
      const message = { role: "assistant", content: text };
      if (surface === "sidebar") {
        mountSolid(
          () => (
            <SidebarPanel
              {...{
                content: { kind: "markdown", content: text },
                textReferences: context.textReferences,
                showingRawText: false,
                error: null,
                attachmentRuntime: {},
                onRetry() {},
                onClose() {},
                onViewRawText() {},
                onClick() {},
                onKeydown() {},
              }}
            />
          ),
          { container },
        );
      } else if (surface === "streaming") {
        mountSolid(
          () => (
            <StreamGroupParts
              parts={[{ kind: "stream", key: "live", text, isStreaming: true, startedAt: 1 }]}
              options={context}
              presentation="standalone"
            />
          ),
          { container },
        );
      } else {
        mountSolid(
          () => (
            <GroupedMessage
              preparation={prepareChatMessageRender(message)}
              messageKey="reply"
              options={{ ...context, isStreaming: false, showReasoning: false }}
            />
          ),
          { container },
        );
      }
      expect(
        [...container.querySelectorAll<HTMLAnchorElement>("a.markdown-github-item")].map(
          (a) => a.href,
        ),
      ).toEqual([
        "https://github.com/openclaw/clawsweeper/pull/1558",
        "https://github.com/openclaw/clawsweeper/pull/1576",
        "https://github.com/openclaw/openclaw/pull/1576",
      ]);
    },
  );
});

describe("GitHub transcript reference snapshots", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);
  it("updates explicit reference chips on contribution activation and withdrawal without transcript edits", () => {
    const props = threadProps("pane-explicit", "agent:main:explicit", [
      { role: "assistant", content: "PR openclaw/clawsweeper#1576", timestamp: 1_000 },
    ]);
    const { container, rerender } = threadFixture(props);
    const chip = () => container.querySelector<HTMLAnchorElement>("a.markdown-github-item");
    rerender();
    expect(chip()).toBeNull();
    props.textReferences = githubReferenceOptions().textReferences;
    rerender();
    expect(chip()?.href).toBe("https://github.com/openclaw/clawsweeper/pull/1576");
    props.textReferences = undefined;
    rerender();
    expect(chip()).toBeNull();
  });
});
