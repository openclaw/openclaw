import { claimCard, summaryLink } from "./claim-view.js";
import { t } from "./i18n/index.js";
import { confidenceView, identityTag } from "./knowledge-presentation.js";
import type { Page } from "./page-context.js";
import { button, disclosureLabel, el, label, tile, time, type Summary } from "./page-dom.js";
import { formatSourceDate } from "./temporal.js";
import { icon } from "./ui-icons.js";

/** Recent activity feed, grouped by source, with cursor paging. */
export async function recent(ui: Page, n: number, target: HTMLElement) {
  const { s, feature, recentBack, recentExpanded, live, failure, empty, open, load } = ui;
  const activity = await feature.invoke("recent", {
    limit: 20,
    groupBySource: true,
    includeEndpoints: true,
    ...s.recentCursor,
  });
  if (!live(n)) {
    return;
  }
  if (!s.recentCursor) {
    s.recentSequence = activity.upperSequence;
  }
  const feed = el("div", undefined, "knowledge-feed");
  let currentDay = "",
    group: HTMLElement | undefined,
    lifecycleGroup: HTMLElement | undefined;
  let firstSource = true;
  // Each day orders its cards: corrections, source groups, then saves
  // with no source page ("Edited outside OpenClaw", "Saved in conversation").
  let sourceGroups: HTMLElement | undefined;
  const looseGroups = new Map<string, HTMLElement>();
  const looseGroup = (heading: string) => {
    let section = looseGroups.get(heading);
    if (!section) {
      section = el("section", undefined, "knowledge-loose-group");
      section.append(el("h3", heading, "knowledge-group-heading"));
      looseGroups.set(heading, section);
      group!.append(section);
    }
    return section;
  };
  // A loose save of a page that also heads a source group on this page is
  // shown as that group's source row instead of a second row.
  const sourceMarkers = new Map<string, (status: string) => void>(),
    looseSaves: Array<{ id: string; row: HTMLElement; status: string }> = [];
  for (const entry of activity.items) {
    const day = new Date(entry.at).toLocaleDateString(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    if (day !== currentDay) {
      currentDay = day;
      const zone =
        new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
          .formatToParts(new Date(entry.at))
          .find((p) => p.type === "timeZoneName")?.value ?? t("knowledge.recent.localTime");
      feed.append(
        el(
          "h2",
          t(
            new Date(entry.at).toDateString() === new Date().toDateString()
              ? "knowledge.recent.dayToday"
              : "knowledge.recent.day",
            { day, zone },
          ),
          "knowledge-eyebrow",
        ),
      );
      lifecycleGroup = undefined;
      group = el("section", undefined, "knowledge-day");
      feed.append(group);
      sourceGroups = el("div", undefined, "knowledge-source-groups");
      group.append(sourceGroups);
      looseGroups.clear();
    }
    const lifecycle = entry.change === "corrected" || entry.change === "withdrawn";
    const row = el("article", undefined, "knowledge-feed-item");
    row.dataset.change = entry.change;
    row.dataset.readingKey = `activity:${entry.sequence}`;
    const copy = el("span", undefined, "knowledge-feed-copy");
    const kindLabel =
      entry.kind === "relationship" ? t("knowledge.recent.connection") : label(entry.type);
    const savedTime = time(entry.at);
    const badgeLabel = t(`knowledge.recent.changes.${entry.change}`);
    copy.append(
      el("span", entry.title || `${kindLabel} ${entry.change}`, "knowledge-feed-title"),
      identityTag(entry.identityStatus),
    );
    const description =
      entry.change === "corrected" || entry.change === "withdrawn" || entry.change === "external"
        ? `${kindLabel} · ${badgeLabel}`
        : kindLabel;
    copy.append(
      el(
        "span",
        t("knowledge.recent.savedAt", { description, time: savedTime }),
        "knowledge-feed-meta",
      ),
    );
    if (entry.group) {
      row.classList.add("knowledge-source-activity");
      const source = entry.group.source,
        key = `source:${source.id}`;
      const disclosure = el("details", undefined, "knowledge-activity-details");
      disclosure.dataset.readingKey = key;
      disclosure.open =
        recentExpanded.has(key) || (firstSource && !s.recentCursor && !recentExpanded.size);
      firstSource = false;
      disclosure.addEventListener("toggle", () => {
        if (disclosure.isConnected) {
          if (disclosure.open) {
            recentExpanded.add(key);
          } else {
            recentExpanded.delete(key);
          }
        }
      });
      const summary = el("summary", undefined, "knowledge-activity-summary"),
        text = el("span", undefined, "knowledge-feed-copy");
      text.append(el("span", source.title, "knowledge-feed-title"));
      const metadata = el("span", undefined, "knowledge-source-meta");
      if (source.occurredAt) {
        const occurred = el("span");
        occurred.append(
          icon("calendarClock", 12),
          el("span", t("knowledge.common.occurred", { date: formatSourceDate(source.occurredAt) })),
        );
        metadata.append(occurred);
      }
      metadata.append(
        el(
          "span",
          t(
            entry.group.total === 1
              ? "knowledge.recent.groupSavedOne"
              : "knowledge.recent.groupSaved",
            {
              time:
                entry.group.firstSaved &&
                entry.group.lastSaved &&
                time(entry.group.firstSaved) !== time(entry.group.lastSaved)
                  ? `${time(entry.group.firstSaved)}–${time(entry.group.lastSaved)}`
                  : savedTime,
              count: String(entry.group.total),
            },
          ),
        ),
      );
      text.append(metadata);
      const names = [
        "attendees",
        "decision",
        "commitment",
        "event",
        "belief",
        "fact",
        "preference",
        "page",
      ];
      text.append(
        el(
          "span",
          names
            .filter((kind) => entry.group!.counts[kind])
            .map((kind) =>
              t(
                `knowledge.recent.counts.${kind}.${entry.group!.counts[kind] === 1 ? "one" : "other"}`,
                { count: String(entry.group!.counts[kind]) },
              ),
            )
            .concat(entry.group.counts.sourceEvent ? [t("knowledge.recent.meetingEvent")] : [])
            .join(" · "),
          "knowledge-feed-meta",
        ),
      );
      summary.append(
        tile(source.type, 32),
        text,
        disclosureLabel(t("knowledge.common.expand"), t("knowledge.common.collapse")),
      );
      const detail = el("div", undefined, "knowledge-source-body");
      const pages = el("div", undefined, "knowledge-source-pages"),
        claims = el("div", undefined, "knowledge-source-claims");
      detail.append(pages, claims);
      const saveRow = (
        record: Pick<Summary, "id" | "title" | "type" | "kind" | "identityStatus" | "occurredAt">,
        status?: string,
      ) => {
        const recordRow = button("", () => open(record.id), "knowledge-source-record"),
          recordCopy = el("span", undefined, "knowledge-feed-copy"),
          title = el("span", undefined, "knowledge-source-title"),
          meta = el("span", undefined, "knowledge-source-meta");
        title.append(
          el("span", record.title, "knowledge-feed-title"),
          identityTag(record.identityStatus),
        );
        if (status) {
          const change = el("span", undefined, "knowledge-save-status");
          change.dataset.change = status;
          change.append(
            icon(status === "created" ? "plus" : status === "updated" ? "pencil" : "eye", 12),
            el("span", t(`knowledge.recent.changes.${status}`)),
          );
          meta.append(change);
        }
        meta.append(el("span", label(record.type)));
        if (record.occurredAt) {
          const occurred = el("span");
          occurred.append(
            icon("calendarClock", 12),
            el(
              "span",
              /^\d{4}-\d{2}-\d{2}$/.test(record.occurredAt)
                ? t("knowledge.common.dateOnly", { date: formatSourceDate(record.occurredAt) })
                : formatSourceDate(record.occurredAt),
            ),
          );
          meta.append(occurred);
        }
        recordCopy.append(title, meta);
        recordRow.append(tile(record.type, 28, record.kind), recordCopy, icon("chevronRight", 14));
        return recordRow;
      };
      // Keep the source reachable even when its save is outside this activity page.
      let sourceRow = saveRow(source);
      pages.append(sourceRow);
      let sourceMarked = false;
      sourceMarkers.set(source.id, (status) => {
        if (sourceMarked) {
          return;
        }
        const marked = saveRow(source, status);
        sourceRow.replaceWith(marked);
        sourceRow = marked;
        sourceMarked = true;
      });
      const attendance = el("details", undefined, "knowledge-attendance-group");
      attendance.dataset.readingKey = `${key}:attendance`;
      const attendanceSummary = el("summary"),
        attendanceCopy = el("span", undefined, "knowledge-feed-copy"),
        attendanceTitle = el(
          "span",
          t("knowledge.recent.counts.attendees.other", {
            count: String(entry.group.counts.attendees ?? 0),
          }),
          "knowledge-feed-title",
        ),
        attendanceRows = el("div", undefined, "knowledge-attendance-rows knowledge-surface");
      attendanceCopy.append(
        attendanceTitle,
        el(
          "span",
          t("knowledge.recent.attendanceMeta", {
            count: String(entry.group.counts.attendees ?? 0),
          }),
          "knowledge-feed-meta",
        ),
      );
      attendanceSummary.append(
        tile("attended", 28, "relationship"),
        attendanceCopy,
        disclosureLabel(t("knowledge.common.showAll"), t("knowledge.common.hide")),
      );
      attendance.append(attendanceSummary, attendanceRows);
      const namesSeen: string[] = [];
      let attendanceShown = false;
      const appendRecords = (
        records: typeof entry.group.records,
        endpoints = entry.group!.endpoints ?? [],
      ) => {
        for (const record of [...records].toSorted(
          (a, b) =>
            ["page", "relationship", "claim"].indexOf(a.kind) -
            ["page", "relationship", "claim"].indexOf(b.kind),
        )) {
          if (record.sourceEvent) {
            continue;
          }
          if (
            record.kind === "relationship" &&
            record.label === "attended" &&
            record.to === source.id
          ) {
            if (!attendanceShown) {
              detail.insertBefore(attendance, claims);
              attendanceShown = true;
            }
            const person = endpoints.find((endpoint) => endpoint.id === record.from);
            if (!live(n)) {
              return;
            }
            const attendee = el("div", undefined, "knowledge-attendee");
            if (person) {
              attendee.append(summaryLink(ui, person));
              namesSeen.push(person.title);
            } else {
              attendee.append(el("span", t("knowledge.recent.personUnavailable")));
            }
            attendee.append(
              el(
                "p",
                record.attributionConfidence?.basis ?? t("knowledge.common.noAttributionBasis"),
              ),
              confidenceView(record.attributionConfidence, true),
            );
            attendanceRows.append(attendee);
            attendanceTitle.textContent =
              (entry.group!.counts.attendees ?? 0) > namesSeen.slice(0, 3).length
                ? t("knowledge.recent.attendedMore", {
                    names: namesSeen.slice(0, 3).join(", "),
                    count: String(entry.group!.counts.attendees! - namesSeen.slice(0, 3).length),
                  })
                : t("knowledge.recent.attended", { names: namesSeen.slice(0, 3).join(", ") });
          } else if (record.kind === "claim") {
            const card = claimCard(ui, record, n);
            claims.append(card ?? saveRow(record));
          } else {
            const saved = saveRow(
              record,
              record.change === "created"
                ? "created"
                : record.change === "updated"
                  ? "updated"
                  : "observed",
            );
            if (record.id === source.id) {
              sourceRow.replaceWith(saved);
              sourceRow = saved;
              sourceMarked = true;
            } else {
              pages.append(saved);
            }
          }
        }
      };
      appendRecords(entry.group.records);
      let recordOffset = entry.group.nextRecordOffset;
      if (recordOffset != null) {
        const more = button(
          t("knowledge.recent.loadMore", { count: String(entry.group.total - recordOffset) }),
          () => {
            more.disabled = true;
            void (async () => {
              const page = await feature.invoke("recent", {
                groupBySource: true,
                includeEndpoints: true,
                sourceId: source.id,
                recordOffset: recordOffset!,
                upperSequence: activity.upperSequence,
              });
              if (!live(n)) {
                return;
              }
              const next = page.items.find((item) => item.group?.source.id === source.id)?.group;
              if (!next) {
                throw new Error(t("knowledge.recent.sourceChanged"));
              }
              appendRecords(next.records, next.endpoints);
              recordOffset = next.nextRecordOffset;
              if (recordOffset == null) {
                more.remove();
              } else {
                more.textContent = t("knowledge.recent.loadMore", {
                  count: String(next.total - recordOffset),
                });
                detail.append(more);
              }
            })()
              .catch((error: unknown) => detail.append(failure(error)))
              .finally(() => {
                more.disabled = false;
              });
          },
          "knowledge-quiet",
        );
        detail.append(more);
      }
      disclosure.append(summary, detail);
      row.append(disclosure);
    } else if (lifecycle) {
      row.classList.add("knowledge-activity-event");
      const disclosure = el("details", undefined, "knowledge-activity-details"),
        summary = el("summary", undefined, "knowledge-activity-summary");
      disclosure.open = recentExpanded.has(entry.sequence);
      disclosure.addEventListener("toggle", () => {
        if (disclosure.isConnected) {
          if (disclosure.open) {
            recentExpanded.add(entry.sequence);
          } else {
            recentExpanded.delete(entry.sequence);
          }
        }
      });
      const meta = copy.querySelector(".knowledge-feed-meta")!,
        state = el("span", badgeLabel, "knowledge-lifecycle-state");
      state.dataset.change = entry.change;
      state.prepend(icon(entry.change === "corrected" ? "repeat" : "archive", 12));
      meta.classList.add("knowledge-source-meta");
      meta.replaceChildren(state, el("span", kindLabel), el("span", savedTime));
      const lifecycleIcon = icon(entry.change === "corrected" ? "repeat" : "archive", 20);
      lifecycleIcon.dataset.change = entry.change;
      summary.append(lifecycleIcon, copy, icon("chevronDown", 14));
      const detail = el("div", undefined, "knowledge-activity-body");
      const explanation =
        entry.change === "withdrawn"
          ? t("knowledge.recent.withdrawnBody")
          : entry.replacementActive
            ? t("knowledge.recent.replacedBody")
            : t("knowledge.recent.staleCorrectionBody");
      detail.append(el("p", explanation, "knowledge-activity-reason"));
      const links = el("div", undefined, "knowledge-activity-links");
      if (entry.replacementId) {
        links.append(
          button(
            t(
              entry.replacementActive
                ? "knowledge.recent.currentVersion"
                : "knowledge.recent.replacementHistory",
            ),
            () => open(entry.replacementId!),
          ),
        );
      }
      links.append(
        button(t("knowledge.recent.viewInHistory"), () => open(entry.id), "knowledge-quiet"),
      );
      detail.append(links);
      disclosure.append(summary, detail);
      row.append(disclosure);
      if (entry.reason) {
        const reason = el("details", undefined, "knowledge-activity-audit");
        reason.append(
          el("summary", t("knowledge.recent.reason")),
          el("p", entry.reason, "knowledge-activity-reason"),
        );
        detail.append(reason);
      }
    } else {
      const item = button("", () => open(entry.id), "knowledge-feed-link");
      const meta = copy.querySelector(".knowledge-feed-meta")!,
        change = el("span", undefined, "knowledge-save-status");
      change.dataset.change = entry.change;
      change.append(
        icon(
          entry.change === "created"
            ? "plus"
            : entry.change === "updated" || entry.change === "external"
              ? "pencil"
              : "eye",
          12,
        ),
        el("span", badgeLabel),
      );
      meta.classList.add("knowledge-source-meta");
      meta.replaceChildren(
        change,
        el("span", t("knowledge.recent.savedAt", { description: kindLabel, time: savedTime })),
      );
      item.append(tile(entry.type, 28, entry.kind), copy, icon("chevronRight", 14));
      row.append(item);
    }
    if (lifecycle) {
      if (!lifecycleGroup) {
        lifecycleGroup = el("section", undefined, "knowledge-lifecycle-group");
        lifecycleGroup.append(
          el("h3", t("knowledge.recent.lifecycleGroup"), "knowledge-group-heading"),
        );
        group!.prepend(lifecycleGroup);
      }
      lifecycleGroup.append(row);
      lifecycleGroup.querySelector("h3")!.textContent = t("knowledge.recent.lifecycleGroupCount", {
        count: String(lifecycleGroup.querySelectorAll("article").length),
      });
    } else if (entry.group) {
      sourceGroups!.append(row);
    } else {
      looseGroup(
        t(
          entry.change === "external"
            ? "knowledge.recent.changes.external"
            : "knowledge.recent.savedInSession",
        ),
      ).append(row);
      looseSaves.push({ id: entry.id, row, status: entry.change });
    }
  }
  for (const save of looseSaves) {
    const mark = sourceMarkers.get(save.id);
    if (!mark) {
      continue;
    }
    mark(save.status);
    const section = save.row.parentElement;
    save.row.remove();
    if (section && !section.querySelector("article")) {
      section.remove();
    }
  }
  if (!activity.items.length) {
    feed.append(empty(t("knowledge.recent.emptyTitle"), t("knowledge.recent.emptyBody")));
  }
  const pages = el("div", undefined, "knowledge-pagination");
  if (s.recentCursor) {
    pages.append(
      button(t(recentBack.length ? "knowledge.recent.newer" : "knowledge.recent.latest"), () => {
        s.recentCursor = recentBack.pop();
        void load();
      }),
    );
  }
  if (activity.nextBefore !== null) {
    pages.append(
      button(t("knowledge.recent.older"), () => {
        recentBack.push(s.recentCursor);
        s.recentCursor = {
          upperSequence: activity.upperSequence,
          beforeSequence: activity.nextBefore!,
        };
        void load();
      }),
    );
  }
  feed.append(pages);
  target.replaceChildren(feed);
}
