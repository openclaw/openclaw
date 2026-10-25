import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import { contract } from "./contract.js";
import { loadVocabulary } from "./inspection-client.js";
import { ontologyView } from "./ontology-view.js";
import type { Page } from "./page-context.js";
import { el, human, label, time } from "./page-dom.js";
import {
  accessText,
  maintenanceSection,
  settingsShell,
  storeDialog,
  storeLabel,
  storeNotice,
  storeOf,
  storesSection,
  type SettingsSection,
  vaultFacts,
} from "./stores-view.js";

/** Settings screen for the current section: stores, vocabulary, status or maintenance. */
export async function settings(ui: Page, n: number, target: HTMLElement) {
  const {
    s,
    base,
    feature,
    announcer,
    live,
    displayName,
    viewedAgent,
    open,
    load,
    refresh,
    renderStoreContext,
    navigate,
    openSettings,
  } = ui;
  const agent = viewedAgent(),
    who = displayName(agent),
    entry = s.storesSnapshot && storeOf(s.storesSnapshot, agent);
  const heading: Record<SettingsSection, [string, string]> = {
    stores: [
      "Stores & sharing",
      "Each agent gets its own knowledge store unless you assign it to a shared one.",
    ],
    vocab: [
      "Vocabulary",
      `The kinds of pages and connections ${who} can save${entry ? ` in ${storeLabel(entry, displayName)}` : ""}.`,
    ],
    status: [
      "Vault status",
      entry
        ? `Showing ${storeLabel(entry, displayName)}, the store ${who} uses.`
        : `Showing ${who}’s store.`,
    ],
    maintenance: [
      "Maintenance",
      "A scheduled pass that tidies every store. It never calls a model and never creates a store.",
    ],
  };
  const shell = settingsShell(
    s.settingsSection,
    (section) => {
      s.settingsSection = section;
      void load();
    },
    () => navigate("recent"),
    heading[s.settingsSection],
  );
  if (s.settingsSection === "stores") {
    s.storesSnapshot = await base.invoke("stores_snapshot", {});
    if (!live(n)) {
      return;
    }
    renderStoreContext();
    shell.slot.append(
      storesSection(s.storesSnapshot, agent, displayName, (changing, mode) => {
        storeDialog(
          mode,
          changing,
          s.storesSnapshot!,
          displayName,
          (change) =>
            base.invoke("stores_change", {
              requestId: crypto.randomUUID(),
              expectedRevision: s.storesSnapshot!.revision,
              agent: changing,
              change,
            }),
          (result) => assignmentApplied(ui, result, changing),
        );
      }),
    );
  } else if (s.settingsSection === "maintenance") {
    const status = await base.invoke("maintenance_status", {});
    if (!live(n)) {
      return;
    }
    shell.slot.append(
      maintenanceSection(
        status,
        (at) =>
          `${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(at)}`,
      ),
    );
  } else if (s.storeState !== "ready") {
    shell.slot.append(
      storeNotice(
        entry,
        s.storeState,
        s.storeMessage,
        who,
        displayName,
        () => openSettings("stores"),
        () => void refresh(),
      ),
    );
  } else if (s.settingsSection === "vocab") {
    const result = await loadVocabulary(feature, true);
    if (!live(n)) {
      return;
    }
    shell.slot.append(ontologyView(result, open, () => openSettings("status")));
  } else {
    const [report, findings, history] = await Promise.all([
      feature.invoke("status", {}),
      feature.invoke("diagnostics", {}),
      feature.invoke("history", { limit: 1 }),
    ]);
    if (!live(n)) {
      return;
    }
    const facts: [string, string | Node][] = [
      [
        "Store",
        entry
          ? `${storeLabel(entry, displayName)} · ${entry.kind === "named" ? "shared store" : "own store"}`
          : "Unknown",
      ],
      ["Used by", entry?.members.length ? entry.members.map(displayName).join(", ") : "No agents"],
      [
        "Access",
        `${entry ? accessText(entry, agent, displayName) + ". " : ""}Read and update from owner-direct conversations. Group chats see only their own conversation’s knowledge.`,
      ],
      [
        "Changes",
        `Made by ${entry?.members.length ? entry.members.map(displayName).join(", ") : who} in chat. These pages only read.`,
      ],
      [
        "Live",
        `${report.live === "watching" ? "Watching for changes" : report.live === "unavailable" ? "Change watching unavailable" : "Not watching"} · checked ${time(report.checkedAt)}`,
      ],
      ["Records", `${report.records.toLocaleString()} current`],
      [
        "Checks",
        report.issues ? `${report.issues} finding${report.issues === 1 ? "" : "s"}` : "All pass",
      ],
      [
        "Vocabulary",
        report.ontologyAvailable
          ? `${report.definitions} definitions · ${report.ontologyFingerprint.slice(0, 12)}`
          : "Unavailable",
      ],
      [
        "Local history",
        `${label(history.git.state)} · ${history.git.pending ? `${history.git.pending} waiting` : "nothing waiting"}`,
      ],
    ];
    shell.slot.append(vaultFacts(facts));
    const list = el("section", undefined, "knowledge-findings");
    list.append(el("h3", `Findings · ${findings.total}`, "knowledge-eyebrow"));
    if (!findings.total) {
      list.append(el("p", `No findings. Checked ${time(findings.checkedAt)}.`, "knowledge-muted"));
    }
    for (const issue of findings.issues) {
      list.append(el("p", `${human(issue.code)} · ${issue.path}: ${issue.message}`));
    }
    shell.slot.append(list);
  }
  target.replaceChildren(shell.root, announcer);
}

// After an applied assignment, refresh facts; reset the reading view if the viewed store moved.
function assignmentApplied(
  ui: Page,
  result: FeatureOutput<typeof contract, "stores_change">,
  agent: string,
) {
  const { s, displayName, viewedAgent, announce, load, refresh, renderStoreContext } = ui;
  if (!result.snapshot) {
    return;
  }
  const before = s.storesSnapshot && storeOf(s.storesSnapshot, viewedAgent())?.binding;
  s.storesSnapshot = result.snapshot;
  renderStoreContext();
  const entry = storeOf(result.snapshot, agent);
  if (result.outcome === "applied") {
    announce(
      `${displayName(agent)} now uses ${entry ? storeLabel(entry, displayName) : "a different store"}.`,
    );
  }
  if (before !== storeOf(result.snapshot, viewedAgent())?.binding) {
    s.identity = "";
    s.snapshot = undefined;
    s.vocabulary = undefined;
  }
  if (s.tab === "settings") {
    void load(true);
  }
  void refresh();
}
