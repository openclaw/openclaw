/** Bringing scribe automations up to date: the update on load, and Replace with new. */
import type { Page } from "./page-context.js";
import { button, el } from "./page-dom.js";
import { changedLines, openConfirmDialog } from "./scribe-dialog.js";
import { needsUpdate, updateScribe } from "./scribes-actions.js";
import type { ScribeJob, ScribeSnapshot } from "./scribes-state.js";

/**
 * Per Gateway, by its Control UI base path (the page gets a new host on every reconnect): the
 * automation revisions an update was already tried for, so a failing one is tried once per
 * revision rather than on every reload.
 */
const tried = new Map<string, Set<string>>();

/**
 * Bring a scribe's automation up to date with this version of Knowledge: an administrator's
 * automation in its conversation, each run in a fresh session, and an unedited run message from
 * an earlier version replaced. The Scribes page owns this because it is where an administrator
 * manages scribe automations. Answers whether it wrote anything.
 */
export async function update(
  ui: Page,
  snapshot: ScribeSnapshot,
  agentId: string,
  /** The viewing administrator's profile id, when the Gateway reports it. */
  viewer: string | undefined,
) {
  const { job } = snapshot;
  const gateway = ui.s.context.host.basePath;
  const revisions = tried.get(gateway) ?? new Set<string>();
  tried.set(gateway, revisions);
  const revision = job && `${job.id}:${job.configRevision ?? ""}`;
  if (!job || !revision || revisions.has(revision) || !needsUpdate(snapshot, viewer)) {
    return false;
  }
  revisions.add(revision);
  try {
    await updateScribe(ui.s.context.host, snapshot, job, agentId);
    ui.announce(`${snapshot.scribe.title}: updated for this version of Knowledge.`);
    return true;
  } catch (error) {
    ui.announce(
      `${snapshot.scribe.title}: the update failed. ${ui.errorText(error)} If its automation is gone, set it up again from Scribes.`,
    );
    return false;
  }
}

/**
 * The notice for a run message that differs from what this version generates and still carries
 * replaced wording: it is kept until the owner replaces it with the new one.
 */
export function updateNotice(
  ui: Page,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
  next: string,
) {
  const { scribe } = snapshot;
  const notice = el("div", undefined, "knowledge-notice scribe-update");
  notice.append(
    el(
      "span",
      `New run instructions available. The saved run message for ${scribe.title} differs from what this version of Knowledge generates, so it was kept.`,
    ),
  );
  const diff = el("pre", undefined, "scribe-prompt-text scribe-update-message");
  for (const line of changedLines(job.payload?.message ?? "", next)) {
    const removed = line.kind === "removed";
    diff.append(
      el(
        removed ? "del" : "ins",
        `${removed ? "−" : "+"} ${line.text}\n`,
        removed ? "scribe-diff-removed" : "scribe-diff-added",
      ),
    );
  }
  const replace = button(
    "Replace with new…",
    () => {
      openConfirmDialog(
        "Replace with the new run instructions?",
        `Later runs of ${scribe.title} follow the new run message. These lines change; the saved message is not kept.`,
        "Replace with new",
        async () => {
          await updateScribe(ui.s.context.host, snapshot, job, agentId, { runMessage: next });
          ui.announce(`${scribe.title}: run message replaced.`);
          void ui.load();
        },
        diff,
      );
    },
    "knowledge-button knowledge-small",
  );
  replace.disabled = !ui.s.context.host.connection.canAdmin;
  notice.append(replace);
  return notice;
}
