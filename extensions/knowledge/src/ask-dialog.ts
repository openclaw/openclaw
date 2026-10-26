import type { Page } from "./page-context.js";
import { button, el, type Detail } from "./page-dom.js";

/** Chat handoff dialog: a copyable request naming the exact record version. Nothing is sent from here. */
export function ask(
  ui: Page,
  record: Pick<NonNullable<Detail["record"]>, "id" | "title" | "kind" | "revision" | "hash">,
  correct = false,
  candidate?: { id: string; title: string },
) {
  const { s, root, errorText, agentName, askLabel } = ui;
  root.querySelector(".knowledge-chat-handoff")?.remove();
  // SAFETY: only focus() is called on it, which every focusable HTML or SVG element implements.
  const previousFocus = document.activeElement as HTMLElement | null;
  const panel = el("dialog", undefined, "knowledge-chat-handoff knowledge-surface");
  panel.setAttribute(
    "aria-label",
    candidate
      ? `${askLabel()} to check this match`
      : correct
        ? `${askLabel()} to correct this`
        : askLabel(),
  );
  panel.append(
    el("h3", panel.getAttribute("aria-label")!),
    el(
      "p",
      "Copy the request, open chat, paste it, then review and send. Nothing is sent or changed from here.",
    ),
  );
  const prompt = el("textarea");
  prompt.readOnly = true;
  prompt.rows = 9;
  prompt.setAttribute("aria-label", "Chat request");
  const request = candidate
    ? `Is "${record.title}" the same person as "${candidate.title}"? Check the evidence on both pages. Link them only if it supports that; don't merge on the handle alone.`
    : correct
      ? "Please check this saved claim against its evidence and correct or withdraw it if the evidence supports that.\n\nWhat I think is wrong: "
      : `What do you know about "${record.title}", and where did it come from?`;
  prompt.value = `${request}\n\nRecord: ${record.title}\nID: ${record.id}\nRevision: ${record.revision}\nHash: ${record.hash}${candidate ? `\nCandidate: ${candidate.id}` : ""}`;
  prompt.addEventListener("click", () => prompt.select());
  const feedback = el("p");
  feedback.setAttribute("role", "status");
  const copy = button("Copy request", () => {
    void navigator.clipboard
      .writeText(prompt.value)
      .then(() => {
        copy.textContent = "Copied";
        feedback.textContent = "Copied. Nothing has been sent.";
      })
      .catch(() => {
        prompt.select();
        feedback.textContent = "Select and copy the request above.";
      });
  });
  const chat = button("Open chat", () => {
    chat.disabled = true;
    void (async () => {
      const key = await s.context.host.sessions.create({ agentId: s.agentId || undefined });
      if (key) {
        s.context.host.sessions.open({ sessionKey: key, agentId: s.agentId || undefined });
      } else {
        feedback.textContent = "Chat was not opened. Your request is still here.";
      }
    })()
      .catch((error: unknown) => {
        feedback.textContent = errorText(error);
      })
      .finally(() => {
        chat.disabled = false;
      });
  });
  const dismiss = () => {
    panel.close();
    panel.remove();
    previousFocus?.focus();
  };
  panel.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  const footer = el("div", undefined, "knowledge-actions");
  footer.append(button("Cancel", dismiss, "knowledge-quiet"), copy, chat);
  panel.append(
    prompt,
    el(
      "p",
      `The ID, revision and hash let ${agentName() ?? "your agent"} confirm it’s looking at the same version you are.`,
      "knowledge-muted",
    ),
    footer,
    feedback,
  );
  root.append(panel);
  panel.showModal();
  prompt.focus();
}
