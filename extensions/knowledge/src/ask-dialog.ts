import { t } from "./i18n/index.js";
import type { Page } from "./page-context.js";
import { button, el, type Detail } from "./page-dom.js";

type AskRecord = Pick<NonNullable<Detail["record"]>, "id" | "title" | "kind" | "revision" | "hash">;
type Candidate = { id: string; title: string };
type CreatedSession = { key?: string; runError?: { message?: string } };

// The editable request shown to the operator; the record reference is added when sending.
function initialRequest(record: AskRecord, correct: boolean, candidate?: Candidate) {
  if (candidate) {
    return `Is "${record.title}" the same person as "${candidate.title}"? Check the evidence on both pages. Link them only if it supports that; don't merge on the handle alone.`;
  }
  return correct
    ? "Please check this saved claim against its evidence and correct or withdraw it if the evidence supports that.\n\nWhat I think is wrong: "
    : `What do you know about "${record.title}", and where did it come from?`;
}

// Exact record version the agent should read, appended to the sent request.
function recordReference(record: AskRecord, candidate?: Candidate) {
  return `Record: ${record.title}\nID: ${record.id}\nRevision: ${record.revision}\nHash: ${record.hash}${candidate ? `\nCandidate: ${candidate.id}` : ""}`;
}

/** Ask dialog: sends an editable request, with the exact record version attached, as the first turn of a new chat. */
export function ask(ui: Page, record: AskRecord, correct = false, candidate?: Candidate) {
  const { s, root, errorText, agentName, askLabel } = ui;
  const host = s.context.host;
  root.querySelector(".knowledge-chat-handoff")?.remove();
  // SAFETY: only focus() is called on it, which every focusable HTML or SVG element implements.
  const previousFocus = document.activeElement as HTMLElement | null;
  const panel = el("dialog", undefined, "knowledge-chat-handoff knowledge-surface");
  panel.setAttribute(
    "aria-label",
    candidate
      ? t("knowledge.ask.checkMatch", { agent: agentName() ?? t("knowledge.common.yourAgent") })
      : correct
        ? t("knowledge.ask.correct", { agent: agentName() ?? t("knowledge.common.yourAgent") })
        : askLabel(),
  );
  panel.append(
    el("h3", panel.getAttribute("aria-label")!),
    el("p", t("knowledge.ask.body", { agent: agentName() ?? t("knowledge.common.yourAgent") })),
  );
  const prompt = el("textarea");
  prompt.rows = 5;
  prompt.setAttribute("aria-label", t("knowledge.ask.request"));
  prompt.value = initialRequest(record, correct, candidate);
  const feedback = el("p");
  feedback.setAttribute("role", "status");
  const dismiss = () => {
    panel.close();
    panel.remove();
    previousFocus?.focus();
  };
  const send = button(t("knowledge.ask.send"), () => {
    void submit();
  });
  const refreshSend = () => {
    send.disabled = !prompt.value.trim();
  };
  prompt.addEventListener("input", refreshSend);
  // Creates the session with the request as its first turn, then opens it.
  // Failures keep the dialog and the typed request so nothing is lost.
  async function submit() {
    send.disabled = true;
    feedback.textContent = "";
    try {
      const created = await host.request<CreatedSession>("sessions.create", {
        agentId: s.agentId || undefined,
        message: `${prompt.value.trim()}\n\n${recordReference(record, candidate)}`,
      });
      if (!created?.key) {
        feedback.textContent = t("knowledge.ask.notStarted");
        return;
      }
      if (created.runError) {
        feedback.textContent = t("knowledge.ask.notSent", {
          details: errorText(created.runError.message ?? t("knowledge.common.unknownError")),
        });
        return;
      }
      dismiss();
      void host.sessions.refresh().catch(() => {});
      host.sessions.open({ sessionKey: created.key, agentId: s.agentId || undefined });
    } catch (error) {
      feedback.textContent = errorText(error);
    } finally {
      refreshSend();
    }
  }
  panel.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  const footer = el("div", undefined, "knowledge-actions");
  footer.append(button(t("knowledge.common.cancel"), dismiss, "knowledge-quiet"), send);
  panel.append(prompt, footer, feedback);
  root.append(panel);
  panel.showModal();
  prompt.focus();
  prompt.setSelectionRange(prompt.value.length, prompt.value.length);
}
