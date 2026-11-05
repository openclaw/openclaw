import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { button, el } from "./page-dom.js";
import {
  accessText,
  andList,
  recordsText,
  storeIcon,
  storeLabel,
  storeOf,
  type Names,
  type Snapshot,
} from "./store-entries.js";
import type { StoreChange, StoreEntry } from "./stores-contract.js";
import { icon, type IconName } from "./ui-icons.js";

export { accessText, storeLabel, storeOf, type Names } from "./store-entries.js";

/** Agent viewing selector and the viewed agent's store context (spec §8.1).
 * Selecting an agent only changes what is viewed. */
export function storeBar(
  snapshot: Snapshot,
  viewing: string,
  names: Names,
  select: (agent: string) => void,
  openSettings: () => void,
) {
  const bar = el("div", undefined, "knowledge-store-bar");
  const pick = el("label", undefined, "knowledge-agent-select");
  pick.append(el("span", "Agent"));
  const wrap = el("span", undefined, "knowledge-select"),
    menu = el("select");
  for (const agent of snapshot.agents) {
    const option = el("option", names(agent.id));
    option.value = agent.id;
    option.selected = agent.id === viewing;
    menu.append(option);
  }
  menu.addEventListener("change", () => select(menu.value));
  wrap.append(menu, icon("chevronDown", 13));
  pick.append(wrap);
  const entry = storeOf(snapshot, viewing);
  const context = button("", openSettings, "knowledge-store-context");
  context.title = "Stores & sharing";
  if (entry) {
    context.append(
      icon(storeIcon(entry), 14),
      el("strong", storeLabel(entry, names)),
      el("span", `· ${accessText(entry, viewing, names)}`),
    );
  } else {
    context.append(icon("alertTriangle", 14), el("span", "Store assignment needs attention"));
  }
  bar.append(pick, context);
  return bar;
}

/** Reading-view placeholder for a store that is not ready to read. */
export function storeNotice(
  entry: StoreEntry | undefined,
  state: string,
  message: string | undefined,
  agentName: string,
  names: Names,
  openSettings: () => void,
  retry: () => void,
) {
  const panel = el("div", undefined, "knowledge-empty knowledge-store-notice");
  const label = entry ? storeLabel(entry, names) : `${agentName}’s store`;
  if (state === "unprovisioned") {
    panel.append(
      el("h2", `${label} doesn’t exist yet`),
      el(
        "p",
        `It’s created the first time ${agentName} uses knowledge. Viewing it here doesn’t create it.`,
      ),
    );
  } else if (state === "initializing") {
    panel.append(
      el("h2", `${label} is being created`),
      el("p", "This takes a moment. It is not an empty store yet."),
    );
  } else {
    panel.append(
      el("h2", "This store couldn’t be opened"),
      el(
        "p",
        `${message ?? "Its files or database are missing."} The assignment is kept; nothing is replaced automatically.`,
      ),
    );
    panel.append(button("Retry", retry, "knowledge-quiet"));
  }
  panel.append(button("Stores & sharing", openSettings, "knowledge-quiet"));
  return panel;
}

export type SettingsSection = "stores" | "vocab" | "status" | "maintenance";
const SECTIONS: [SettingsSection, string, IconName][] = [
  ["stores", "Stores & sharing", "users"],
  ["vocab", "Vocabulary", "book"],
  ["status", "Vault status", "activity"],
  ["maintenance", "Maintenance", "calendarClock"],
];
/** Settings shell: section navigation plus a content slot the caller fills. */
export function settingsShell(
  section: SettingsSection,
  go: (section: SettingsSection) => void,
  back: () => void,
  heading: [string, string],
  issues = 0,
) {
  const root = el("div", undefined, "knowledge-settings");
  const nav = el("nav", undefined, "knowledge-settings-nav");
  nav.setAttribute("aria-label", "Settings");
  nav.append(el("h2", "Settings"));
  for (const [id, text, glyph] of SECTIONS) {
    const item = button("", () => go(id), "knowledge-settings-link");
    item.append(icon(glyph, 15), el("span", text));
    if (id === "status" && issues) {
      item.append(el("span", String(issues), "knowledge-settings-count"));
    }
    if (id === section) {
      item.setAttribute("aria-current", "page");
    }
    nav.append(item);
  }
  const main = el("div", undefined, "knowledge-settings-main"),
    header = el("header");
  header.append(el("h2", heading[0]), el("p", heading[1], "knowledge-muted"));
  const slot = el("div", undefined, "knowledge-settings-slot");
  main.append(header, slot);
  const crumb = button("", back, "knowledge-quiet knowledge-crumb");
  crumb.append(icon("arrowLeft", 14), el("span", "Knowledge"));
  root.append(crumb, nav, main);
  return { root, slot };
}

/** Stores & sharing: assignments table and store inventory (spec §8.2). */
export function storesSection(
  snapshot: Snapshot,
  viewing: string,
  names: Names,
  change: (agent: string, mode: StoreChange["kind"]) => void,
) {
  const root = el("div", undefined, "knowledge-stores");
  if (!snapshot.canChange && snapshot.changeUnavailable) {
    root.append(el("p", snapshot.changeUnavailable, "knowledge-notice"));
  }
  for (const issue of snapshot.issues) {
    root.append(el("p", issue, "knowledge-notice"));
  }
  const table = el("div", undefined, "knowledge-surface knowledge-assignments");
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Agent store assignments");
  const head = el("div", undefined, "knowledge-assignment knowledge-assignment-head");
  head.setAttribute("role", "row");
  for (const text of ["Agent", "Knowledge store", "Access", ""]) {
    const cell = el("span", text);
    cell.setAttribute("role", "columnheader");
    head.append(cell);
  }
  table.append(head);
  for (const agent of snapshot.agents) {
    const row = el("div", undefined, "knowledge-assignment");
    row.setAttribute("role", "row");
    const who = el("span", undefined, "knowledge-assignment-agent");
    who.append(el("strong", names(agent.id)));
    if (agent.id === viewing) {
      who.append(el("span", "Viewing", "chip knowledge-chip"));
    }
    const entry = storeOf(snapshot, agent.id),
      store = el("span", undefined, "knowledge-assignment-store");
    if (entry) {
      const line = el("span");
      line.append(icon(storeIcon(entry), 14), el("span", storeLabel(entry, names)));
      store.append(line);
      const note = recordsText(entry);
      if (entry.state !== "ready" && note) {
        store.append(el("small", note));
      }
    } else {
      store.append(el("span", agent.issue ?? "Unavailable", "knowledge-error"));
    }
    const access = el(
      "span",
      entry ? accessText(entry, agent.id, names) : "",
      entry?.kind === "named" ? "" : "knowledge-muted",
    );
    const cells = [
      who,
      store,
      access,
      changeMenu(snapshot, agent.id, names, (mode) => change(agent.id, mode)),
    ];
    for (const cell of cells) {
      cell.setAttribute("role", "cell");
      row.append(cell);
    }
    table.append(row);
  }
  const inventory = el("section", undefined, "knowledge-store-inventory");
  inventory.append(el("h3", "Stores", "knowledge-eyebrow"));
  const list = el("div", undefined, "knowledge-surface");
  for (const entry of snapshot.stores.toSorted(
    (a, b) => Number(b.kind === "named") - Number(a.kind === "named"),
  )) {
    const row = el("div", undefined, "knowledge-store-row"),
      badge = el("span", undefined, `knowledge-store-icon knowledge-store-${entry.kind}`);
    badge.append(icon(storeIcon(entry), 14));
    const copy = el("span", undefined, "knowledge-store-copy"),
      titleLine = el("span");
    titleLine.append(el("strong", storeLabel(entry, names)));
    if (entry.kind === "named") {
      titleLine.append(el("span", "Shared store", "chip knowledge-chip"));
    }
    const used = entry.members.length
      ? `Used by ${andList(entry.members.map(names))}`
      : entry.kind === "isolated"
        ? `Not in use. Kept as it was when ${names(entry.owner!)} switched stores.`
        : "No agents assigned. Kept as is.";
    copy.append(titleLine, el("span", used, entry.members.length ? "" : "knowledge-muted"));
    row.append(badge, copy, el("span", recordsText(entry), "knowledge-muted"));
    list.append(row);
  }
  inventory.append(
    list,
    el(
      "p",
      "Stores are never merged or deleted from here. Removing an agent stops its future access; it can’t remove what the agent already retrieved into its conversations.",
      "knowledge-muted",
    ),
  );
  root.append(table, inventory);
  return root;
}

// Change… menu. It renders in the top layer (popover), so the table never clips it.
function changeMenu(
  snapshot: Snapshot,
  agentId: string,
  names: Names,
  pick: (mode: StoreChange["kind"]) => void,
) {
  const wrap = el("span", undefined, "knowledge-change");
  const trigger = button("Change…", () => undefined, "knowledge-button knowledge-small");
  trigger.setAttribute("aria-label", `Change store for ${names(agentId)}`);
  trigger.setAttribute("aria-haspopup", "menu");
  const entry = storeOf(snapshot, agentId),
    agent = snapshot.agents.find((a) => a.id === agentId)!;
  const options: [StoreChange["kind"], string, string, boolean][] = [];
  if (entry?.kind === "isolated") {
    options.push([
      "share_existing",
      "Share this store…",
      entry.state === "ready"
        ? "Name it and add agents. Knowledge stays where it is."
        : entry.state === "unprovisioned"
          ? "Nothing to share until it’s created on first use."
          : "This store needs recovery first.",
      entry.state !== "ready",
    ]);
  }
  const targets = snapshot.stores.filter((s) => s.kind === "named" && s.binding !== entry?.binding);
  if (targets.length) {
    options.push([
      "use_named",
      "Use shared store…",
      "Switch to a named store. Nothing is moved or merged.",
      false,
    ]);
  }
  if (entry?.kind === "named") {
    const own = snapshot.stores.find((s) => s.binding === `agent:${agentId}`);
    options.push([
      "use_own",
      "Use own store",
      own
        ? `Resume ${names(agentId)}’s previous store.`
        : `Use a new, empty store for ${names(agentId)}.`,
      false,
    ]);
  }
  if (!snapshot.canChange || !agent.supported || !options.length) {
    trigger.disabled = true;
    trigger.title = snapshot.changeUnavailable ?? agent.issue ?? "No changes available";
    wrap.append(trigger);
    return wrap;
  }
  const menu = el("div", undefined, "knowledge-menu knowledge-surface");
  menu.setAttribute("role", "menu");
  menu.popover = "auto";
  for (const [mode, text, note, disabled] of options) {
    const item = button(
      "",
      () => {
        menu.hidePopover();
        pick(mode);
      },
      "knowledge-menu-item",
    );
    item.setAttribute("role", "menuitem");
    item.disabled = disabled;
    item.append(el("span", text), el("small", note));
    menu.append(item);
  }
  trigger.addEventListener("click", () => {
    menu.togglePopover();
    if (!menu.matches(":popover-open")) {
      return;
    }
    // Anchor to the trigger; the top layer ignores table overflow clipping.
    const box = trigger.getBoundingClientRect(),
      width = Math.min(300, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))}px`;
    const below = box.bottom + 4,
      height = menu.offsetHeight;
    menu.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, box.top - height - 4) : below}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  });
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")],
      at = items.findIndex((item) => item === document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  });
  menu.addEventListener("toggle", (event) => {
    if (event.newState === "closed" && menu.contains(document.activeElement)) {
      trigger.focus();
    }
  });
  wrap.append(trigger, menu);
  return wrap;
}

/** Vault status facts for the viewed agent's store. */
export function vaultFacts(rows: [string, string | Node][]) {
  const grid = el("dl", undefined, "knowledge-surface knowledge-facts");
  for (const [key, value] of rows) {
    const item = el("div");
    item.append(el("dt", key));
    const dd = el("dd");
    dd.append(value);
    item.append(dd);
    grid.append(item);
  }
  return grid;
}

type Maintenance = FeatureOutput<typeof contract, "maintenance_status">;
/** Scheduled maintenance: schedule, next and last pass, and each store's result (spec §11). */
export function maintenanceSection(status: Maintenance, when: (iso: string) => string) {
  const root = el("div");
  const schedule = status.configError
    ? `Not scheduled: ${status.configError}`
    : !status.writesEnabled
      ? "Off: Knowledge writes are disabled"
      : !status.enabled
        ? "Off"
        : `${status.schedule} · ${status.timezone}`;
  const last = status.lastRun;
  root.append(
    vaultFacts([
      [
        "Jobs",
        status.jobs
          .map((job) =>
            job === "relink" ? "Link remembered claims to the one page they name" : job,
          )
          .join(", "),
      ],
      ["Schedule", schedule],
      [
        "Next run",
        status.running
          ? "Running now"
          : status.nextRunAt
            ? when(status.nextRunAt)
            : "Not scheduled",
      ],
      [
        "Last run",
        last
          ? `${when(last.finishedAt)} · ${last.trigger === "catch-up" ? "caught up after a missed run" : "on schedule"} · ${last.linked} claim${last.linked === 1 ? "" : "s"} linked`
          : "Not run yet",
      ],
      [
        "Runs on",
        "Every store you have defined, each conversation partition inside it. Stores not created yet are skipped. Not listed on the Automations page.",
      ],
    ]),
  );
  if (last) {
    const section = el("section", undefined, "knowledge-findings");
    section.append(el("h3", `Stores · ${last.vaults.length}`, "knowledge-eyebrow"));
    if (!last.vaults.length) {
      section.append(el("p", "No stores are defined.", "knowledge-muted"));
    }
    for (const vault of last.vaults) {
      const counts =
        vault.outcome === "ok"
          ? `${vault.linked} linked · ${vault.ambiguous} ambiguous · ${vault.noSubject} no page named${vault.failed ? ` · ${vault.failed} changed, retried next run` : ""} · ${vault.scanned} checked in ${vault.partitions} partition${vault.partitions === 1 ? "" : "s"}`
          : (vault.message ?? "");
      section.append(
        el(
          "p",
          `${vault.label} · ${vault.outcome === "ok" ? "Done" : vault.outcome === "skipped" ? "Skipped" : "Failed"} · ${counts}`,
        ),
      );
    }
    root.append(section);
  }
  return root;
}
