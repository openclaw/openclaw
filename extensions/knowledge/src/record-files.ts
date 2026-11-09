import { metadataBlock } from "./claim-view.js";
import { t } from "./i18n/index.js";
import type { Page } from "./page-context.js";
import { button, el, type RecordDetail } from "./page-dom.js";
import { icon } from "./ui-icons.js";

/** The File details disclosure: identity facts, raw Markdown and revision history slots. */
export function fileDetails(ui: Page, r: RecordDetail, id: string, n: number) {
  const { s, feature, failure } = ui;
  const files = el("details", undefined, "knowledge-file-details");
  files.dataset.readingKey = `files:${id}`;
  files.dataset.preserveSignature = `${r.hash}:${r.valid}`;
  const fileSummary = el("summary", t("knowledge.files.details"));
  fileSummary.append(icon("chevronDown", 12));
  files.append(fileSummary);
  const filePanel = el("div", undefined, "knowledge-surface knowledge-file-panel"),
    fileActions = el("div", undefined, "knowledge-file-actions");
  const dl = el("dl");
  for (const [label, value] of [
    [t("knowledge.files.file"), r.path],
    [t("knowledge.files.id"), r.id],
    [t("knowledge.files.revision"), String(r.revision)],
  ]) {
    dl.append(el("dt", label), el("dd", value));
  }
  const checkpointValue = el("dd", t("knowledge.files.checking"));
  dl.append(el("dt", t("knowledge.files.history")), checkpointValue);
  filePanel.append(dl);
  const technical = el("details", undefined, "knowledge-technical-details");
  technical.append(
    el("summary", t("knowledge.files.technical")),
    el("p", t("knowledge.files.lifecycle", { lifecycle: r.lifecycle })),
    el("code", `SHA-256: ${r.hash}`),
    metadataBlock(ui, id, n),
  );
  const raw = button(t("knowledge.files.viewMarkdown"), () => {
    raw.disabled = true;
    let next = 0;
    const text = el("pre");
    const more = button(t("knowledge.files.readMore"), () => {
      void read();
    });
    async function read() {
      more.disabled = true;
      try {
        const page = await feature.invoke("record", {
          id,
          view: "raw",
          metadataView: "none",
          offset: next,
          maxChars: 65536,
        });
        if (s.disposed || !filePanel.isConnected || !s.context.host.connection.connected) {
          return;
        }
        if (page.record?.hash !== r.hash) {
          throw new Error(t("knowledge.files.changed"));
        }
        text.textContent += page.record.raw ?? "";
        if (page.content.nextOffset === null) {
          more.remove();
        } else {
          next = page.content.nextOffset;
          more.disabled = false;
        }
      } catch (error) {
        filePanel.append(failure(error));
        more.disabled = false;
      }
    }
    filePanel.append(text, more);
    void read();
  });
  raw.prepend(icon("fileText", 14));
  const historyList = el("div", undefined, "knowledge-history-list");
  historyList.hidden = true;
  const historyButton = button(
    t("knowledge.files.history"),
    () => {
      historyList.hidden = !historyList.hidden;
      historyButton.setAttribute("aria-expanded", String(!historyList.hidden));
    },
    "knowledge-quiet",
  );
  historyButton.prepend(icon("clock", 14));
  historyButton.setAttribute("aria-expanded", "false");
  fileActions.append(raw, historyButton);
  filePanel.append(fileActions, historyList, technical);
  files.append(filePanel);
  return { files, filePanel, checkpointValue, historyList, technical };
}
