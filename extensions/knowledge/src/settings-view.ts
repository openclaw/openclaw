import type { FeatureOutput } from "openclaw/plugin-sdk/feature-contract";
import type { contract } from "./contract.js";
import { conversationAccessSection, type GrantSessions } from "./conversation-access-view.js";
import { t } from "./i18n/index.js";
import { loadVocabulary } from "./inspection-client.js";
import { ontologyView } from "./ontology-view.js";
import type { Page } from "./page-context.js";
import { button, choice, el, human, label, time } from "./page-dom.js";
import { andList, recordsText } from "./store-entries.js";
import { GRANT_SESSION_KEY, type StoreChange } from "./stores-contract.js";
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
    stores: [t("knowledge.settings.sections.stores"), t("knowledge.settings.storesHint")],
    vocab: [
      t("knowledge.settings.sections.vocab"),
      viewedStore
        ? t("knowledge.settings.vocabHintStore", {
            agent: viewedName,
            store: storeLabel(viewedStore, displayName),
          })
        : t("knowledge.settings.vocabHint", { agent: viewedName }),
    ],
    status: [
      t("knowledge.settings.sections.status"),
      viewedStore
        ? t("knowledge.settings.statusHintStore", {
            store: storeLabel(viewedStore, displayName),
            agent: viewedName,
          })
        : t("knowledge.settings.statusHint", { agent: viewedName }),
    ],
    maintenance: [
      t("knowledge.settings.sections.maintenance"),
      t("knowledge.settings.maintenanceHint"),
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
    const [storesSnapshot, sessions] = await Promise.all([
      base.invoke("stores_snapshot", {}),
      grantSessions(state.context.host, viewedId),
    ]);
    state.storesSnapshot = storesSnapshot;
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
        const cancel = button(t("knowledge.common.cancel"), () => close(), "knowledge-quiet"),
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
        let submitLabel = () => t("knowledge.common.save");
        const refresh = () => {
          submit.disabled = saving || !collect();
          submit.textContent = saving ? t("knowledge.common.saving") : submitLabel();
          renderEffect();
        };
        let renderEffect = () => {};

        if (mode === "share_existing") {
          heading.textContent = t("knowledge.settings.share.title", { agent: who });
          const nameField = el("label", undefined, "knowledge-field"),
            input = el("input");
          input.maxLength = 80;
          input.placeholder = t("knowledge.settings.share.placeholder");
          input.autocomplete = "off";
          const hint = el("small", t("knowledge.settings.share.nameHint", { agent: who }));
          nameField.append(el("span", t("knowledge.settings.share.name")), input, hint);
          const picks = el("fieldset", undefined, "knowledge-choices");
          picks.append(el("legend", t("knowledge.settings.share.agents")));
          const chosen = new Set<string>();
          for (const agent of snapshot.agents.filter((a) => a.id !== agentId)) {
            const entry = storeOf(snapshot, agent.id);
            const note =
              !agent.supported || !entry
                ? (agent.issue ?? t("knowledge.common.unavailable"))
                : entry.kind === "named"
                  ? t("knowledge.settings.share.switches", { store: storeLabel(entry, names) })
                  : entry.state === "unprovisioned"
                    ? t("knowledge.settings.share.noStore")
                    : t("knowledge.settings.share.uses", { store: storeLabel(entry, names) });
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
              ? t("knowledge.settings.share.taken")
              : t("knowledge.settings.share.nameHint", { agent: who });
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
            const name = input.value.trim() || t("knowledge.settings.share.newStore"),
              joiners = [...chosen];
            effect.append(
              el(
                "p",
                t("knowledge.settings.share.effect", {
                  agents: andList(joiners.map(names)),
                  store: name,
                }),
              ),
            );
            for (const joiner of joiners) {
              const entry = storeOf(snapshot, joiner);
              if (entry && entry.state !== "unprovisioned") {
                effect.append(
                  el(
                    "p",
                    t("knowledge.settings.share.joinerEffect", {
                      agent: names(joiner),
                      store: storeLabel(entry, names),
                    }),
                  ),
                );
              }
            }
            effect.append(el("p", groupAccessNote(), "knowledge-muted"));
          };
          submitLabel = () => t("knowledge.settings.share.submit");
          body.append(nameField, picks);
        } else if (mode === "use_named") {
          heading.textContent = t("knowledge.settings.useShared.title", { agent: who });
          const targets = snapshot.stores.filter(
            (s) => s.kind === "named" && s.binding !== current?.binding,
          );
          let target = targets.find(
            (s) => s.state !== "unavailable" && s.state !== "recovery-required",
          );
          const picks = el("fieldset", undefined, "knowledge-choices");
          picks.append(el("legend", t("knowledge.stores.shared")));
          for (const entry of targets) {
            const blocked = entry.state === "unavailable" || entry.state === "recovery-required";
            const note = blocked
              ? t("knowledge.settings.useShared.blocked")
              : [
                  entry.members.length
                    ? t("knowledge.stores.usedBy", { agents: andList(entry.members.map(names)) })
                    : t("knowledge.settings.useShared.unassigned"),
                  recordsText(entry).toLowerCase(),
                ]
                  .filter(Boolean)
                  .join(" · ");
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
                current
                  ? t("knowledge.settings.useShared.effectMoved", {
                      agent: who,
                      store: target.label,
                      current: storeLabel(current, names),
                    })
                  : t("knowledge.settings.useShared.effect", { agent: who, store: target.label }),
              ),
            );
            effect.append(
              el(
                "p",
                target.members.length
                  ? t("knowledge.settings.useShared.accessWith", {
                      agent: who,
                      store: target.label,
                      agents: andList(target.members.map(names)),
                    })
                  : t("knowledge.settings.useShared.access", { agent: who, store: target.label }),
              ),
            );
            if (current) {
              effect.append(
                el(
                  "p",
                  t("knowledge.settings.stopsUsing", {
                    agent: who,
                    store: storeLabel(current, names),
                  }),
                  "knowledge-muted",
                ),
              );
            }
            effect.append(el("p", groupAccessNote(), "knowledge-muted"));
          };
          submitLabel = () =>
            target
              ? t("knowledge.settings.useShared.submitStore", { store: target.label })
              : t("knowledge.settings.useShared.submit");
          body.append(picks);
        } else {
          heading.textContent = t("knowledge.settings.useOwn.title", { agent: who });
          const own = snapshot.stores.find((s) => s.binding === `agent:${agentId}`),
            blocked = own?.state === "unavailable" || own?.state === "recovery-required";
          const summary = el("div", undefined, "knowledge-own-choice");
          if (blocked) {
            summary.append(
              el("strong", t("knowledge.settings.useOwn.needsRecovery", { agent: who })),
              el("span", t("knowledge.settings.useOwn.needsRecoveryBody"), "knowledge-muted"),
            );
          } else if (own && own.state !== "unprovisioned") {
            summary.append(
              el("strong", t("knowledge.stores.resumeOwn", { agent: who })),
              el(
                "span",
                t("knowledge.settings.useOwn.asLeft", {
                  store: [storeLabel(own, names), recordsText(own).toLowerCase()]
                    .filter(Boolean)
                    .join(" · "),
                }),
                "knowledge-muted",
              ),
            );
          } else {
            summary.append(
              el("strong", t("knowledge.stores.newOwn", { agent: who })),
              el("span", t("knowledge.settings.useOwn.newBody"), "knowledge-muted"),
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
                staying.length
                  ? t(
                      staying.length === 1
                        ? "knowledge.settings.useOwn.keptOne"
                        : "knowledge.settings.useOwn.kept",
                      { store: storeLabel(current, names), agents: andList(staying.map(names)) },
                    )
                  : t("knowledge.settings.useOwn.keptEmpty", { store: storeLabel(current, names) }),
              ),
            );
            effect.append(
              el(
                "p",
                t("knowledge.settings.stopsUsing", {
                  agent: who,
                  store: storeLabel(current, names),
                }),
                "knowledge-muted",
              ),
            );
          };
          submitLabel = () => t("knowledge.stores.useOwn");
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
                ? t("knowledge.settings.checkingSaved", { details: result.message })
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
            feedback.textContent = t("knowledge.settings.changeFailed", {
              details: error instanceof Error ? error.message : String(error),
            });
            feedback.classList.add("knowledge-error");
          } finally {
            saving = false;
            if (dialog.open) {
              refresh();
            }
          }
        }
        const closeButton = button("", () => close(), "knowledge-icon-button");
        closeButton.setAttribute("aria-label", t("knowledge.common.close"));
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
      conversationAccessSection(
        storesSnapshot,
        viewedId,
        viewedName,
        sessions,
        async (sessionKey, access) => {
          try {
            const result = await base.invoke("stores_grant", {
              expectedRevision: state.storesSnapshot!.grants.revision,
              sessionKey,
              access,
            });
            if (result.snapshot) {
              state.storesSnapshot = result.snapshot;
            }
            if (result.outcome !== "applied") {
              return result.message;
            }
            ui.announce(result.message);
            void load(true);
            return undefined;
          } catch (error) {
            return t("knowledge.settings.accessFailed", {
              details: error instanceof Error ? error.message : String(error),
            });
          }
        },
      ),
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
        t("knowledge.scribes.facts.store"),
        viewedStore
          ? t(
              viewedStore.kind === "named"
                ? "knowledge.settings.status.sharedStore"
                : "knowledge.settings.status.ownStore",
              { store: storeLabel(viewedStore, displayName) },
            )
          : t("knowledge.settings.status.unknown"),
      ],
      [
        t("knowledge.settings.status.usedBy"),
        viewedStore?.members.length
          ? viewedStore.members.map(displayName).join(", ")
          : t("knowledge.settings.status.noAgents"),
      ],
      [
        t("knowledge.stores.access"),
        [
          viewedStore ? `${accessText(viewedStore, viewedId, displayName)}.` : "",
          t("knowledge.settings.status.access"),
          grantsText(
            state.storesSnapshot?.grants.entries.filter((g) => g.agent === viewedId).length ?? 0,
          ),
        ]
          .filter(Boolean)
          .join(" "),
      ],
      [
        t("knowledge.settings.status.changes"),
        t("knowledge.settings.status.changesValue", {
          agents: viewedStore?.members.length
            ? viewedStore.members.map(displayName).join(", ")
            : viewedName,
        }),
      ],
      [
        t("knowledge.settings.status.live"),
        t(
          report.live === "watching"
            ? "knowledge.settings.status.watching"
            : report.live === "unavailable"
              ? "knowledge.settings.status.watchUnavailable"
              : "knowledge.settings.status.notWatching",
          { time: time(report.checkedAt) },
        ),
      ],
      [
        t("knowledge.settings.status.records"),
        t("knowledge.settings.status.recordsValue", { count: report.records.toLocaleString() }),
      ],
      [
        t("knowledge.settings.status.checks"),
        report.issues
          ? t(
              report.issues === 1
                ? "knowledge.settings.status.findingOne"
                : "knowledge.settings.status.findings",
              { count: String(report.issues) },
            )
          : t("knowledge.settings.status.allPass"),
      ],
      [
        t("knowledge.settings.sections.vocab"),
        report.ontologyAvailable
          ? t("knowledge.settings.status.definitions", {
              count: String(report.definitions),
              fingerprint: report.ontologyFingerprint.slice(0, 12),
            })
          : t("knowledge.common.unavailable"),
      ],
      [
        t("knowledge.settings.status.history"),
        `${label(history.git.state)} · ${
          history.git.pending
            ? t("knowledge.settings.status.waiting", { count: String(history.git.pending) })
            : t("knowledge.settings.status.nothingWaiting")
        }`,
      ],
    ];
    shell.slot.append(vaultFacts(facts));
    const list = el("section", undefined, "knowledge-findings");
    list.append(
      el(
        "h3",
        t("knowledge.settings.status.findingsTitle", { count: String(findings.total) }),
        "knowledge-eyebrow",
      ),
    );
    if (!findings.total) {
      list.append(
        el(
          "p",
          t("knowledge.settings.status.noFindings", { time: time(findings.checkedAt) }),
          "knowledge-muted",
        ),
      );
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
      t("knowledge.settings.nowUses", {
        agent: displayName(agent),
        store: entry ? storeLabel(entry, displayName) : t("knowledge.settings.differentStore"),
      }),
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

const grantKey = new RegExp(GRANT_SESSION_KEY);
type SessionListRow = {
  key: string;
  chatType?: string;
  label?: string;
  displayName?: string;
  archived?: boolean;
};
/** The viewed agent's group and channel conversations, for grant labels and the
 * picker. Listing uses the operator's own session access; Knowledge's grant
 * enforcement never reads session rows. Undefined when the list can't load. */
async function grantSessions(
  host: Page["s"]["context"]["host"],
  agentId: string,
): Promise<GrantSessions | undefined> {
  try {
    const result = await host.request<{ sessions: SessionListRow[]; hasMore?: boolean }>(
      "sessions.list",
      { agentId, archived: "all", limit: 500 },
    );
    return {
      rows: result.sessions
        .filter((s) => (s.chatType === "group" || s.chatType === "channel") && grantKey.test(s.key))
        .map((s) => ({
          key: s.key,
          title: s.label || s.displayName || s.key,
          archived: s.archived === true,
        })),
      complete: result.hasMore !== true,
    };
  } catch {
    return undefined;
  }
}

// Vault status summary of conversation grants for the viewed agent.
const grantsText = (count: number) =>
  count
    ? t(count === 1 ? "knowledge.settings.grantsOne" : "knowledge.settings.grants", {
        count: String(count),
      })
    : t("knowledge.settings.noGrants");

// Store-change dialogs: grants follow the agent, so granted chats reach the new store.
const groupAccessNote = () => t("knowledge.settings.groupAccessNote");
