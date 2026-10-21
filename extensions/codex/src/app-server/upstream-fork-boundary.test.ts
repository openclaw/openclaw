import type { SessionTranscriptMessageEntry } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem, CodexTurn } from "./protocol.js";
import {
  attachCodexMirrorAttestation,
  fingerprintCodexMirrorSourceMessage,
} from "./transcript-mirror-attestation.js";
import { resolveCodexUpstreamForkBoundary } from "./upstream-fork-boundary.js";
import { attachCodexMirrorIdentity, attachUpstreamUserText } from "./upstream-prompt-provenance.js";

const transcriptMocks = vi.hoisted(() => ({ readVisibleEntries: vi.fn() }));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  readVisibleSessionTranscriptMessageEntries: transcriptMocks.readVisibleEntries,
}));

function item(type: string, overrides: Record<string, unknown> = {}): CodexThreadItem {
  return { id: `${type}-item`, type, ...overrides } as CodexThreadItem;
}

function user(text: string, extraContent: Record<string, unknown>[] = []): CodexThreadItem {
  return item("userMessage", {
    id: `${text}-user`,
    content: [{ type: "text", text, text_elements: [] }, ...extraContent],
  });
}

function turn(id: string, items: CodexThreadItem[], overrides: Partial<CodexTurn> = {}): CodexTurn {
  return { id, status: "completed", items, ...overrides };
}

function attestedHarnessPrompt(upstreamText: string) {
  const prompt = attachUpstreamUserText(mirror("visible question", "turn-1:prompt"), upstreamText);
  return attachCodexMirrorAttestation(prompt, fingerprintCodexMirrorSourceMessage(prompt));
}

function entry(
  index: number,
  message: SessionTranscriptMessageEntry["message"],
): SessionTranscriptMessageEntry {
  return {
    entryId: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    seq: index,
    role: "user",
    message,
  };
}

function mirror(text: string, identity: string, timestamp = 0) {
  return attachCodexMirrorIdentity({ role: "user", content: text, timestamp }, identity);
}

async function resolveEntries(
  turns: readonly CodexTurn[],
  messages: readonly (string | SessionTranscriptMessageEntry)[],
  entryId = `entry-${messages.length - 1}`,
  canonicalThreadId?: string,
) {
  const identities = turns
    .flatMap((nativeTurn) =>
      nativeTurn.items
        .filter((nativeItem) => nativeItem.type === "userMessage")
        .map((nativeItem) => `${nativeTurn.id}:${nativeItem.id}`),
    )
    .slice(-messages.length);
  const entries = messages.map((message, index) =>
    typeof message === "string"
      ? entry(index, mirror(message, identities[index]!, index))
      : message,
  );
  transcriptMocks.readVisibleEntries.mockResolvedValue(entries);
  return resolveCodexUpstreamForkBoundary({
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:upstream",
    storePath: "/tmp/does-not-matter",
    entryId,
    threadId: "thread-1",
    canonicalThreadId,
    control: {
      readThread: vi.fn(async (id: string) => ({ id, historyMode: "legacy" })),
      listTurnPage: vi.fn(async () => ({ data: [...turns] })),
    } as unknown as Parameters<typeof resolveCodexUpstreamForkBoundary>[0]["control"],
  });
}

describe("resolveCodexUpstreamForkBoundaryFromTurns", () => {
  it.each([
    [
      "a selected steer message",
      [turn("turn-1", [user("one"), user("steer")])],
      ["one", "steer"],
      "steer-message",
    ],
    [
      "an in-progress target turn",
      [turn("turn-1", [user("one")], { status: "inProgress" })],
      ["one"],
      "in-progress-turn",
    ],
    [
      "inherited history absent from native projection despite a matching target",
      // Ordinary injected ResponseItems do not project into native turns.
      [turn("canonical-turn", [user("target")])],
      [
        entry(0, mirror("one", "source-turn:source-user")),
        entry(1, mirror("target", "canonical-turn:prompt")),
      ],
      "drift-mismatch",
    ],
    [
      "local edits to an attested harness prompt",
      [turn("turn-1", [user("harness context\nvisible question")])],
      [
        entry(0, {
          ...attestedHarnessPrompt("harness context\nvisible question"),
          content: "changed question",
        }),
      ],
      "drift-mismatch",
    ],
    [
      "upstream semantic non-text inputs",
      [
        turn("turn-1", [
          user("one", [{ type: "skill", name: "reviewer", path: "/skills/reviewer" }]),
        ]),
        turn("turn-2", [user("target")]),
      ],
      ["one", "target"],
      "drift-mismatch",
    ],
  ] as const)("rejects %s", async (_, turns, messages, code) => {
    expect(await resolveEntries(turns, messages)).toMatchObject({ ok: false, code });
  });

  it("locates the retained user after review history", async () => {
    expect(
      await resolveEntries(
        [
          turn("turn-review", [
            item("enteredReviewMode"),
            user("hidden review prompt"),
            item("exitedReviewMode"),
          ]),
          turn("turn-2", [user("visible")]),
        ],
        ["visible"],
      ),
    ).toEqual({
      ok: true,
      editorText: "visible",
      boundary: { beforeTurnId: "turn-2", lastRetainedTurnId: "turn-review" },
    });
  });

  it.each([
    ["matching long text", "x".repeat(70 * 1024), "Q1", true],
    ["changed long-text suffix", "x".repeat(70 * 1024), "Q2", false],
    ["changed whitespace", "harness context\n", "Q1 \n", false],
  ] as const)(
    "compares complete attested harness prompts with %s",
    async (_, prefix, suffix, matches) => {
      const entries = [
        entry(0, attestedHarnessPrompt(`${prefix}Q1`)),
        entry(1, mirror("target", "turn-2:target-user", 1)),
      ];
      const turns = [
        turn("turn-1", [user(`${prefix}${suffix}`)]),
        turn("turn-2", [user("target")]),
      ];

      // Verify the full prompt both when selected and when retained before an unchanged target.
      for (const canonicalThreadId of [undefined, "canonical-thread"]) {
        for (const targetIndex of [0, 1]) {
          const result = await resolveEntries(
            turns,
            entries,
            `entry-${targetIndex}`,
            canonicalThreadId,
          );
          expect(result).toMatchObject(
            matches
              ? {
                  ok: true,
                  boundary: { beforeTurnId: `turn-${targetIndex + 1}` },
                  ...(canonicalThreadId
                    ? { canonical: { thread: { id: canonicalThreadId } } }
                    : {}),
                }
              : { ok: false, code: "drift-mismatch" },
          );
        }
      }
    },
  );
});
