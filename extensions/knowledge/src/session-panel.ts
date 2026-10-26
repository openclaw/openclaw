import type { ControlUiHost, ControlUiPanel } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { browserContract } from "./browser-contract.js";
import { coalesceChanges } from "./change-refresh.js";
import type { contract } from "./contract.js";
import { markdownView } from "./markdown-view.js";
import type { ActivityOutput } from "./session-activity.js";
import { viewingClient } from "./store-view-client.js";
import { icon } from "./ui-icons.js";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string) => {
  const n = document.createElement(tag);
  if (text !== undefined) {
    n.textContent = text;
  }
  if (cls) {
    n.className = cls;
  }
  return n;
};
const button = (label: string, click: () => void) => {
  const n = el("button", label, "knowledge-button");
  n.type = "button";
  n.addEventListener("click", click);
  return n;
};
const operationLabel = (op: string, action: string) =>
  ({
    search: "Found",
    lookup: "Looked up",
    records: "Listed",
    record: "Read",
    connections: "Explored",
    save: "Saved",
    createClaim: "Added claim",
    createRelationship: "Added relationship",
    batch: "Published",
    correct: "Corrected",
    withdraw: "Withdrew",
    annotate: "Annotated",
    recall: "Updated recall",
  })[op] ?? (action === "write" ? "Changed" : "Read");

export function registerSessionPanel(host: ControlUiHost) {
  const panel: ControlUiPanel = {
    id: "session-activity",
    label: "Knowledge",
    mount(container, initialContext) {
      let context = initialContext;
      const root = el("section", undefined, "knowledge-page knowledge-session-panel");
      root.setAttribute("aria-label", "Knowledge session activity");
      const header = el("header", undefined, "knowledge-session-header"),
        heading = el("h2", "In this conversation");
      const controls = el("div", undefined, "knowledge-session-controls"),
        filters = el("div", undefined, "knowledge-session-filters");
      filters.setAttribute("role", "group");
      filters.setAttribute("aria-label", "Activity type");
      let activityFilter: "" | "read" | "write" = "",
        oldestFirst = false;
      const filterButtons = new Map<string, HTMLButtonElement>();
      for (const [value, label, glyph] of [
        ["", "All activity", "activity"],
        ["read", "Reads", "eye"],
        ["write", "Writes", "pencil"],
      ] as const) {
        const control = button("", () => {
          if (activityFilter === value) {
            return;
          }
          activityFilter = value;
          for (const [key, item] of filterButtons) {
            item.setAttribute("aria-pressed", String(key === value));
          }
          ++generation;
          ++previewGeneration;
          busy = false;
          rows = [];
          next = null;
          upper = undefined;
          detail.hidden = true;
          selected = "";
          render();
          void load();
        });
        control.className = "knowledge-session-control";
        control.title = label;
        control.setAttribute("aria-label", label);
        control.setAttribute("aria-pressed", String(value === activityFilter));
        control.append(icon(glyph, 15));
        filterButtons.set(value, control);
        filters.append(control);
      }
      const order = button("", () => {
        oldestFirst = !oldestFirst;
        renderOrder();
        render();
      });
      order.className = "knowledge-session-control";
      order.setAttribute("aria-label", "Oldest first");
      function renderOrder() {
        order.setAttribute("aria-pressed", String(oldestFirst));
        order.title = oldestFirst
          ? "Oldest first · Switch to newest first"
          : "Newest first · Switch to oldest first";
        order.replaceChildren(icon(oldestFirst ? "sortAscending" : "sortDescending", 16));
      }
      renderOrder();
      controls.append(filters, order);
      const status = el("p", "Loading activity…", "knowledge-session-muted");
      status.setAttribute("role", "status");
      const list = el("ol", undefined, "knowledge-session-list"),
        older = button("Load earlier activity", () => void load(true));
      older.hidden = true;
      const detail = el("section", undefined, "knowledge-session-preview");
      detail.hidden = true;
      header.append(heading, controls);
      root.append(header, status, detail, list, older);
      container.append(root);
      let disposed = false,
        generation = 0,
        previewGeneration = 0,
        identity = "",
        agent = "",
        sessionKey = "",
        sessionId = "",
        vault = "";
      let rows: ActivityOutput["items"] = [],
        upper: number | undefined,
        next: number | null = null,
        busy = false,
        selected = "";
      const client = viewingClient(
        createFeatureClient<typeof contract>(browserContract, host),
        () => ({
          agent,
        }),
      );
      const valid = (g: number) => !disposed && !context.signal.aborted && g === generation;
      function target() {
        const key = host.sessions.normalizeKey(context.props.sessionKey);
        const row = host.sessions.rows.find((r) => host.sessions.normalizeKey(r.key) === key);
        return {
          key,
          id: row?.sessionId ?? "",
          agent: context.props.agentId ?? row?.agentId ?? /^agent:([^:]+):/.exec(key)?.[1] ?? "",
        };
      }
      function sync() {
        const t = target(),
          id = JSON.stringify([t.key, t.id, t.agent]);
        if (id === identity) {
          return false;
        }
        identity = id;
        sessionKey = t.key;
        sessionId = t.id;
        agent = t.agent;
        ++generation;
        ++previewGeneration;
        busy = false;
        rows = [];
        upper = undefined;
        next = null;
        vault = "";
        selected = "";
        detail.hidden = true;
        detail.replaceChildren();
        list.replaceChildren();
        older.hidden = true;
        return true;
      }
      const pageTarget = (id: string) => ({ id: "overview", params: { agent, vault, record: id } });
      function render() {
        const display = oldestFirst ? [...rows].toReversed() : rows;
        list.replaceChildren();
        for (const row of display) {
          const item = el(
            "li",
            undefined,
            `knowledge-session-item knowledge-session-${row.action}`,
          );
          const card = button("", () => void preview(row.id));
          card.className = "knowledge-session-card";
          card.setAttribute("aria-label", row.title);
          const glyph = el("span", undefined, "knowledge-session-glyph knowledge-tile");
          glyph.append(
            icon(
              row.action === "write"
                ? "pencil"
                : ["search", "lookup", "records"].includes(row.operation)
                  ? "search"
                  : "eye",
              16,
            ),
          );
          const content = el("span", undefined, "knowledge-session-copy"),
            title = el("span", row.title, "knowledge-session-title");
          const meta = el("span", undefined, "knowledge-session-meta");
          const date = new Date(row.at),
            today = date.toDateString() === new Date().toDateString();
          const at = el(
            "time",
            date.toLocaleString(undefined, {
              ...(today ? {} : { month: "short" as const, day: "numeric" as const }),
              hour: "numeric",
              minute: "2-digit",
            }),
          );
          at.dateTime = row.at;
          at.title = date.toLocaleString();
          meta.append(
            el("span", operationLabel(row.operation, row.action), "knowledge-session-operation"),
            at,
          );
          const arrow = el("span", undefined, "knowledge-session-arrow");
          arrow.append(icon("chevronRight", 14));
          content.append(meta, title);
          card.append(glyph, content, arrow);
          item.append(card);
          list.append(item);
        }
        older.hidden = next === null;
        older.disabled = busy;
      }
      async function preview(id: string) {
        const p = ++previewGeneration,
          g = generation;
        selected = id;
        detail.hidden = false;
        detail.replaceChildren(el("p", "Loading record…"));
        try {
          const result = await client.invoke("record", {
            id,
            maxChars: 5000,
            includeMetadata: false,
            includeEvidence: false,
          });
          if (!valid(g) || p !== previewGeneration) {
            return;
          }
          detail.replaceChildren(
            button("Back to activity", () => {
              ++previewGeneration;
              selected = "";
              detail.hidden = true;
            }),
          );
          if (!result.record) {
            detail.append(el("p", "This record is no longer available."));
            return;
          }
          detail.append(el("h3", result.record.title));
          const full = el("a", "Open full page", "knowledge-session-full");
          full.href = host.navigation.pageHref(pageTarget(id));
          full.addEventListener("click", (e) => {
            if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
              return;
            }
            e.preventDefault();
            host.navigation.openPage(pageTarget(id));
          });
          detail.append(
            full,
            markdownView(result.record.body ?? "", (nextId) => void preview(nextId), result.links),
          );
          if (result.content.nextOffset !== null) {
            detail.append(
              el(
                "p",
                "Preview shortened. Open the full page for all notes and evidence.",
                "knowledge-session-muted",
              ),
            );
          }
        } catch (error) {
          if (valid(g) && p === previewGeneration) {
            detail.replaceChildren(
              el("p", host.redact(String(error)), "knowledge-error"),
              button("Back to activity", () => {
                selected = "";
                detail.hidden = true;
              }),
            );
          }
        }
      }
      async function load(olderRequested = false) {
        let more = olderRequested;
        sync();
        if (disposed || !context.presented || busy) {
          return;
        }
        if (!host.connection.connected) {
          status.textContent = "Disconnected. Reconnect to refresh activity.";
          return;
        }
        if (!sessionId || !agent) {
          status.textContent = "Session details are not available yet.";
          return;
        }
        const g = generation;
        busy = true;
        older.disabled = true;
        try {
          const scope = await client.invoke("status", {});
          if (!valid(g)) {
            return;
          }
          if (scope.store !== "ready") {
            rows = [];
            render();
            status.textContent = scope.message ?? "No Knowledge store is available for this agent.";
            return;
          }
          if (vault && vault !== scope.vault) {
            rows = [];
            upper = undefined;
            next = null;
            ++previewGeneration;
            detail.hidden = true;
            selected = "";
            more = false;
          }
          vault = scope.vault;
          const result = await client.invoke("session_activity", {
            sessionKey,
            sessionId,
            limit: 40,
            ...(activityFilter ? { filter: activityFilter } : {}),
            ...(more && next !== null ? { upper, before: next } : {}),
          });
          if (!valid(g)) {
            return;
          }
          rows = more ? [...rows, ...result.items] : result.items;
          upper = result.upper;
          next = result.nextBefore;
          status.textContent = rows.length ? "" : "No activity yet.";
          render();
        } catch (error) {
          if (valid(g)) {
            status.textContent = `Couldn’t refresh activity. ${host.redact(String(error))}`;
          }
        } finally {
          if (valid(g)) {
            busy = false;
            older.disabled = false;
          }
        }
      }
      let connected = host.connection.connected;
      const unsubscribe = host.subscribe(() => {
        const changed = sync(),
          reconnected = !connected && host.connection.connected;
        connected = host.connection.connected;
        if (changed || reconnected || !connected) {
          void load();
        }
      });
      // Do not collapse loaded history on every poll. Reopening returns to the newest window.
      const changes = coalesceChanges(
        () => {
          if (rows.length <= 40 && !selected) {
            void load();
          }
        },
        () => context.presented,
      );
      const poll = setInterval(() => {
        if (changes.active() && rows.length <= 40 && !selected) {
          void load();
        }
      }, 10000);
      const unwatch = client.on("changed", changes.changed);
      void load();
      return {
        update(nextContext) {
          const opened = !context.presented && nextContext.presented;
          context = nextContext;
          // Host render updates are not data invalidations (e.g. streaming chat).
          if (sync() || opened) {
            void load();
          }
        },
        dispose() {
          disposed = true;
          ++generation;
          ++previewGeneration;
          clearInterval(poll);
          changes.dispose();
          unsubscribe();
          unwatch();
          root.remove();
        },
      };
    },
  };
  return host.ui.registerPanel(panel);
}
