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

async function resolveFromTurns(
  turns: readonly CodexTurn[],
  texts: readonly string[],
  localIdentities?: readonly string[],
) {
  const identities =
    localIdentities ??
    turns
      .flatMap((nativeTurn) =>
        nativeTurn.items
          .filter((nativeItem) => nativeItem.type === "userMessage")
          .map((nativeItem) => `${nativeTurn.id}:${nativeItem.id}`),
      )
      .slice(-texts.length);
  const entries = texts.map((text, index) => entry(index, mirror(text, identities[index]!, index)));
  return await resolveEntries(turns, entries, `entry-${texts.length - 1}`);
}

async function resolveEntries(
  turns: readonly CodexTurn[],
  entries: SessionTranscriptMessageEntry[],
  entryId: string,
  canonicalThreadId?: string,
) {
  transcriptMocks.readVisibleEntries.mockResolvedValue(entries);
  const result = await resolveCodexUpstreamForkBoundary({
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
  return result.ok
    ? {
        ok: true as const,
        boundary: result.boundary,
        ...(canonicalThreadId ? { canonical: result.canonical } : {}),
      }
    : result;
}

describe("resolveCodexUpstreamForkBoundaryFromTurns", () => {
  it("rejects a selected steer message", async () => {
    const result = await resolveFromTurns(
      [turn("turn-1", [user("one"), user("steer")])],
      ["one", "steer"],
    );
    expect(result).toMatchObject({ ok: false, code: "steer-message" });
  });

  it("locates the retained user after review history", async () => {
    const result = await resolveFromTurns(
      [
        turn("turn-review", [
          item("enteredReviewMode"),
          user("hidden review prompt"),
          item("exitedReviewMode"),
        ]),
        turn("turn-2", [user("visible")]),
      ],
      ["visible"],
    );
    expect(result).toEqual({
      ok: true,
      boundary: { beforeTurnId: "turn-2", lastRetainedTurnId: "turn-review" },
    });
  });

  it("rejects an in-progress target turn", async () => {
    const result = await resolveFromTurns(
      [turn("turn-1", [user("one")], { status: "inProgress" })],
      ["one"],
    );
    expect(result).toMatchObject({ ok: false, code: "in-progress-turn" });
  });

  it("rejects inherited history absent from native projection even when a canonical target matches", async () => {
    const result = await resolveFromTurns(
      // Ordinary injected ResponseItems do not project into native turns.
      [turn("canonical-turn", [user("target")])],
      ["one", "target"],
      ["source-turn:source-user", "canonical-turn:prompt"],
    );
    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });

  it("rejects local edits to an attested harness prompt", async () => {
    const message = attestedHarnessPrompt("harness context\nvisible question");
    if (message.role !== "user") {
      throw new Error("Attestation changed the user fixture's role");
    }
    const result = await resolveEntries(
      [turn("turn-1", [user("harness context\nvisible question")])],
      [entry(0, { ...message, content: "changed question" })],
      "entry-0",
    );

    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
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

  it("rejects upstream messages carrying semantic non-text inputs", async () => {
    const result = await resolveFromTurns(
      [
        turn("turn-1", [
          user("one", [{ type: "skill", name: "reviewer", path: "/skills/reviewer" }]),
        ]),
        turn("turn-2", [user("target")]),
      ],
      ["one", "target"],
    );
    expect(result).toMatchObject({ ok: false, code: "drift-mismatch" });
  });
});
