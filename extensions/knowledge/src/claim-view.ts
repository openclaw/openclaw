import { ask } from "./ask-dialog.js";
import { evidenceView } from "./evidence-view.js";
import { assertionOrigin as origin, identityTag } from "./knowledge-presentation.js";
import { loadingPlaceholder } from "./loading-view.js";
import { markdownView } from "./markdown-view.js";
import type { Page } from "./page-context.js";
import {
  button,
  chip,
  date,
  el,
  human,
  label,
  plainLinks,
  tile,
  type ClaimPresentation,
  type Detail,
  type Summary,
} from "./page-dom.js";
import { formatSourceDate } from "./temporal.js";
import { icon } from "./ui-icons.js";

// Full metadata is only for inspection, so it loads when its disclosure first opens.
export function metadataBlock(ui: Page, id: string, n: number) {
  const { feature, live, errorText } = ui;
  const block = el("details"),
    text = el("pre", "Loading…");
  block.append(el("summary", "Structured metadata"), text);
  block.addEventListener("toggle", () => {
    if (!block.open || block.dataset.loaded) {
      return;
    }
    block.dataset.loaded = "true";
    feature
      .invoke("record", { id, view: "summary", metadataView: "full" })
      .then((result) => {
        if (live(n)) {
          text.textContent =
            JSON.stringify(result.record?.metadata ?? null, null, 2) +
            (result.omitted?.includes("metadata.evidence")
              ? "\n\nEvidence descriptors omitted for size. View Markdown for the complete frontmatter."
              : "");
        }
      })
      .catch((error: unknown) => {
        if (live(n)) {
          text.textContent = errorText(error);
          delete block.dataset.loaded;
        }
      });
  });
  return block;
}
/** Compact link to a record: type tile, title, identity and lifecycle tags. */
export function summaryLink(ui: Page, r: Summary) {
  const { open } = ui;
  const b = button("", () => open(r.id), "knowledge-record-link");
  b.title = r.title;
  b.append(el("span", r.title, "knowledge-record-title"));
  b.prepend(tile(r.type, 24, r.kind));
  b.append(identityTag(r.identityStatus));
  if (r.lifecycle !== "active") {
    b.append(chip(human(r.lifecycle)));
  }
  return b;
}
/** Claim card for a listed claim summary, or undefined when the summary has no card. */
export function claimCard(ui: Page, r: Summary, n: number, aboutId?: string) {
  if (!r.card) {
    return undefined;
  }
  return renderClaim(
    ui,
    {
      record: { ...r, ...r.card },
      truncated: r.card.truncated,
      evidenceTotal: r.card.evidenceTotal,
      evidenceSourceTotal: r.card.evidenceSourceTotal,
    },
    n,
    aboutId,
  );
}
/** One claim with its attribution, provenance and lazily loaded evidence. */
export function renderClaim(
  ui: Page,
  result: ClaimPresentation,
  n: number,
  aboutId?: string,
  detail?: Detail,
) {
  const { s, feature, evidenceLoaders, live, errorText, failure, agentName, open } = ui;
  const standalone = Boolean(detail);
  const record = result.record!,
    card = el(
      "article",
      undefined,
      `knowledge-claim${standalone ? " knowledge-claim-standalone" : ""}`,
    );
  card.dataset.kind =
    aboutId && !record.metadata?.entities?.includes(aboutId) && record.metadata?.owner === aboutId
      ? "Owned commitments"
      : (record.claimKind ?? record.kind);
  card.dataset.readingKey = `claim:${record.id}`;
  card.dataset.preserveSignature = JSON.stringify([
    record.hash,
    record.valid,
    record.owner,
    record.source,
    record.writtenByAgentId ? agentName(record.writtenByAgentId) : undefined,
  ]);
  const row = el("div", undefined, "knowledge-claim-row"),
    copy = el("div", undefined, "knowledge-claim-copy");
  const statement = standalone
    ? markdownView(record.body || record.title, open, detail?.links)
    : undefined;
  if (statement) {
    statement.classList.add("knowledge-claim-text");
  }
  copy.append(
    statement ??
      (record.metadata?.source_event && record.source
        ? button(
            `Meeting: ${record.source.title}`,
            () => open(record.source!.id),
            "knowledge-claim-text",
          )
        : button(
            plainLinks(record.body || record.title),
            () => open(record.id),
            "knowledge-claim-text",
          )),
  );
  const metadata = el("div", undefined, "knowledge-claim-meta");
  const assertionOrigin = el(
    "span",
    origin(
      record.assertionOrigin,
      record.attribution,
      record.writtenByAgentId ? agentName(record.writtenByAgentId) : undefined,
    ),
    `knowledge-origin knowledge-origin-${record.assertionOrigin ?? "unknown"}`,
  );
  assertionOrigin.prepend(
    icon(
      record.assertionOrigin === "source"
        ? "paperclip"
        : record.assertionOrigin === "user_belief"
          ? "circleUser"
          : record.assertionOrigin === "agent_inference"
            ? "brain"
            : "info",
      12,
    ),
  );
  if (record.metadata?.supersedes) {
    const corrected = el("span", "Corrected", "knowledge-state-note");
    corrected.prepend(icon("repeat", 12));
    metadata.append(corrected);
  }
  if (record.metadata?.continuity?.length) {
    metadata.append(
      el(
        "span",
        record.metadata.continuity.some((link) => link.relation === "contradicts")
          ? "Conflicting account"
          : "Reaffirmed",
      ),
    );
  }
  // "From source" is the norm, so compact rows show only notable origins;
  // the expanded details still state it.
  const originInMeta = standalone || record.assertionOrigin !== "source";
  metadata.append(
    el("span", label(record.kind === "relationship" ? record.type : (record.claimKind ?? "claim"))),
  );
  if (originInMeta) {
    metadata.append(assertionOrigin);
  }
  if (record.owner) {
    const owner = el("span", "Owner ");
    owner.append(button(record.owner.title, () => open(record.owner!.id), "knowledge-inline-link"));
    metadata.append(owner);
  } else if (record.claimKind === "commitment") {
    metadata.append(el("span", "Owner not identified"));
  }

  if (
    record.about?.length &&
    !(record.metadata?.entities?.length === 1 && record.metadata.entities[0] === aboutId)
  ) {
    const about = el("span", "About ", "knowledge-claim-about");
    for (const entity of record.about) {
      about.append(button(entity.title, () => open(entity.id), "knowledge-inline-link"));
    }
    metadata.append(about);
  }
  copy.append(metadata);
  if (result.truncated) {
    copy.append(el("small", "Excerpt — open claim for the complete text."));
  }
  row.append(
    tile(
      record.kind === "relationship" ? record.type : (record.claimKind ?? "claim"),
      28,
      record.kind,
    ),
    copy,
  );
  card.append(row);
  const evidence = el("details", undefined, "knowledge-claim-evidence"),
    disclosure = el("summary");
  disclosure.append(
    el(
      "span",
      `Evidence · ${result.evidenceSourceTotal ?? "?"} ${result.evidenceSourceTotal === 1 ? "file" : "files"} · ${result.evidenceTotal ?? 0} ${result.evidenceTotal === 1 ? "citation" : "citations"}`,
      "knowledge-sr-only",
    ),
    icon("chevronDown", 14),
  );
  disclosure.title = "Show evidence and correction options";
  evidence.open = standalone;
  evidence.append(disclosure);
  const evidenceBody = el("div");
  evidence.append(evidenceBody);
  const alive = () =>
    !s.disposed &&
    !s.context.signal.aborted &&
    s.context.host.connection.connected &&
    (card.isConnected || (live(n) && Boolean(s.staging?.contains(card))));
  const showEvidence = (loaded: Detail) => {
    evidenceBody.replaceChildren();
    const details = el("dl", undefined, "knowledge-claim-details"),
      m = loaded.record?.metadata;
    const field = (name: string, value: string | HTMLElement) => {
      const dd = el("dd");
      dd.append(value);
      details.append(el("dt", name), dd);
    };
    if (record.claimKind === "commitment") {
      field(
        "Owner",
        record.owner
          ? button(record.owner.title, () => open(record.owner!.id), "knowledge-inline-link")
          : "Owner not identified",
      );
      field("Deadline", m?.due_at ? formatSourceDate(m.due_at) : "No deadline recorded");
    }
    field(
      "Source",
      record.source
        ? button(record.source.title, () => open(record.source!.id), "knowledge-inline-link")
        : record.assertionOrigin === "user_belief"
          ? "Conversation not recorded"
          : "Source page not recorded",
    );
    const about = el("span", undefined, "knowledge-claim-about");
    for (const id of m?.entities ?? []) {
      const ref = loaded.references?.find((candidate) => candidate.id === id);
      about.append(button(ref?.title ?? id, () => open(id), "knowledge-inline-link"));
    }
    if (about.childNodes.length) {
      field("About", about);
    }
    if (!originInMeta) {
      field("Origin", origin(record.assertionOrigin, record.attribution));
    }
    field(
      "Saved",
      `${record.recordedAt ? date(record.recordedAt) : "Time not recorded"} · revision ${record.revision}`,
    );
    evidenceBody.append(details);
    if (record.assertionOrigin === "agent_inference") {
      evidenceBody.append(
        el("p", "No direct quote for this inference. Premises below.", "knowledge-notice"),
      );
    }
    const correct = button(
      "Correct in chat",
      () => ask(ui, record, true),
      "knowledge-quiet knowledge-correct",
    );
    correct.prepend(icon("pencil", 16));
    const openClaim = standalone
      ? undefined
      : button("Open claim", () => open(record.id), "knowledge-quiet");
    openClaim?.prepend(icon("fileText", 16));
    if (
      loaded.evidence?.some((e) => !e.verified) &&
      !metadata.querySelector(".knowledge-unverified")
    ) {
      metadata.append(el("span", "Source file unavailable", "knowledge-unverified"));
    }
    if (loaded.evidence?.length) {
      evidenceBody.append(
        evidenceView(
          feature,
          loaded,
          alive,
          errorText,
          undefined,
          record.lifecycle === "active" ? correct : undefined,
          openClaim,
        ),
      );
    } else {
      if (record.attribution) {
        evidenceBody.append(el("p", record.attribution, "knowledge-attribution"));
      }
      evidenceBody.append(el("p", "No source evidence recorded."));
      const actions = el("div", undefined, "knowledge-evidence-actions");
      if (openClaim) {
        actions.append(openClaim);
      }
      if (record.lifecycle === "active") {
        actions.append(correct);
      }
      if (actions.childNodes.length) {
        evidenceBody.append(actions);
      }
    }
    if (loaded.relatedStatements?.length) {
      const related = el("section", undefined, "knowledge-related");
      related.append(el("h4", "Related statements"));
      for (const link of loaded.relatedStatements) {
        const relatedRow = el("div", undefined, "knowledge-related-row");
        const verb =
          link.relation === "contradicts"
            ? "Conflicts with"
            : link.relation === "updates"
              ? link.incoming
                ? "Updated by"
                : "Updates"
              : link.incoming
                ? "Reaffirmed by"
                : "Reaffirms";
        relatedRow.append(
          el("strong", verb),
          button(link.text || link.record.title, () => open(link.record.id), "knowledge-quiet"),
          el(
            "small",
            origin(
              link.assertionOrigin,
              link.attribution,
              link.record.writtenByAgentId ? agentName(link.record.writtenByAgentId) : undefined,
            ),
          ),
          el("p", `${link.basis}${link.source ? ` From ${link.source.title}.` : ""}`),
        );
        related.append(relatedRow);
      }
      evidenceBody.append(related);
    }
  };
  let loaded = Boolean(detail),
    loading = false;
  if (detail) {
    showEvidence(detail);
  }
  const loadEvidence = async () => {
    if (loaded || loading || !alive()) {
      return;
    }
    loading = true;
    evidenceBody.replaceChildren(loadingPlaceholder("cards", "Loading evidence…", 1));
    try {
      const fetched = await feature.invoke("record", {
        id: record.id,
        view: "summary",
        includeEvidence: true,
        includeMetadata: true,
        includeReferences: true,
      });
      if (!alive()) {
        return;
      }
      if (!fetched.record || fetched.record.hash !== record.hash) {
        throw new Error("Claim changed or is unavailable; reopen it to refresh evidence.");
      }
      showEvidence(fetched);
      loaded = true;
    } catch (error) {
      if (alive()) {
        evidenceBody.replaceChildren(
          failure(error),
          button(
            "Retry evidence",
            () => {
              void loadEvidence();
            },
            "knowledge-quiet",
          ),
        );
      }
    } finally {
      loading = false;
    }
  };
  evidenceLoaders.set(evidence, loadEvidence);
  evidence.addEventListener("toggle", () => {
    if (evidence.open) {
      void loadEvidence();
    }
  });
  card.append(evidence);
  return card;
}
