import { originalDownload } from "./evidence-view.js";
import { t } from "./i18n/index.js";
import type { Page } from "./page-context.js";
import { el, fileKind, fileSize, type Detail } from "./page-dom.js";
import { icon } from "./ui-icons.js";

/** Cited and uncited retained files for a page's aside; undefined when there is nothing to list. */
export function sourcesRail(ui: Page, result: Detail, type: string, id: string, n: number) {
  const { feature, live, errorText } = ui;
  if (!result.sourceFiles?.length) {
    return undefined;
  }
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
            ? t(file.citations === 1 ? "knowledge.record.passage" : "knowledge.record.passages", {
                count: String(file.citations),
              })
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    if (!e.verified) {
      const warning = el(
        "small",
        t("knowledge.common.sourceFileUnavailable"),
        "knowledge-unverified",
      );
      warning.prepend(icon("alertTriangle", 12));
      copy.append(warning);
    }
    row.append(icon("fileText", 14), copy);
    const own = result.evidence?.some((o) => o.path === e.path && o.sha256 === e.sha256);
    if (own && e.verified) {
      const { download, status } = originalDownload(feature, id, e, () => live(n), errorText, true);
      download.className = "knowledge-source-download";
      copy.append(status);
      row.append(download);
    } else if (e.verified) {
      row.title = t("knowledge.record.downloadFromClaim");
    }
    return row;
  };
  // Cited files lead and uncited retained files collapse beneath them.
  // Outside meetings a page's own retained files already live in File
  // details, so the rail appears only when claims sourced here cite files.
  const cited = result.sourceFiles.filter((file) => file.citations),
    uncited = result.sourceFiles.filter((file) => !file.citations);
  if (!cited.length && type !== "meeting") {
    return undefined;
  }
  const sources = el("section", undefined, "knowledge-sources"),
    passages = cited.reduce((sum, file) => sum + file.citations, 0),
    total = result.sourceFilesTotal ?? result.sourceFiles.length;
  sources.append(
    el("h3", t("knowledge.record.sources")),
    el(
      "p",
      `${t(passages === 1 ? "knowledge.record.passage" : "knowledge.record.passages", {
        count: String(passages),
      })} · ${t(total === 1 ? "knowledge.common.fileCount" : "knowledge.common.filesCount", {
        count: String(total),
      })}`,
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
        t(
          `knowledge.record.uncited${cited.length ? "More" : ""}${uncited.length === 1 ? "One" : ""}`,
          { count: String(uncited.length) },
        ),
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
    sources.append(el("p", t("knowledge.record.filesLimit"), "knowledge-muted"));
  }
  return sources;
}
