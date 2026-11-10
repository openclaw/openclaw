import { claimCard, summaryLink } from "./claim-view.js";
import { confidenceView } from "./knowledge-presentation.js";
import { loadingPlaceholder } from "./loading-view.js";
import type { Page } from "./page-context.js";
import {
  button,
  date,
  el,
  human,
  isFullSummary,
  label,
  tile,
  type Detail,
  type RecordDetail,
} from "./page-dom.js";
import { icon } from "./ui-icons.js";

// Plural group headings for built-in claim kinds; other kinds use their humanized label.
const CLAIM_GROUP_LABELS: Record<string, string> = {
  belief: "Beliefs",
  commitment: "Commitments",
  decision: "Decisions",
  preference: "Preferences",
  fact: "Facts",
  event: "Events",
};
/** Sections of an open record whose rows load after the primary content commits. */
export type RecordPanels = {
  id: string;
  n: number;
  r: RecordDetail;
  result: Detail;
  pages: number;
  waitForPanels: boolean;
  pending: Promise<unknown>[];
  claims: HTMLElement;
  owned: HTMLElement;
  connections: HTMLElement;
  refs: HTMLElement;
  attended: HTMLElement;
  attendanceRows: HTMLElement;
  attendanceIds: Set<string>;
  knownFrom: HTMLElement;
  merged: boolean;
  technical: HTMLElement;
  checkpointValue: HTMLElement;
  historyList: HTMLElement;
};

/** Page claims and connections independently, then record history; settle per `waitForPanels`. */
export async function recordPanels(ui: Page, view: RecordPanels) {
  const { s, feature, live, failure, agentName, open } = ui;
  const {
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
  } = view;
  const claimSurface = el("div", undefined, "knowledge-surface knowledge-claim-groups");
  claims.append(claimSurface);
  const connectionLoading = loadingPlaceholder("rows", "Loading connections…", 3);
  refs.append(connectionLoading);
  const claimsLoading = loadingPlaceholder("cards", "Loading saved claims…", 2);
  if (r.kind === "page" && !merged) {
    claimSurface.append(claimsLoading);
  }
  // Claims and rail connections page independently. A single mixed stream
  // let a page of claims crowd out every relationship, so a person with
  // many claims showed no attendance. Dependents are omitted: they repeat
  // the claims list and incoming relationships.
  const railDirections: Array<"outgoing" | "incoming" | "links" | "backlinks"> =
    r.kind === "page"
      ? ["outgoing", "incoming", "backlinks"]
      : ["outgoing", "incoming", "links", "backlinks"];
  let claimOffset: number | null = 0,
    railIndex = 0,
    railOffset = 0,
    snapshot: string | undefined;
  const claimGroups = new Map<string, HTMLElement>();
  const railMore = () => railIndex < railDirections.length,
    railIds = new Set<string>();
  const connectionsPage = async (
    direction: "claims" | (typeof railDirections)[number],
    offset: number,
  ) => {
    const page = await feature.invoke("connections", {
      id,
      view: "full",
      direction,
      offset,
      limit: 20,
      includeCards: direction === "claims",
      includeEndpoints: direction === "incoming" || direction === "outgoing",
    });
    if (live(n) && snapshot && snapshot !== page.snapshot) {
      throw new Error("Connections changed; reopen this page to refresh.");
    }
    snapshot = page.snapshot;
    return page;
  };
  async function moreClaims() {
    const page = await connectionsPage("claims", claimOffset ?? 0);
    if (!live(n)) {
      return;
    }
    claimsLoading.remove();
    for (const link of page.connections) {
      if (!isFullSummary(link.record)) {
        throw new Error("Full connection record required.");
      }
      const card = claimCard(ui, link.record, n, id);
      // A meeting's own event claim restates the meeting page and its
      // attendance, so it isn't listed here or on attendees' pages.
      if (
        !card ||
        link.record.sourceEvent ||
        (r.type === "meeting" && link.record.card?.source?.id !== id)
      ) {
        continue;
      }
      if (card.dataset.kind === "Owned commitments") {
        owned.hidden = false;
        owned.append(card);
        continue;
      }
      const kind = card.dataset.kind!;
      let group = claimGroups.get(kind);
      if (!group) {
        group = el("div", undefined, "knowledge-claim-group");
        group.append(el("h4", label(kind)));
        claimGroups.set(kind, group);
        claimSurface.append(group);
      }
      group.append(card);
      const count = group.querySelectorAll(".knowledge-claim").length;
      group.querySelector("h4")!.textContent =
        `${CLAIM_GROUP_LABELS[kind] ?? label(kind)} · ${count}`;
    }
    const count = claims.querySelectorAll(".knowledge-claim").length;
    claims
      .querySelector("h3")!
      .replaceChildren(
        document.createTextNode(`What ${agentName() ?? "your agent"} knows `),
        el(
          "span",
          `${count} ${count === 1 ? "claim" : "claims"}${page.nextOffset !== null ? " shown" : ""}`,
          "knowledge-section-count",
        ),
      );
    claimOffset = page.nextOffset;
    moreClaimsButton.remove();
    if (claimOffset !== null) {
      claims.append(moreClaimsButton);
    } else if (!claimGroups.size) {
      claimSurface.remove();
      claims.append(
        el(
          "p",
          `No claims about ${r.title}.${r.type === "person" && attendanceIds.size ? " Only attendance is recorded." : ""}`,
        ),
      );
    }
  }
  async function moreConnections() {
    // Fill one page of up to 20 rows, moving through directions in order.
    let shown = 0;
    while (shown < 20 && railMore()) {
      const page = await connectionsPage(railDirections[railIndex]!, railOffset);
      if (!live(n)) {
        return;
      }
      const endpoints = page.connections.map((link) => {
        const targetId =
          link.direction === "incoming"
            ? link.from
            : link.direction === "outgoing"
              ? link.to
              : undefined;
        return targetId ? (page.endpoints?.find((record) => record.id === targetId) ?? null) : null;
      });
      for (const [i, link] of page.connections.entries()) {
        const row = el("div", undefined, "knowledge-connection"),
          target = endpoints[i] ?? link.record;
        if (!isFullSummary(target)) {
          throw new Error("Full connection endpoint required.");
        }
        // A wikilink to a record already shown as a typed connection adds nothing.
        if (
          (link.direction === "links" || link.direction === "backlinks") &&
          (railIds.has(target.id) || attendanceIds.has(target.id))
        ) {
          continue;
        }
        railIds.add(target.id);
        if (
          link.label === "attended" &&
          ((r.type === "meeting" && link.to === id) || (r.type === "person" && link.from === id))
        ) {
          attendanceIds.add(target.id);
          if (r.type !== "person") {
            const attendee = el("div", undefined, "knowledge-attendee");
            attendee.append(
              summaryLink(ui, target),
              el("p", link.record.attributionConfidence?.basis ?? "No attribution basis recorded"),
              confidenceView(link.record.attributionConfidence, true),
            );
            attendanceRows.append(attendee);
            continue;
          }
        }
        const destination = button("", () => open(target.id), "knowledge-connection-link"),
          copy = el("span", undefined, "knowledge-connection-copy");
        copy.append(
          el(
            "small",
            `${link.direction === "incoming" ? "← " : ""}${label(link.label ?? link.direction)}`,
          ),
          el("span", target.title),
        );
        destination.append(tile(target.type, 24, target.kind), copy);
        row.append(destination);
        if (endpoints[i]) {
          copy
            .querySelector("small")!
            .append(confidenceView(link.record.attributionConfidence, true));
        }
        if (endpoints[i]) {
          const detail = button("", () => open(link.record.id), "knowledge-connection-evidence");
          detail.setAttribute("aria-label", "Relationship evidence");
          detail.title = "Relationship evidence";
          detail.append(icon("paperclip", 13));
          row.append(detail);
        }
        refs.append(row);
      }
      shown += page.connections.length;
      if (page.nextOffset !== null) {
        railOffset = page.nextOffset;
      } else {
        railIndex++;
        railOffset = 0;
      }
    }
    // Counts say "shown" only while more connections remain unloaded.
    const partial = railMore() ? " shown" : "";
    if (attendanceIds.size && r.type === "person") {
      knownFrom.textContent = `Known from ${attendanceIds.size} meeting${attendanceIds.size === 1 ? "" : "s"}${partial}`;
    }
    if (attendanceIds.size && r.type === "meeting") {
      attended.querySelector("h3")!.textContent =
        `Attended · ${attendanceIds.size} ${attendanceIds.size === 1 ? "person" : "people"}${partial} · from attendance connections`;
    }
    connectionLoading.remove();
    loadMore.remove();
    if (railMore()) {
      connections.append(loadMore);
    } else if (!refs.children.length) {
      refs.remove();
      connections.append(el("p", "No connections recorded.", "knowledge-muted"));
    }
  }
  const pageLoader =
    (loader: () => Promise<void>, control: () => HTMLButtonElement, section: HTMLElement) => () => {
      ++s.connectionPages;
      control().disabled = true;
      void loader()
        .catch((error: unknown) => {
          section.append(failure(error));
        })
        .finally(() => {
          control().disabled = false;
        });
    };
  const loadMore = button(
    "More connections",
    pageLoader(moreConnections, () => loadMore, connections),
  );
  const moreClaimsButton = button(
    "More claims",
    pageLoader(moreClaims, () => moreClaimsButton, claims),
    "knowledge-quiet",
  );
  // Each panel owns its failure and retry; a slow sibling keeps its placeholder.
  const readPanel = async (
    read: () => Promise<void>,
    placeholder: HTMLElement,
    section: HTMLElement,
    name: string,
  ) => {
    try {
      await read();
    } catch (error) {
      if (!live(n)) {
        return;
      }
      if (!section.contains(placeholder)) {
        section.append(placeholder);
      }
      placeholder.replaceChildren(
        failure(error),
        button(
          "Retry " + name,
          () => {
            placeholder.replaceChildren(
              loadingPlaceholder(name === "claims" ? "cards" : "rows", "Loading " + name + "…", 2),
            );
            void readPanel(read, placeholder, section, name);
          },
          "knowledge-quiet",
        ),
      );
    }
  };
  if (merged) {
    refs.remove();
  } else {
    pending.push(
      readPanel(
        async () => {
          for (let page = 0; page < pages; page++) {
            await moreConnections();
            if (!live(n) || !loadMore.parentElement) {
              break;
            }
          }
        },
        connectionLoading,
        refs,
        "connections",
      ),
    );
  }
  if (r.kind === "page" && !merged) {
    pending.push(
      readPanel(
        async () => {
          for (let page = 0; page < pages; page++) {
            await moreClaims();
            if (!live(n) || claimOffset === null) {
              break;
            }
          }
        },
        claimsLoading,
        claimSurface,
        "claims",
      ),
    );
  }
  if (result.references?.length) {
    const references = el("details");
    references.append(el("summary", "Record references · not asserted relationships"));
    for (const ref of result.references) {
      references.append(summaryLink(ui, ref));
    }
    if (result.nextReferenceOffset != null) {
      references.append(el("p", "Showing the first 20 references."));
    }
    technical.append(references);
  }
  pending.push(
    feature
      .invoke("history", { id, limit: 10 })
      .then((history) => {
        if (!live(n)) {
          return;
        }
        const checkpoint = history.mutations.find((m) => m.hash === r.hash)?.git;
        checkpointValue.textContent = checkpoint ? label(checkpoint.state) : "Not recorded";
        checkpointValue.title =
          checkpoint?.message ?? "No Git checkpoint recorded for this revision.";
        for (const entry of history.entries) {
          historyList.append(
            el("p", `Revision ${entry.revision} · ${date(entry.at)} · ${human(entry.provenance)}`),
          );
        }
        if (!history.entries.length) {
          historyList.append(el("p", "No saved history recorded."));
        }
        if (history.nextOffset !== null) {
          historyList.append(el("p", "Showing the latest 10 revisions."));
        }
      })
      .catch((error: unknown) => {
        if (live(n)) {
          checkpointValue.textContent = "Unavailable";
          historyList.append(failure(error));
        }
      }),
  );
  // Commit the primary content now. Secondary panels retain this view's
  // generation fence, so delayed responses cannot replace a newer page.
  const panels = Promise.all(pending).catch((error: unknown) => {
    if (live(n)) {
      connections.append(failure(error));
    }
  });
  // Background replacement needs the complete tree to preserve existing
  // expanded evidence, focus and scroll state. Only navigation streams it.
  if (waitForPanels) {
    await panels;
  }
}
