import type { createControlUiTeamScaleFixture } from "../../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import { createActiveTranscriptReloadFixture } from "../../ui/src/test-helpers/control-ui-team-scale-history-fixture.ts";
import type { TranscriptWitnesses } from "./control-ui-warm-reload-probe.ts";

/** Native persistence primes the saved phase; measured reloads receive the live phase. */
export function createTranscriptReloadWitness(
  fixture: ReturnType<typeof createControlUiTeamScaleFixture>,
  active = false,
) {
  const messages = fixture.scenario.historyMessages ?? [];
  const index = messages.length - 1;
  const message = messages[index];
  const metadata = message?.["__openclaw"];
  if (
    message?.role !== "assistant" ||
    typeof metadata?.id !== "string" ||
    !Array.isArray(message.content)
  ) {
    throw new Error("Transcript witness requires an existing final assistant text message");
  }
  const originalText = "The current implementation is ready for verification.";
  const witnesses: TranscriptWitnesses = {
    saved: {
      messageId: `${metadata.id}-cache`,
      rowKey: "",
      text: "The cached implementation is ready for verification.",
    },
    live: {
      messageId: `${metadata.id}-fresh`,
      rowKey: "",
      text: "The latest implementation is ready for verification.",
    },
  };
  const variants: Record<"saved" | "live", unknown[]> = { saved: messages, live: messages };
  for (const source of ["saved", "live"] as const) {
    const witness = witnesses[source];
    witness.rowKey = `group:assistant:msg:id:${witness.messageId}:0`;
    let replacements = 0;
    const content = message.content.map((value) => {
      if (
        value.type !== "text" ||
        typeof value.text !== "string" ||
        !value.text.includes(originalText)
      ) {
        return value;
      }
      replacements++;
      return { ...value, text: value.text.replace(originalText, witness.text) };
    });
    if (replacements !== 1) {
      throw new Error("Transcript witness requires exactly one existing fixture paragraph");
    }
    variants[source] = messages.map((value, position) =>
      position === index
        ? { ...message, __openclaw: { ...metadata, id: witness.messageId }, content }
        : value,
    );
  }
  // Preserve the visible reaction across both IDs; one unused lookup alias remains per phase.
  const reactions = fixture.scenario.sessionReactions?.[fixture.selectedSessionKey];
  const reaction = reactions?.[metadata.id];
  if (reactions && reaction) {
    reactions[witnesses.saved.messageId] = reaction;
    reactions[witnesses.live.messageId] = reaction;
    delete reactions[metadata.id];
  }
  if (active) {
    const active = createActiveTranscriptReloadFixture(messages);
    variants.saved = active.saved;
    variants.live = active.live;
    for (const source of ["saved", "live"] as const) {
      const id = source === "saved" ? "active-reload-long-reply" : "active-reload-fresh-result";
      witnesses[source] = {
        messageId: id,
        rowKey: `group:assistant:msg:id:${id}:0`,
        text: source === "saved" ? "Verification 1" : "A fresh synthetic result",
      };
    }
    fixture.scenario.methodResponses!["chat.message.get"] = { ok: true, message: active.fullReply };
  }
  return {
    witnesses,
    variants,
    originalMessageId: active ? "active-reload-long-reply" : metadata.id,
    messageCount: variants.saved.length,
    liveMessageCount: variants.live.length,
    // Native persistence retains the last 80 distinct-sequence fixture messages.
    snapshotMessageCount: Math.min(variants.saved.length, 80),
    preparedAt: new Date().toISOString(),
  };
}
