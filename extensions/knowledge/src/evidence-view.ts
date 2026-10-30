import type { FeatureClient, FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { confidenceView } from "./knowledge-presentation.js";
import { icon } from "./ui-icons.js";

declare global {
  interface Window {
    /** File System Access save picker; absent in browsers without the API. */
    showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  }
}

type Detail = FeatureOutput<typeof contract, "record">;
type FileEvidence = NonNullable<Detail["evidence"]>[number];
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const n = document.createElement(tag);
  if (text) {
    n.textContent = text;
  }
  return n;
};

export function evidenceView(
  feature: FeatureClient<typeof contract>,
  result: Detail,
  alive: () => boolean,
  redact: (s: string) => string,
  expansion = { count: 20 },
  correction?: HTMLButtonElement,
  lead?: HTMLButtonElement,
) {
  const root = el("section"),
    id = result.record!.id,
    hash = result.record!.hash;
  root.className = "knowledge-evidence-list";
  root.setAttribute("aria-label", "Source evidence");
  if ((result.evidenceTotal ?? 0) > 1 || (result.evidenceSourceTotal ?? 0) > 1) {
    root.append(el("p", `${result.evidenceTotal} citations · ${result.evidenceSourceTotal} files`));
  }
  const sources = new Map<
    string,
    { node: HTMLDetailsElement; label: HTMLElement; count: number }
  >();
  const seen = new Set<string>();
  const append = (e: FileEvidence) => {
    const citationKey = JSON.stringify([
      e.path,
      e.sha256,
      e.start_line,
      e.end_line,
      e.quote,
      e.attribution,
    ]);
    if (seen.has(citationKey)) {
      return;
    }
    seen.add(citationKey);
    const sourceKey = `${e.path}:${e.sha256}`;
    let group = sources.get(sourceKey);
    if (!group) {
      const node = el("details"),
        label = el("summary");
      node.open = true;
      node.className = "knowledge-source-group";
      node.dataset.readingKey = `${id}:file:${sourceKey}`;
      node.append(label);
      root.append(node);
      group = { node, label, count: 0 };
      sources.set(sourceKey, group);
    }
    group.count++;
    group.label.textContent = `${e.filename ?? e.path.split("/").at(-1)} · ${group.count} ${group.count === 1 ? "citation" : "citations"}`;
    const article = el("article"),
      quote = el("figure"),
      metadata = el("figcaption"),
      actions = el("div");
    article.className = "knowledge-evidence-item";
    quote.className = "knowledge-evidence";
    metadata.className = "knowledge-evidence-meta";
    actions.className = "knowledge-evidence-actions";
    const caption = el("div");
    caption.className = "knowledge-excerpt-label";
    caption.append(
      el(
        "strong",
        result.record?.assertionOrigin === "agent_inference" ? "PREMISE · EXCERPT" : "EXCERPT",
      ),
      el(
        "code",
        `${e.filename ?? e.path.split("/").at(-1)}${e.start_line ? ` · lines ${e.start_line}–${e.end_line ?? e.start_line}` : ""}${e.excerptTruncated ? " · Truncated" : ""}`,
      ),
    );
    quote.append(caption);
    if (!e.verified) {
      quote.classList.add("knowledge-source-unavailable");
      quote.append(
        el("strong", "Source file unavailable"),
        el("p", "The retained file or cited location could not be verified."),
      );
    } else if (e.excerpt) {
      quote.append(excerptQuote(e.excerpt));
      // Long excerpts preview behind a toggle so one citation can't fill the page.
      if (e.excerpt.split("\n").length > 6 || e.excerpt.length > 600) {
        const toggle = el("details"),
          summary = el("summary"),
          control = el("span");
        toggle.className = "knowledge-excerpt-toggle";
        control.className = "knowledge-disclosure-label";
        toggle.dataset.readingKey = `${id}:excerpt:${e.path}:${e.sha256}:${e.start_line ?? ""}:${e.end_line ?? ""}`;
        const closed = el("span", "Show full excerpt"),
          opened = el("span", "Show less");
        closed.className = "knowledge-when-closed";
        opened.className = "knowledge-when-open";
        control.append(closed, opened, icon("chevronDown", 12));
        summary.append(control);
        toggle.append(summary);
        quote.dataset.clamped = "true";
        quote.append(toggle);
      }
    } else {
      quote.append(
        el("p", "No text preview available. Open the original file to inspect this source."),
      );
    }
    if (e.excerptTruncated) {
      quote.append(el("small", "Excerpt · Original retained in full."));
    }
    const attribution = e.attribution;
    metadata.append(
      el("span", attribution ?? "Speaker not identified"),
      confidenceView(result.record?.metadata?.attribution_confidence),
    );
    // The filename is the disclosure: hashes and other file mechanics stay out
    // of the quote-first reading path without losing inspection access.
    const details = el("details"),
      sourceName = el("summary", e.filename ?? e.path.split("/").at(-1)!);
    details.dataset.readingKey = `${id}:source:${e.path}:${e.sha256}:${e.start_line ?? ""}:${e.end_line ?? ""}`;
    details.className = "knowledge-source-reference";
    if (e.start_line !== undefined) {
      sourceName.append(
        document.createTextNode(
          ` · ${e.start_line === e.end_line ? `line ${e.start_line}` : `lines ${e.start_line}–${e.end_line ?? e.start_line}`}`,
        ),
      );
    }
    sourceName.title = "Source file details";
    const technical = el("div");
    technical.className = "knowledge-source-technical";
    technical.append(el("code", `${e.path}\nSHA-256: ${e.sha256}`));
    if (e.mediaType || e.size !== undefined) {
      technical.append(
        el(
          "p",
          [e.mediaType, e.size !== undefined ? `${e.size.toLocaleString()} bytes` : ""]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }
    if (result.record?.attribution && result.record.attribution !== attribution) {
      technical.append(el("p", `Assertion attribution: ${result.record.attribution}`));
    }
    details.append(sourceName, technical);
    metadata.append(details);
    const retained = el("span", e.verified ? "File verified" : "Source file unavailable");
    retained.className = e.verified ? "knowledge-retained" : "knowledge-unverified";
    retained.prepend(icon(e.verified ? "badgeCheck" : "info", 12));
    metadata.append(retained);
    quote.append(metadata);
    const { download, status } = originalDownload(feature, id, e, alive, redact);
    if (e.verified) {
      actions.append(download);
    }
    if (correction && !correction.parentElement) {
      actions.append(correction);
    }
    if (lead && !lead.parentElement) {
      actions.prepend(lead);
    }
    article.append(quote, actions, status);
    group.node.append(article);
  };
  result.evidence?.forEach(append);
  // A lone citation needs no per-file heading; its excerpt line names the file.
  if (
    sources.size === 1 &&
    [...sources.values()][0]!.count === 1 &&
    result.nextEvidenceOffset == null
  ) {
    root.classList.add("knowledge-evidence-single");
  }
  let offset = result.nextEvidenceOffset;
  if (offset != null) {
    const more = el("button", "More source files");
    more.type = "button";
    root.append(more);
    const loadMore = async () => {
      more.disabled = true;
      expansion.count = Math.max(expansion.count, offset! + 20);
      try {
        const page = await feature.invoke("record", {
          id,
          view: "summary",
          includeEvidence: true,
          evidenceOffset: offset!,
          evidenceLimit: 20,
        });
        if (!alive()) {
          return;
        }
        if (page.record?.hash !== hash) {
          throw new Error("Record changed; reopen it to refresh sources.");
        }
        page.evidence?.forEach(append);
        offset = page.nextEvidenceOffset;
        if (offset == null) {
          more.remove();
        } else {
          root.append(more);
          if (offset < expansion.count) {
            await loadMore();
          }
        }
      } catch (error) {
        root.append(el("p", redact(String(error))));
      } finally {
        more.disabled = false;
      }
    };
    more.addEventListener("click", () => {
      void loadMore();
    });
    if (offset < expansion.count) {
      void loadMore();
    }
  }
  return root;
}

/** Download control for one retained original, streamed through `id`'s attachment authority.
 * `compact` renders an icon-only button for dense lists such as the Sources rail. */
export function originalDownload(
  feature: FeatureClient<typeof contract>,
  id: string,
  e: FileEvidence,
  alive: () => boolean,
  redact: (s: string) => string,
  compact = false,
) {
  const name = e.filename ?? e.path.split("/").at(-1)!;
  const download = el("button", compact ? undefined : "Original file"),
    status = el("p");
  download.type = "button";
  download.prepend(icon("download", compact ? 14 : 16));
  download.disabled = !e.verified;
  if (compact) {
    download.setAttribute("aria-label", `Download ${name}`);
    download.title = `Download ${name}`;
  }
  status.className = "knowledge-download-status";
  status.setAttribute("role", "status");
  const downloadOriginal = async () => {
    download.disabled = true;
    let writer: FileSystemWritableFileStream | undefined;
    try {
      // Stream to disk when the browser supports it; otherwise use its Blob
      // download facility. Never render source HTML/SVG in the app's origin.
      const picker = window.showSaveFilePicker;
      if (picker) {
        writer = await (await picker.call(window, { suggestedName: name })).createWritable();
      }
      const chunks: ArrayBuffer[] = [];
      let offset = 0;
      while (true) {
        if (!alive()) {
          throw new Error("Record view changed; download canceled.");
        }
        const page = await feature.invoke("attachment", {
          id,
          path: e.path,
          sha256: e.sha256,
          offset,
        });
        const binary = atob(page.data),
          bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        if (page.offset !== offset || page.sha256 !== e.sha256) {
          throw new Error("Source changed during download");
        }
        if (writer) {
          await writer.write(bytes);
        } else {
          chunks.push(bytes.buffer);
        }
        status.textContent = `${(offset + bytes.length).toLocaleString()} / ${page.size.toLocaleString()} bytes`;
        if (page.nextOffset === null) {
          break;
        }
        offset = page.nextOffset;
      }
      if (writer) {
        await writer.close();
      } else {
        const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
        const link = el("a");
        link.href = url;
        link.download = name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
      status.textContent = "Original file downloaded.";
    } catch (error) {
      await writer?.abort().catch(() => {});
      status.textContent = redact(String(error));
    } finally {
      download.disabled = !e.verified;
    }
  };
  download.addEventListener("click", () => {
    void downloadOriginal();
  });
  return { download, status };
}

/** Excerpt block. Transcript lines that open with an ISO timestamp show it as a
 * muted local time, and a bracketed recorder label as a muted speaker tag; both
 * keep the recorded text in their tooltips. */
function excerptQuote(text: string) {
  const quote = el("blockquote"),
    lines = text.split("\n"),
    stamped = lines.some((line) => timestamp.test(line));
  for (const line of lines) {
    const row = el("span"),
      stamp = timestamp.exec(line);
    row.className = "knowledge-excerpt-line";
    if (stamp && !Number.isNaN(Date.parse(stamp[1]!))) {
      const at = el(
        "time",
        new Date(stamp[1]!).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
      at.className = "knowledge-excerpt-time";
      at.dateTime = stamp[1]!;
      at.title = stamp[0].trim();
      row.append(at);
      const label = speakerLabel.exec(line.slice(stamp[0].length));
      if (label) {
        const speaker = el("span", label[1]!.split(";")[0]!.trim());
        speaker.className = "knowledge-excerpt-speaker";
        speaker.title = label[0].trim();
        row.append(speaker, line.slice(stamp[0].length + label[0].length));
      } else {
        row.append(line.slice(stamp[0].length));
      }
    } else {
      row.append(line);
    }
    quote.append(row);
  }
  // Timestamped transcript lines read as a transcript; plain excerpts keep quotation marks.
  if (!stamped) {
    quote.prepend("“");
    quote.append("”");
    quote.classList.add("knowledge-excerpt-quoted");
  }
  return quote;
}
// Escaped dashes keep the pattern intact however the bundle is decoded.
// Recorders write "[start–end]", "[start — end]" or "[start]", optionally followed
// by "[label; source=…]" or "[speaker / them]".
const timestamp = /^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)(?:\s*[\u2013\u2014-]\s*[^\]]*)?\]\s*/;
const speakerLabel = /^\[([^\]\n]{1,80})\]\s*/;
