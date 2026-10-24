import { metadataBlock } from "./claim-view.js";
import { originalDownload } from "./evidence-view.js";
import type { Page } from "./page-context.js";
import { button, el, fileKind, fileSize, type Detail, type RecordDetail } from "./page-dom.js";
import { icon } from "./ui-icons.js";

/** The File details disclosure: identity facts, raw Markdown and revision history slots. */
export function fileDetails(ui: Page, r: RecordDetail, id: string, n: number) {
  const { s, feature, failure } = ui;
  const files = el("details", undefined, "knowledge-file-details");
  files.dataset.readingKey = `files:${id}`;
  files.dataset.preserveSignature = `${r.hash}:${r.valid}`;
  const fileSummary = el("summary", "File details");
  fileSummary.append(icon("chevronDown", 12));
  files.append(fileSummary);
  const filePanel = el("div", undefined, "knowledge-surface knowledge-file-panel"),
    fileActions = el("div", undefined, "knowledge-file-actions");
  const dl = el("dl");
  for (const [label, value] of [
    ["File", r.path],
    ["ID", r.id],
    ["Revision", String(r.revision)],
  ]) {
    dl.append(el("dt", label), el("dd", value));
  }
  const checkpointValue = el("dd", "Checking…");
  dl.append(el("dt", "History"), checkpointValue);
  filePanel.append(dl);
  const technical = el("details", undefined, "knowledge-technical-details");
  technical.append(
    el("summary", "Technical metadata"),
    el("p", `Lifecycle: ${r.lifecycle}`),
    el("code", `SHA-256: ${r.hash}`),
    metadataBlock(ui, id, n),
  );
  const raw = button("View Markdown", () => {
    raw.disabled = true;
    let next = 0;
    const text = el("pre");
    const more = button("Read more Markdown", () => {
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
          throw new Error("Record changed; reopen it to read the current Markdown.");
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
    "History",
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

/** Cited and uncited retained files for a page, inserted above `learned` in the aside. */
export function sourcesRail(
  ui: Page,
  result: Detail,
  r: RecordDetail,
  id: string,
  n: number,
  aside: HTMLElement,
  learned: HTMLElement,
) {
  const { feature, live, errorText } = ui;
  if (r.kind === "page" && result.sourceFiles?.length) {
    // One compact row per file. Downloads need the retaining record's
    // authority, so a file retained only by a citing claim downloads there.
    const sourceFile = (file: NonNullable<typeof result.sourceFiles>[number]) => {
      const e = file.evidence,
        name = e.filename ?? e.path.split("/").at(-1)!,
        row = el("div", undefined, "knowledge-source-file"),
        copy = el("span", undefined, "knowledge-source-file-copy");
      const title = el("span", name, "knowledge-source-file-name");
      title.title = e.attribution ? `${name}\n${e.attribution}` : name;
      copy.append(
        title,
        el(
          "small",
          [
            fileKind(e),
            e.size !== undefined ? fileSize(e.size) : "",
            file.citations
              ? `${file.citations} cited ${file.citations === 1 ? "passage" : "passages"}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      if (!e.verified) {
        const warning = el("small", "Source file unavailable", "knowledge-unverified");
        warning.prepend(icon("alertTriangle", 12));
        copy.append(warning);
      }
      row.append(icon("fileText", 14), copy);
      const own = result.evidence?.some((o) => o.path === e.path && o.sha256 === e.sha256);
      if (own && e.verified) {
        const { download, status } = originalDownload(
          feature,
          id,
          e,
          () => live(n),
          errorText,
          true,
        );
        download.className = "knowledge-source-download";
        copy.append(status);
        row.append(download);
      } else if (e.verified) {
        row.title = "Download this file from the claim that cites it.";
      }
      return row;
    };
    // Cited files lead and uncited retained files collapse beneath them.
    // Outside meetings a page's own retained files already live in File
    // details, so the rail appears only when claims sourced here cite files.
    const cited = result.sourceFiles.filter((file) => file.citations),
      uncited = result.sourceFiles.filter((file) => !file.citations);
    if (cited.length || r.type === "meeting") {
      const sources = el("section", undefined, "knowledge-sources"),
        passages = cited.reduce((sum, file) => sum + file.citations, 0),
        total = result.sourceFilesTotal ?? result.sourceFiles.length;
      sources.append(
        el("h3", "Sources"),
        el(
          "p",
          `${passages} cited ${passages === 1 ? "passage" : "passages"} · ${total} ${total === 1 ? "file" : "files"}`,
          "knowledge-muted",
        ),
      );
      if (cited.length) {
        const list = el("div", undefined, "knowledge-surface knowledge-source-files");
        list.append(...cited.map(sourceFile));
        sources.append(list);
      }
      if (uncited.length) {
        const rest = el("details", undefined, "knowledge-source-uncited"),
          summary = el(
            "summary",
            `${uncited.length} ${cited.length ? "more " : ""}${uncited.length === 1 ? "file" : "files"} not cited directly`,
          ),
          list = el("div", undefined, "knowledge-surface knowledge-source-files");
        rest.dataset.readingKey = `uncited:${id}`;
        rest.open = !cited.length;
        summary.append(icon("chevronDown", 12));
        list.append(...uncited.map(sourceFile));
        rest.append(summary, list);
        sources.append(rest);
      }
      if (total > result.sourceFiles.length) {
        sources.append(
          el(
            "p",
            "Showing the first 100 files. Other files remain available from their citing claims.",
            "knowledge-muted",
          ),
        );
      }
      aside.insertBefore(sources, learned);
    }
  }
}
