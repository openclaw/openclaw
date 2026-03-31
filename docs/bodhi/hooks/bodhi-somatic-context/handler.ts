/**
 * bodhi-somatic-context hook handler
 *
 * Fires on agent:bootstrap.
 * Reads the current somatic state and injects it as SOMATIC_CONTEXT.md
 * into Bo's bootstrap files when state is fresh.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SOMATIC_STATE_PATH = path.join(os.homedir(), ".openclaw", "somatic-state.json");
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

const TIER_LABELS: Record<string, string> = {
  green: "GREEN — full inquiry, ZPD-appropriate complexity",
  yellow: "YELLOW — co-regulate first, then inquiry; lower complexity",
  orange: "ORANGE — somatic-only; no cognitive content; one question max",
  red: "RED — crisis protocol; presence only; activate human escalation",
};

const ZPD_LABELS: Record<string, string> = {
  simplified: "simplified (short sentences, concrete language, no lists)",
  normal: "normal (standard complexity)",
  complex: "complex (nuanced, multi-part okay)",
};

const ATTACH_LABELS: Record<string, string> = {
  reassurance_seeking: "reassurance-seeking (acknowledge explicitly before anything else)",
  independence_asserting: "independence-asserting (hold space, don't manage)",
  neutral: "neutral",
};

const APPROACH_LABELS: Record<string, string> = {
  inquiry: "Full inquiry — ask open questions, explore at ZPD depth",
  co_regulate_then_inquiry: "Co-regulate first — acknowledge the state before any question",
  somatic_only: "Somatic-only — no cognitive content, no advice, body language only",
  crisis: "Crisis protocol — presence only, stop all counseling, activate human",
};

function isFresh(timestampStr: string): boolean {
  if (!timestampStr) return false;
  try {
    const ts = new Date(timestampStr).getTime();
    return Date.now() - ts < STALE_AFTER_MS;
  } catch {
    return false;
  }
}

function buildContextMarkdown(state: Record<string, any>): string {
  const tier = state.tier || "green";
  const tierLabel = TIER_LABELS[tier] || tier;
  const zpd = state.zpd_estimate || "normal";
  const attach = state.attachment_signal || "neutral";
  const phase = (state.circadian_phase || "morning").replace("_", "-");
  const sleepSignal: boolean = state.sleep_signal || false;
  const somatic: string[] = state.somatic_signals || [];
  const incongruence: boolean = state.incongruence_detected || false;
  const crisisRaw: string[] = state.crisis_signals_raw || [];

  const lines: string[] = [
    "# SOMATIC_CONTEXT",
    "",
    "## Read this first",
    `**Tier:** ${tierLabel}`,
    "",
  ];

  if (incongruence) {
    lines.push(
      "**INCONGRUENCE DETECTED:** Language says 'fine' but somatic/crisis signals",
      "are present. Do NOT assume the stated position. Ask first.",
      ""
    );
  }

  lines.push(
    "## State Details",
    `- Circadian phase: ${phase}`,
    `- Sleep signal: ${sleepSignal ? "yes — sleep deprivation indicated" : "no"}`,
    `- ZPD estimate: ${ZPD_LABELS[zpd] || zpd}`,
    `- Attachment signal: ${ATTACH_LABELS[attach] || attach}`,
    ""
  );

  if (somatic.length > 0) {
    lines.push(
      "## Body Signals (verbatim from message)",
      "The body was in this message. Mirror what was named. Don't interpret it."
    );
    for (const sig of somatic) {
      lines.push(`- ${sig}`);
    }
    lines.push("");
  }

  if (crisisRaw.length > 0) {
    lines.push("## Crisis Signals Detected", "These phrases were in the message:");
    for (const sig of crisisRaw) {
      lines.push(`- "${sig}"`);
    }
    lines.push("");
  }

  lines.push(
    "## Protocol",
    "1. Read tier. Tier determines what response is possible.",
    "2. If incongruence_detected: ask, don't assume.",
    "3. Mirror somatic_signals if present. Name what was named.",
    "4. Match attachment_signal in your acknowledgment approach.",
    "5. Stay at or below ZPD estimate complexity.",
    "6. Only after all of the above: generate response."
  );

  return lines.join("\n");
}

const handler = async (event: any): Promise<void> => {
  if (event.type !== "agent" || event.action !== "bootstrap") {
    return;
  }

  try {
    if (!fs.existsSync(SOMATIC_STATE_PATH)) {
      return;
    }

    const raw = fs.readFileSync(SOMATIC_STATE_PATH, "utf-8");
    const state: Record<string, any> = JSON.parse(raw);

    if (!isFresh(state.message_timestamp)) {
      return; // stale state — skip, do not mislead Bo
    }

    const markdown = buildContextMarkdown(state);

    // Inject as bootstrap file
    if (event.context?.bootstrapFiles && Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.push({
        filename: "SOMATIC_CONTEXT.md",
        content: markdown,
      });
    }
  } catch (err) {
    // Never crash agent bootstrap. Log and continue.
    console.error(
      "[bodhi-somatic-context] Error:",
      err instanceof Error ? err.message : String(err)
    );
  }
};

export default handler;
