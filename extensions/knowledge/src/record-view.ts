import { ask } from "./ask-dialog.js";
import { renderClaim, summaryLink } from "./claim-view.js";
import { evidenceView, originalDownload } from "./evidence-view.js";
import { displayAliases, identityTag } from "./knowledge-presentation.js";
import { markdownView } from "./markdown-view.js";
import type { Page } from "./page-context.js";
import {
  button,
  chip,
  date,
  disclosureLabel,
  el,
  fileKind,
  fileSize,
  human,
  identificationDetails,
  label,
  longBodyChars,
  tile,
  withoutTitleHeading,
} from "./page-dom.js";
import { fileDetails } from "./record-files.js";
import { recordPanels } from "./record-panels.js";
import { claimVersions } from "./record-versions.js";
import { formatSourceDate, sourceDateNote } from "./temporal.js";
import { foldTimeline } from "./timeline-fold.js";
import { icon } from "./ui-icons.js";

// Field values come from JSON: primitives read as text and anything else as JSON.
const fieldText = (name: string, value: unknown) =>
  name === "occurred_at" && typeof value === "string"
    ? formatSourceDate(value)
    : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);

/** Full record page: header, notes or statement, and the aside; panels load after commit. */
export async function showDetail(
  ui: Page,
  id: string,
  n: number,
  detailTarget: HTMLElement,
  pages = 1,
  waitForPanels = false,
) {
  const {
    s,
    feature,
    live,
    errorText,
    failure,
    empty,
    agentName,
    askLabel,
    open,
    load,
    renderToolbar,
  } = ui;
  const pending: Promise<unknown>[] = [];
  const result = await feature.invoke("record", {
    id,
    maxChars: 65536,
    includeEvidence: true,
    metadataView: "compact",
    includeReferences: true,
    referenceLimit: 20,
  });
  if (!live(n)) {
    return;
  }
  if (!result.record) {
    detailTarget.replaceChildren(
      empty(
        "Record unavailable",
        "This record cannot be opened in the current scope. No matching record was selected arbitrarily.",
      ),
    );
    return;
  }
  const r = result.record,
    meta = r.metadata;
  const head = el("header", undefined, "knowledge-entity-header"),
    heading = el("div");
  heading.append(el("h2", r.title));
  const occurred =
    r.occurredAt ??
    meta?.occurred_at ??
    (typeof meta?.fields?.occurred_at === "string" ? meta.fields.occurred_at : undefined);
  if (occurred) {
    heading.append(el("p", `Occurred ${formatSourceDate(occurred)}`, "knowledge-occurred"));
    const note = sourceDateNote(occurred);
    if (note) {
      heading.append(el("p", note, "knowledge-muted"));
    }
  }
  const facts = el("div", undefined, "knowledge-inline-facts");
  facts.append(el("span", label(r.type)));
  const names = displayAliases(
    r.title,
    meta?.aliases ?? [],
    (result.mergedFrom ?? []).map((page) => page.title),
  );
  if (names.length) {
    const aliases = el("span", "Also called ", "knowledge-aliases");
    for (const alias of names) {
      aliases.append(chip(alias));
    }
    facts.append(aliases);
  }
  facts.append(identityTag(meta?.identity?.status));
  const fieldNodes = new Map<string, HTMLElement>();
  for (const [name, value] of Object.entries(meta?.fields ?? {})) {
    if (name === "occurred_at" || value === "" || value == null) {
      continue;
    }
    const node = el("span", `${human(name)}: ${fieldText(name, value)}`);
    fieldNodes.set(name, node);
    facts.append(node);
  }
  if (fieldNodes.size) {
    pending.push(
      feature
        .invoke("ontology", { view: "definitions", name: r.type, limit: 1 })
        .then((schema) => {
          if (!live(n)) {
            return;
          }
          for (const field of schema.definitions?.[0]?.fields ?? []) {
            const node = fieldNodes.get(field.name),
              value = meta?.fields?.[field.name];
            if (node) {
              node.textContent = `${field.label}: ${fieldText(field.name, value)}`;
            }
          }
        })
        .catch(() => {}),
    );
  }
  const askButton = button(askLabel(), () => ask(ui, r));
  askButton.prepend(icon("messageSquare", 14));
  heading.append(facts);
  const entityTile = tile(r.type, 48, r.kind);
  entityTile.classList.remove("knowledge-tile-plain");
  head.append(entityTile, heading, askButton);
  const back = button(
    "← Knowledge",
    () => {
      s.selectedId = "";
      renderToolbar();
      void load();
    },
    "knowledge-back",
  );
  back.setAttribute("aria-label", "← Knowledge");
  back.replaceChildren(icon("arrowLeft", 14), el("span", "Knowledge"));
  const breadcrumb = el("nav", undefined, "knowledge-breadcrumb");
  breadcrumb.setAttribute("aria-label", "Breadcrumb");
  breadcrumb.append(back, icon("chevronRight", 12), el("span", label(r.type)));
  const grid = el("div", undefined, "knowledge-entity-grid"),
    main = el("div", undefined, "knowledge-entity-main"),
    aside = el("aside", undefined, "knowledge-entity-aside");
  if (!r.valid) {
    main.append(el("p", "This record has validation issues.", "knowledge-notice"));
  }
  if (r.lifecycle === "merged") {
    // A merged page is history; its name, links and claims now belong to the survivor.
    const into = result.mergedInto,
      notice = el(
        "p",
        `Merged${meta?.lifecycle_change?.at ? ` ${date(meta.lifecycle_change.at)}` : ""} into ${into?.title ?? "another page"}. Its name, links and claims now count toward that page.`,
        "knowledge-notice",
      );
    head.classList.add("knowledge-historical");
    main.append(notice);
    askButton.remove();
    if (into) {
      main.append(button(`Open ${into.title} →`, () => open(into.id), "knowledge-quiet"));
    }
  } else if (r.lifecycle !== "active") {
    head.classList.add("knowledge-historical");
    main.append(
      el(
        "p",
        `Viewing history · ${r.lifecycle === "withdrawn" ? "Withdrawn" : "Replaced"}${meta?.lifecycle_change?.at ? ` ${date(meta.lifecycle_change.at)}` : ""}. ${r.lifecycle === "withdrawn" ? "Not used in search, connections or answers." : "An earlier version. Search and answers use the current one."}`,
        "knowledge-notice",
      ),
    );
    askButton.remove();
  }
  if (result.mergedFrom?.length) {
    const from = el("p", "Merged from ", "knowledge-merged-from knowledge-muted");
    for (const page of result.mergedFrom) {
      from.append(summaryLink(ui, page));
    }
    main.append(from);
  }
  const change = meta?.lifecycle_change;
  const reason =
    change && typeof change === "object" && "reason" in change && typeof change.reason === "string"
      ? change.reason
      : undefined;
  // A current claim's correction reason belongs with its versions; history keeps the notice.
  const reasonInVersions =
    r.kind === "claim" && r.lifecycle === "active" && Boolean(meta?.supersedes);
  // A merge reason explains the banner above it rather than warning again.
  if (reason && r.lifecycle === "merged") {
    main.append(el("p", `Reason: ${reason}`, "knowledge-muted knowledge-merge-reason"));
  } else if (reason && !reasonInVersions) {
    main.append(el("p", reason, "knowledge-notice"));
  }
  const supersededBy = meta?.superseded_by;
  if (typeof supersededBy === "string") {
    main.append(button("View replacement →", () => open(supersededBy), "knowledge-quiet"));
  }
  const supersedes = meta?.supersedes;
  if (typeof supersedes === "string" && r.kind !== "claim") {
    main.append(button("View original assertion", () => open(supersedes), "knowledge-quiet"));
  }
  let versionsNode: HTMLElement | undefined;
  if (r.kind === "claim" && (meta?.supersedes || meta?.superseded_by)) {
    const versions = el("section", undefined, "knowledge-versions");
    versionsNode = versions;
    versions.append(el("h3", "Versions"));
    if (reason && reasonInVersions) {
      versions.append(el("p", `Correction reason: ${reason}`, "knowledge-muted"));
    }
    // A correction writes a new record (revision 1) and rewrites the old one as superseded,
    // so per-record revisions don't order versions. Number them by position in the
    // supersedes chain instead, oldest = v1, and list newest first.
    pending.push(claimVersions(ui, r, n, versions));
  }
  const body = el("div", undefined, "knowledge-summary"),
    bodyText = withoutTitleHeading(r.body ?? "", r.title);
  let notesText = r.body ?? "",
    notesLinks = result.links ?? [];
  const navigateNotes = (targetId: string) => {
    if (targetId !== id) {
      open(targetId);
      return;
    }
    files.open = true;
    const originals = files.querySelector<HTMLDetailsElement>(".knowledge-retained-originals");
    if (originals) {
      originals.open = true;
      originals.scrollIntoView({ block: "nearest" });
    }
  };
  let renderedNotes = foldTimeline(markdownView(bodyText, navigateNotes, notesLinks));
  body.append(renderedNotes);
  // Fetch only an explicitly requested next window; reject mixed revisions.
  if (result.content.nextOffset !== null) {
    let next = result.content.nextOffset;
    const readMore = async () => {
      more.disabled = true;
      try {
        const page = await feature.invoke("record", {
          id,
          offset: next,
          metadataView: "none",
          maxChars: 65536,
        });
        if (!live(n) || !body.isConnected) {
          return;
        }
        if (page.record?.hash !== r.hash) {
          throw new Error("Record changed; reopen it before reading more notes.");
        }
        // Reparse the accumulated source: comments, code fences and links
        // may span transport windows and must not become separate documents.
        notesText += page.record.body ?? "";
        notesLinks = [
          ...new Map(
            [...notesLinks, ...(page.links ?? [])].map((link) => [link.href, link]),
          ).values(),
        ];
        const rendered = foldTimeline(
          markdownView(withoutTitleHeading(notesText, r.title), navigateNotes, notesLinks),
        );
        renderedNotes.replaceWith(rendered);
        renderedNotes = rendered;
        if (page.content.nextOffset === null) {
          more.remove();
        } else {
          next = page.content.nextOffset;
          more.disabled = false;
        }
      } catch (error) {
        if (live(n)) {
          body.append(failure(error));
          more.disabled = false;
        }
      }
    };
    const more = button(
      "Read more notes",
      () => {
        void readMore();
      },
      "knowledge-quiet",
    );
    body.append(more);
  }
  // Long agent-written notes preview behind a disclosure so structured
  // sections (attendance, claims) stay near the top of the page.
  if (bodyText.length > longBodyChars) {
    const notes = el("details", undefined, "knowledge-notes-toggle"),
      summary = el("summary");
    notes.dataset.readingKey = `notes:${id}`;
    summary.append(disclosureLabel("Show full notes", "Show less"));
    notes.append(summary);
    body.dataset.clamped = "true";
    body.append(notes);
  }
  body.append(
    el(
      "span",
      `${r.writtenByAgentId ? `Saved by ${agentName(r.writtenByAgentId)}` : "Author not recorded"} · revision ${r.revision}${meta?.updated_at ? ` · updated ${date(meta.updated_at)}` : ""}`,
      "knowledge-summary-meta",
    ),
  );
  const identification = identificationDetails(
    meta?.identity?.context,
    meta?.attribution_confidence,
  );
  if (identification) {
    main.append(identification);
  }
  if (meta?.identity?.candidates?.length) {
    const candidates = el("section");
    candidates.append(el("h3", "Possible identity matches"));
    for (const candidate of meta.identity.candidates) {
      const match = result.references?.find((ref) => ref.id === candidate.id);
      const card = el("section", undefined, "knowledge-candidate knowledge-surface");
      card.append(
        button(
          `Possible match: ${match?.title ?? "Candidate identity"}`,
          () => open(candidate.id),
          "knowledge-quiet",
        ),
        el("p", candidate.basis),
        el(
          "p",
          `Both records stay separate unless ${agentName() ?? "your agent"} finds evidence they’re the same person.`,
          "knowledge-muted",
        ),
        button(
          `${askLabel()} to check`,
          () => ask(ui, r, false, { id: candidate.id, title: match?.title ?? candidate.id }),
          "knowledge-quiet",
        ),
      );
      for (const evidence of result.identityEvidence?.find((item) => item.id === candidate.id)
        ?.evidence ?? []) {
        if (evidence.verified) {
          card.append(
            evidenceView(
              feature,
              {
                ...result,
                evidence: [evidence],
                evidenceTotal: 1,
                evidenceSourceTotal: 1,
                nextEvidenceOffset: null,
              },
              () => live(n),
              errorText,
            ),
          );
        } else {
          card.append(
            el(
              "p",
              `Evidence: ${evidence.filename ?? evidence.path}${evidence.start_line ? ` · lines ${evidence.start_line}–${evidence.end_line ?? evidence.start_line}` : ""}. Open the record to inspect this citation.`,
              "knowledge-muted",
            ),
          );
        }
      }
      candidates.append(card);
    }
    main.append(candidates);
  }
  const merged = r.lifecycle === "merged";
  // A merged page's notes are history; keep them readable but out of the way.
  if (r.kind === "page" && merged) {
    const notes = el("details", undefined, "knowledge-merged-notes"),
      summary = el("summary");
    notes.dataset.readingKey = `merged-notes:${id}`;
    summary.append(disclosureLabel("Notes from before the merge", "Hide notes"));
    notes.append(summary, body);
    main.append(notes);
  } else if (r.kind === "page") {
    main.append(body);
  } else {
    const statement = el("section", undefined, "knowledge-statement"),
      surface = el("div", undefined, "knowledge-surface knowledge-claim-groups");
    if (r.kind !== "claim") {
      statement.append(el("h3", "Relationship & evidence"));
    }
    surface.append(
      renderClaim(
        ui,
        {
          record: r,
          truncated: result.content.nextOffset !== null,
          evidenceTotal: result.evidenceTotal,
          evidenceSourceTotal: result.evidenceSourceTotal,
        },
        n,
        undefined,
        result,
      ),
    );
    statement.append(surface);
    main.append(statement);
    if (versionsNode) {
      main.append(versionsNode);
    }
  }
  const attended = el("section", undefined, "knowledge-attended"),
    attendanceRows = el("div", undefined, "knowledge-surface");
  const attendanceIds = new Set<string>();
  if (r.type === "meeting") {
    attended.append(el("h3", "Attended"), attendanceRows);
    main.append(attended);
  }
  const knownFrom = el("span");
  if (r.type === "person") {
    facts.append(knownFrom);
  }
  const owned = el("section");
  owned.append(el("h3", `Commitments owned · owner only, not about ${r.title}`));
  const claims = el("section"),
    connections = el("section"),
    learned = el("section");
  if (r.kind === "page" && !merged) {
    claims.append(el("h3", `What ${agentName() ?? "your agent"} knows`));
    main.append(claims, owned);
    owned.hidden = true;
  }
  connections.append(el("h3", "Connections"));
  // Claims and connections naming a merged page resolve to the survivor, so they're listed there.
  if (merged) {
    const survivor = result.mergedInto,
      moved = el("p", "Connections now appear on ", "knowledge-muted");
    if (survivor) {
      moved.append(button(survivor.title, () => open(survivor.id), "knowledge-quiet"));
    } else {
      moved.append("the page this was merged into.");
    }
    connections.append(moved);
  }
  learned.append(el("h3", "Learned in"), el("p", "Conversation not recorded.", "knowledge-muted"));
  aside.append(connections, learned);
  const { files, filePanel, checkpointValue, historyList, technical } = fileDetails(ui, r, id, n);
  aside.append(files);
  /** Cited and uncited retained files for a page, inserted above `learned` in the aside. */
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
  if (r.kind === "page" && result.evidence?.length) {
    const originals = el("details", undefined, "knowledge-retained-originals");
    originals.append(
      el("summary", "Retained originals"),
      evidenceView(feature, result, () => live(n), errorText),
    );
    filePanel.append(originals);
  }
  grid.append(main, aside);
  detailTarget.replaceChildren(breadcrumb, head, grid);
  /** A claim's About rail: the pages it names, up to 20. */
  if (r.kind === "claim" && meta?.entities?.length) {
    const about = el("section", undefined, "knowledge-about"),
      targets = el("div", undefined, "knowledge-surface knowledge-connections");
    about.append(el("h3", "About"), targets);
    aside.prepend(about);
    const ids = [...new Set(meta.entities)].slice(0, 20);
    pending.push(
      Promise.all(
        ids.map(
          async (entityId) =>
            result.references?.find((ref) => ref.id === entityId) ??
            (await feature.invoke("record", { id: entityId, view: "summary" })).record,
        ),
      )
        .then((records) => {
          if (!live(n)) {
            return;
          }
          for (const record of records) {
            if (record) {
              const row = el("div", undefined, "knowledge-connection");
              row.append(summaryLink(ui, record));
              targets.append(row);
            }
          }
          if (!targets.children.length) {
            targets.append(el("p", "Linked records are unavailable.", "knowledge-aside-empty"));
          }
          if (meta.entities!.length > ids.length) {
            about.append(el("p", "Showing the first 20 linked entities.", "knowledge-muted"));
          }
        })
        .catch((error: unknown) => {
          if (live(n)) {
            targets.append(failure(error));
          }
        }),
    );
  }
  const refs = el("div", undefined, "knowledge-surface knowledge-connections");
  connections.append(refs);
  /** A relationship's From and To endpoints, resolved to page links as they load. */
  if (r.kind === "relationship") {
    for (const [role, endpointId] of [
      ["From", meta?.from],
      ["To", meta?.to],
    ] as const) {
      const row = el("div", undefined, "knowledge-connection"),
        copy = el("span", undefined, "knowledge-connection-copy");
      copy.append(el("small", role), el("span", endpointId ? "Loading…" : "Page not recorded."));
      row.append(copy);
      refs.append(row);
      if (!endpointId) {
        continue;
      }
      pending.push(
        (async () => {
          const target =
            result.references?.find((ref) => ref.id === endpointId) ??
            (await feature.invoke("record", { id: endpointId, view: "summary" })).record;
          if (!live(n)) {
            return;
          }
          copy.replaceChildren(el("small", role), el("span", target?.title ?? "Page unavailable."));
          if (target) {
            const destination = button("", () => open(target.id), "knowledge-connection-link");
            destination.append(tile(target.type, 24, target.kind), copy);
            row.replaceChildren(destination);
          }
        })().catch((error: unknown) => {
          if (live(n)) {
            copy.replaceChildren(el("small", role), el("span", "Page unavailable."));
            row.append(failure(error));
          }
        }),
      );
    }
  }
  await recordPanels(ui, {
    id,
    n,
    r,
    result,
    pages,
    waitForPanels,
    pending,
    claims,
    owned,
    connections,
    refs,
    attended,
    attendanceRows,
    attendanceIds,
    knownFrom,
    merged,
    technical,
    checkpointValue,
    historyList,
  });
}
