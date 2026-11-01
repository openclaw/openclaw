/** Settings → Stores & sharing: owner grants that let a group or channel
 * conversation use an agent's private knowledge. */
import { button, el } from "./page-dom.js";
import type { Snapshot } from "./store-entries.js";
import type { GrantChangeInput, GrantEntry } from "./stores-contract.js";
import { icon } from "./ui-icons.js";

type Access = GrantEntry["access"];
/** A conversation the operator can see, for labels and the grant picker. */
type GrantSession = { key: string; title: string; archived: boolean };
/** Known group and channel conversations of the viewed agent; `complete` says
 * whether a grant missing from them can be reported as matching none. */
export type GrantSessions = { rows: GrantSession[]; complete: boolean };

const ACCESS: [Access, string][] = [
  ["read", "Can read"],
  ["read-write", "Can read and save"],
];
const NOTES: Record<Access, string> = {
  read: "Reads private knowledge; can’t save.",
  "read-write": "Reads and saves private knowledge.",
};

// A grant also covers keys that extend it with ":" (threads, topics), matching
// Knowledge's own lookup.
const covers = (grant: string, key: string) => key === grant || key.startsWith(grant + ":");

/** Conversation access for one agent: current grants, their mode, and adding one. */
export function conversationAccessSection(
  snapshot: Snapshot,
  agentId: string,
  agentName: string,
  sessions: GrantSessions | undefined,
  save: (sessionKey: string, access: GrantChangeInput["access"]) => Promise<string | undefined>,
) {
  const root = el("section", undefined, "knowledge-store-inventory knowledge-grants");
  root.append(
    el("h3", "Conversation access", "knowledge-eyebrow"),
    el(
      "p",
      "Group and channel conversations keep their own knowledge by default. Let one use " +
        agentName +
        "’s private knowledge here; its threads get the same access.",
      "knowledge-muted",
    ),
  );
  const entries = snapshot.grants.entries.filter((g) => g.agent === agentId),
    rows = sessions?.rows ?? [],
    find = (key: string) => rows.find((s) => s.key === key),
    feedback = el("p", "", "knowledge-dialog-feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const disabled = !snapshot.canChange;
  let busy = false;
  const run = async (
    key: string,
    access: GrantChangeInput["access"],
    controls: (HTMLButtonElement | HTMLSelectElement)[],
  ) => {
    if (busy) {
      return;
    }
    busy = true;
    for (const c of controls) {
      c.disabled = true;
    }
    feedback.textContent = "Saving…";
    feedback.className = "knowledge-dialog-feedback knowledge-muted";
    const error = await save(key, access);
    busy = false;
    // On success the caller re-renders; on failure keep the inputs and say why.
    if (error) {
      for (const c of controls) {
        c.disabled = false;
      }
      feedback.textContent = error;
      feedback.className = "knowledge-dialog-feedback knowledge-error";
    }
  };

  const list = el("div", undefined, "knowledge-surface");
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Conversations with access to " + agentName + "’s knowledge");
  if (!entries.length) {
    list.append(el("p", "No conversations have access.", "knowledge-grant-empty knowledge-muted"));
  }
  for (const entry of entries) {
    const row = el("div", undefined, "knowledge-store-row knowledge-grant-row");
    row.setAttribute("role", "listitem");
    const badge = el("span", undefined, "knowledge-store-icon");
    badge.append(icon("users", 14));
    const copy = el("span", undefined, "knowledge-store-copy"),
      titleLine = el("span"),
      known = find(entry.sessionKey),
      name = known?.title ?? entry.sessionKey;
    titleLine.append(el("strong", name));
    if (sessions?.complete && !rows.some((s) => covers(entry.sessionKey, s.key))) {
      titleLine.append(el("span", "No known conversation", "chip knowledge-chip"));
    } else if (known?.archived) {
      titleLine.append(el("span", "Archived", "chip knowledge-chip"));
    }
    copy.append(titleLine);
    if (known) {
      copy.append(el("small", entry.sessionKey, "knowledge-muted knowledge-grant-key"));
    }
    const mode = accessSelect(entry.access, "Access for " + name),
      remove = button("Remove", () => undefined, "knowledge-button knowledge-small");
    remove.setAttribute("aria-label", "Remove access for " + name);
    mode.select.disabled = remove.disabled = disabled;
    mode.select.addEventListener("change", () => {
      // SAFETY: the select's options are exactly the Access values.
      void run(entry.sessionKey, mode.select.value as Access, [mode.select, remove]);
    });
    remove.addEventListener("click", () => {
      void run(entry.sessionKey, "none", [mode.select, remove]);
    });
    const actions = el("span", undefined, "knowledge-grant-actions");
    actions.append(mode.wrap, remove);
    row.append(badge, copy, actions);
    list.append(row);
  }
  root.append(list);

  // Group and channel conversations not yet covered by a grant; threads
  // inherit, so only the outermost conversation of a tree is offered.
  const candidates = rows.filter(
    (s) =>
      !s.archived &&
      !entries.some((g) => covers(g.sessionKey, s.key)) &&
      !rows.some((other) => other.key !== s.key && covers(other.key, s.key)),
  );
  const add = el("div", undefined, "knowledge-grant-add");
  const pickWrap = el("span", undefined, "knowledge-select"),
    pick = el("select");
  pick.setAttribute("aria-label", "Conversation");
  const placeholder = el(
    "option",
    sessions === undefined
      ? "Conversations couldn’t be loaded"
      : candidates.length
        ? "Choose a group or channel…"
        : "No other group or channel conversations",
  );
  placeholder.value = "";
  pick.append(placeholder);
  for (const s of candidates) {
    const option = el("option", s.title);
    option.value = s.key;
    pick.append(option);
  }
  pickWrap.append(pick, icon("chevronDown", 13));
  const mode = accessSelect("read", "Access to grant"),
    grant = button("Grant access", () => undefined, "knowledge-button knowledge-small");
  const sync = () => {
    grant.disabled = disabled || busy || !pick.value;
  };
  pick.disabled = mode.select.disabled = disabled || !candidates.length;
  pick.addEventListener("change", sync);
  grant.addEventListener("click", () => {
    if (pick.value) {
      // SAFETY: the select's options are exactly the Access values.
      void run(pick.value, mode.select.value as Access, [pick, mode.select, grant]);
    }
  });
  sync();
  add.append(pickWrap, mode.wrap, grant);
  root.append(
    add,
    feedback,
    el(
      "p",
      "Saves from a conversation with access are recorded in history like any other. Removing access stops future reads and saves; it can’t remove what the conversation already retrieved.",
      "knowledge-muted",
    ),
  );
  return root;
}

function accessSelect(current: Access, label: string) {
  const wrap = el("span", undefined, "knowledge-select"),
    select = el("select");
  select.setAttribute("aria-label", label);
  for (const [value, text] of ACCESS) {
    const option = el("option", text);
    option.value = value;
    option.title = NOTES[value];
    option.selected = value === current;
    select.append(option);
  }
  wrap.append(select, icon("chevronDown", 13));
  return { wrap, select };
}
