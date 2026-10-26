import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { loadVocabulary } from "./inspection-client.js";
import { ontologyView } from "./ontology-view.js";
import type { Page } from "./page-context.js";
import { button, el, human, label, time } from "./page-dom.js";
import { andList, recordsText } from "./store-entries.js";
import type { StoreChange } from "./stores-contract.js";
import {
  accessText,
  maintenanceSection,
  settingsShell,
  storeLabel,
  storeNotice,
  storeOf,
  storesSection,
  type SettingsSection,
  vaultFacts,
} from "./stores-view.js";
import { icon } from "./ui-icons.js";

/** Settings screen for the current section: stores, vocabulary, status or maintenance. */
export async function settings(ui: Page, n: number, settingsTarget: HTMLElement) {
  const {
    s: state,
    base,
    feature,
    announcer,
    live,
    displayName,
    viewedAgent,
    open,
    load,
    refresh: refreshPage,
    renderStoreContext,
    navigate,
    openSettings,
  } = ui;
  const viewedId = viewedAgent(),
    viewedName = displayName(viewedId),
    viewedStore = state.storesSnapshot && storeOf(state.storesSnapshot, viewedId);
  const sectionHeadings: Record<SettingsSection, [string, string]> = {
    stores: [
      "Stores & sharing",
      "Each agent gets its own knowledge store unless you assign it to a shared one.",
    ],
    vocab: [
      "Vocabulary",
      `The kinds of pages and connections ${viewedName} can save${viewedStore ? ` in ${storeLabel(viewedStore, displayName)}` : ""}.`,
    ],
    status: [
      "Vault status",
      viewedStore
        ? `Showing ${storeLabel(viewedStore, displayName)}, the store ${viewedName} uses.`
        : `Showing ${viewedName}’s store.`,
    ],
    maintenance: [
      "Maintenance",
      "A scheduled pass that tidies every store. It never calls a model and never creates a store.",
    ],
  };
  const shell = settingsShell(
    state.settingsSection,
    (section) => {
      state.settingsSection = section;
      void load();
    },
    () => navigate("recent"),
    sectionHeadings[state.settingsSection],
  );
  if (state.settingsSection === "stores") {
    state.storesSnapshot = await base.invoke("stores_snapshot", {});
    if (!live(n)) {
      return;
    }
    renderStoreContext();
    shell.slot.append(
      storesSection(state.storesSnapshot, viewedId, displayName, (changing, mode) => {
        // Keep assignment inputs on rejection and report the observed save outcome.
        const agentId = changing,
          snapshot = state.storesSnapshot!,
          names = displayName;

        const who = names(agentId),
          current = storeOf(snapshot, agentId);
        const dialog = el("dialog", undefined, "knowledge-store-dialog knowledge-surface"),
          // SAFETY: only focus() is called on it, which every focusable HTML or SVG element implements.
          previousFocus = document.activeElement as HTMLElement | null;
        const heading = el("h3"),
          body = el("div", undefined, "knowledge-store-dialog-body"),
          effect = el("div", undefined, "knowledge-effect"),
          feedback = el("p", "", "knowledge-dialog-feedback");
        feedback.setAttribute("role", "status");
        feedback.setAttribute("aria-live", "polite");
        const cancel = button("Cancel", () => close(), "knowledge-quiet"),
          submit = button("", () => void run(), "knowledge-button knowledge-primary");
        let saving = false;
        const close = () => {
          dialog.close();
          dialog.remove();
          previousFocus?.focus();
        };
        // Escape and backdrop dismissal close the view; an accepted save is never "cancelled".
        dialog.addEventListener("cancel", (event) => {
          event.preventDefault();
          close();
        });
        let collect: () => StoreChange | undefined = () => undefined;
        let submitLabel = () => "Save";
        const refresh = () => {
          submit.disabled = saving || !collect();
          submit.textContent = saving ? "Saving…" : submitLabel();
          renderEffect();
        };
        let renderEffect = () => {};

        if (mode === "share_existing") {
          heading.textContent = `Share ${who}’s knowledge`;
          const nameField = el("label", undefined, "knowledge-field"),
            input = el("input");
          input.maxLength = 80;
          input.placeholder = "e.g. Team";
          input.autocomplete = "off";
          const hint = el(
            "small",
            `${who}’s existing store gets this name. It isn’t copied or replaced.`,
          );
          nameField.append(el("span", "Store name"), input, hint);
          const picks = el("fieldset", undefined, "knowledge-choices");
          picks.append(el("legend", "Agents to add"));
          const chosen = new Set<string>();
          for (const agent of snapshot.agents.filter((a) => a.id !== agentId)) {
            const entry = storeOf(snapshot, agent.id);
            const note =
              !agent.supported || !entry
                ? (agent.issue ?? "Unavailable")
                : entry.kind === "named"
                  ? `Uses ${storeLabel(entry, names)}. It will switch to the new store.`
                  : entry.state === "unprovisioned"
                    ? "No store yet"
                    : `Uses ${storeLabel(entry, names)}`;
            picks.append(
              choice(
                "checkbox",
                `share-${agent.id}`,
                names(agent.id),
                note,
                !agent.supported || !entry,
                (checked) => {
                  if (checked) {
                    chosen.add(agent.id);
                  } else {
                    chosen.delete(agent.id);
                  }
                  refresh();
                },
              ),
            );
          }
          const taken = () => {
            const value = input.value.trim().toLowerCase();
            return (
              value &&
              snapshot.stores.some((s) => s.kind === "named" && s.label.toLowerCase() === value)
            );
          };
          input.addEventListener("input", () => {
            hint.textContent = taken()
              ? `A store with this name already exists. To join it, use “Use shared store…” instead.`
              : `${who}’s existing store gets this name. It isn’t copied or replaced.`;
            hint.classList.toggle("knowledge-error", Boolean(taken()));
            refresh();
          });
          collect = () =>
            input.value.trim() && !taken() && chosen.size
              ? { kind: "share_existing", label: input.value.trim(), agents: [...chosen] }
              : undefined;
          renderEffect = () => {
            effect.replaceChildren();
            if (!chosen.size) {
              return;
            }
            const name = input.value.trim() || "the new store",
              joiners = [...chosen];
            effect.append(
              el(
                "p",
                `${andList(joiners.map(names))} will be able to read and update the knowledge already saved in ${name} from owner-direct conversations.`,
              ),
            );
            for (const joiner of joiners) {
              const entry = storeOf(snapshot, joiner);
              if (entry && entry.state !== "unprovisioned") {
                effect.append(
                  el(
                    "p",
                    `${names(joiner)} will switch from ${storeLabel(entry, names)}. ${storeLabel(entry, names)} remains unchanged.`,
                  ),
                );
              }
            }
            effect.append(
              el(
                "p",
                "Group chats still see only their own conversation’s knowledge.",
                "knowledge-muted",
              ),
            );
          };
          submitLabel = () => "Share store";
          body.append(nameField, picks);
        } else if (mode === "use_named") {
          heading.textContent = `Use a shared store for ${who}`;
          const targets = snapshot.stores.filter(
            (s) => s.kind === "named" && s.binding !== current?.binding,
          );
          let target = targets.find(
            (s) => s.state !== "unavailable" && s.state !== "recovery-required",
          );
          const picks = el("fieldset", undefined, "knowledge-choices");
          picks.append(el("legend", "Shared store"));
          for (const entry of targets) {
            const blocked = entry.state === "unavailable" || entry.state === "recovery-required";
            const note = blocked
              ? "Couldn’t be opened; needs recovery first."
              : `${entry.members.length ? `Used by ${andList(entry.members.map(names))}` : "No agents assigned"}${recordsText(entry) ? ` · ${recordsText(entry).toLowerCase()}` : ""}`;
            picks.append(
              choice(
                "radio",
                `use-${entry.key}`,
                entry.label,
                note,
                blocked,
                () => {
                  target = entry;
                  refresh();
                },
                entry === target,
                "knowledge-store-target",
              ),
            );
          }
          collect = () => (target?.key ? { kind: "use_named", store: target.key } : undefined);
          renderEffect = () => {
            effect.replaceChildren();
            if (!target) {
              return;
            }
            effect.append(
              el(
                "p",
                `${who} will use ${target.label}.${current ? ` Nothing from ${storeLabel(current, names)} will be moved or merged.` : ""}`,
              ),
            );
            effect.append(
              el(
                "p",
                `${who} can read and update the knowledge already saved in ${target.label}${target.members.length ? `, alongside ${andList(target.members.map(names))}` : ""}.`,
              ),
            );
            if (current) {
              effect.append(
                el(
                  "p",
                  `${who} stops using ${storeLabel(current, names)} from now on. Anything it already retrieved into its conversations can’t be taken back.`,
                  "knowledge-muted",
                ),
              );
            }
            effect.append(
              el(
                "p",
                "Group chats still see only their own conversation’s knowledge.",
                "knowledge-muted",
              ),
            );
          };
          submitLabel = () => (target ? `Use ${target.label}` : "Use store");
          body.append(picks);
        } else {
          heading.textContent = `Use own store for ${who}`;
          const own = snapshot.stores.find((s) => s.binding === `agent:${agentId}`),
            blocked = own?.state === "unavailable" || own?.state === "recovery-required";
          const summary = el("div", undefined, "knowledge-own-choice");
          if (blocked) {
            summary.append(
              el("strong", `${who}’s previous store needs recovery`),
              el(
                "span",
                "It couldn’t be opened, so it can’t be resumed or replaced from here.",
                "knowledge-muted",
              ),
            );
          } else if (own && own.state !== "unprovisioned") {
            summary.append(
              el("strong", `Resume ${who}’s previous store.`),
              el(
                "span",
                `${storeLabel(own, names)}${recordsText(own) ? ` · ${recordsText(own).toLowerCase()}` : ""}, as it was left.`,
                "knowledge-muted",
              ),
            );
          } else {
            summary.append(
              el("strong", `Use a new, empty store for ${who}.`),
              el(
                "span",
                "Created on first authorized use. Viewing it here does not create it.",
                "knowledge-muted",
              ),
            );
          }
          collect = () => (blocked ? undefined : { kind: "use_own" });
          renderEffect = () => {
            effect.replaceChildren();
            if (!current) {
              return;
            }
            const staying = current.members.filter((a) => a !== agentId);
            effect.append(
              el(
                "p",
                `Nothing in ${storeLabel(current, names)} is copied or removed${staying.length ? `; ${andList(staying.map(names))} keep${staying.length === 1 ? "s" : ""} using it` : "; it is kept even with no agents assigned"}.`,
              ),
            );
            effect.append(
              el(
                "p",
                `${who} stops using ${storeLabel(current, names)} from now on. Anything it already retrieved into its conversations can’t be taken back.`,
                "knowledge-muted",
              ),
            );
          };
          submitLabel = () => "Use own store";
          body.append(summary);
        }

        // Save once; keep the dialog and inputs unless the change was applied.
        async function run() {
          const next = collect();
          if (!next || saving) {
            return;
          }
          saving = true;
          refresh();
          feedback.textContent = "";
          feedback.className = "knowledge-dialog-feedback";
          try {
            const result = await base.invoke("stores_change", {
              requestId: crypto.randomUUID(),
              expectedRevision: state.storesSnapshot!.revision,
              agent: changing,
              change: next,
            });
            if (result.outcome === "applied") {
              close();
              assignmentApplied(ui, result, changing);
              return;
            }
            feedback.textContent =
              result.outcome === "pending" || result.outcome === "unknown"
                ? `Checking whether the change was saved… ${result.message}`
                : result.message;
            feedback.classList.add(
              result.outcome === "pending" || result.outcome === "unknown"
                ? "knowledge-muted"
                : "knowledge-error",
            );
            if (result.outcome === "conflict" && result.snapshot) {
              assignmentApplied(ui, result, changing);
            }
          } catch (error) {
            feedback.textContent = `The assignment was not changed. ${error instanceof Error ? error.message : String(error)}`;
            feedback.classList.add("knowledge-error");
          } finally {
            saving = false;
            if (dialog.open) {
              refresh();
            }
          }
        }
        const closeButton = button("", () => close(), "knowledge-icon-button");
        closeButton.setAttribute("aria-label", "Close");
        closeButton.append(icon("x", 14));
        const top = el("div", undefined, "knowledge-store-dialog-head");
        top.append(heading, closeButton);
        const footer = el("div", undefined, "knowledge-actions");
        footer.append(cancel, submit);
        dialog.setAttribute("aria-labelledby", "knowledge-store-dialog-title");
        heading.id = "knowledge-store-dialog-title";
        body.append(effect);
        dialog.append(top, body, feedback, footer);
        // Inside the page so its styles apply; the modal top layer handles stacking.
        (document.querySelector(".knowledge-page") ?? document.body).append(dialog);
        dialog.showModal();
        refresh();
        (dialog.querySelector<HTMLElement>("input:not(:disabled)") ?? submit).focus();
      }),
    );
  } else if (state.settingsSection === "maintenance") {
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
  } else if (state.storeState !== "ready") {
    shell.slot.append(
      storeNotice(
        viewedStore,
        state.storeState,
        state.storeMessage,
        viewedName,
        displayName,
        () => openSettings("stores"),
        () => void refreshPage(),
      ),
    );
  } else if (state.settingsSection === "vocab") {
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
        viewedStore
          ? `${storeLabel(viewedStore, displayName)} · ${viewedStore.kind === "named" ? "shared store" : "own store"}`
          : "Unknown",
      ],
      [
        "Used by",
        viewedStore?.members.length ? viewedStore.members.map(displayName).join(", ") : "No agents",
      ],
      [
        "Access",
        `${viewedStore ? accessText(viewedStore, viewedId, displayName) + ". " : ""}Read and update from owner-direct conversations. Group chats see only their own conversation’s knowledge.`,
      ],
      [
        "Changes",
        `Made by ${viewedStore?.members.length ? viewedStore.members.map(displayName).join(", ") : viewedName} in chat. These pages only read.`,
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
  settingsTarget.replaceChildren(shell.root, announcer);
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

function choice(
  type: "checkbox" | "radio",
  id: string,
  title: string,
  note: string,
  disabled: boolean,
  onChange: (checked: boolean) => void,
  checked = false,
  name?: string,
) {
  const row = el("label", undefined, "knowledge-choice"),
    input = el("input");
  input.type = type;
  input.id = id;
  input.disabled = disabled;
  input.checked = checked;
  if (name) {
    input.name = name;
  }
  input.addEventListener("change", () => onChange(input.checked));
  const copy = el("span");
  copy.append(el("span", title), el("small", note));
  row.append(input, copy);
  return row;
}
