import {
  andList,
  button,
  el,
  recordsText,
  storeLabel,
  storeOf,
  type ChangeResult,
  type Names,
  type Snapshot,
} from "./store-entries.js";
import type { StoreChange } from "./stores-contract.js";
import { icon } from "./ui-icons.js";

/** One assignment dialog (share / use named / use own). `save` performs the
 * change; the dialog keeps inputs on rejection and reports truthful state. */
export function storeDialog(
  mode: StoreChange["kind"],
  agentId: string,
  snapshot: Snapshot,
  names: Names,
  save: (change: StoreChange) => Promise<ChangeResult>,
  done: (result: ChangeResult) => void,
) {
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
        value && snapshot.stores.some((s) => s.kind === "named" && s.label.toLowerCase() === value)
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
    let target = targets.find((s) => s.state !== "unavailable" && s.state !== "recovery-required");
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
      const result = await save(next);
      if (result.outcome === "applied") {
        close();
        done(result);
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
        done(result);
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
  return dialog;
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
