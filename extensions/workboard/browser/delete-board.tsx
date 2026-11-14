/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { action, createMemo, createOptimistic, createSignal, Errored, Loading } from "solid-js";
import { t } from "./i18n/index.ts";
import { formatUiError } from "./lib/format-error.ts";
import { listen } from "./lib/listener.ts";
import { workboardBoardName } from "./lib/workboard/board-presentation.ts";
import type { WorkboardBoardSummary } from "./lib/workboard/types.ts";

export function deleteWorkboardBoard(
  host: ControlUiHost,
  board: Pick<WorkboardBoardSummary, "id" | "name">,
  onDeleted: () => void,
): Promise<void> {
  if (host.signal.aborted || !host.connection.canWrite) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const container = document.createElement("div");
    const content = document.createElement("div");
    const title = t("workboard.deleteBoardTitle", { name: workboardBoardName(board) });
    let busy = false;
    let closed = false;
    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      stopAbort();
      dialog.dispose();
      disposeRoot();
      container.remove();
      resolve();
    };
    const disposeRoot = render(() => {
      const [saving, setSaving] = createOptimistic(false);
      const [completion, setCompletion] = createSignal<Promise<void>>();
      const completed = createMemo(() => completion()?.then(() => null) ?? null);
      const presentSaving = action(function* (pending: Promise<void>) {
        setSaving(true);
        yield pending;
      });
      const remove = async () => {
        busy = true;
        try {
          if (!host.connection.connected || !host.connection.canWrite) {
            throw new Error(t("workboard.deleteBoardUnavailable"));
          }
          await host.request("workboard.boards.delete", { id: board.id });
          if (!closed) {
            onDeleted();
            finish();
          }
        } finally {
          busy = false;
        }
      };
      const submit = async () => {
        if (busy || closed) {
          return;
        }
        const pending = remove();
        // The host can close the dialog before the admitted write settles.
        void pending.catch(() => undefined);
        void setCompletion(pending);
        // Clear the previous error before saving holds its own presentation.
        await Promise.resolve();
        if (!closed) {
          await presentSaving(pending).catch(() => undefined);
        }
      };
      return (
        <div class="exec-approval-card">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">{title}</div>
              <div class="exec-approval-sub">{t("workboard.deleteBoardHelp")}</div>
            </div>
          </div>
          <Loading on={completion()}>
            <Errored fallback={(error) => <div role="alert">{formatUiError(error())}</div>}>
              {completed()}
            </Errored>
          </Loading>
          <openclaw-modal-actions class="exec-approval-actions">
            <button
              class="btn danger"
              type="button"
              disabled={saving()}
              onClick={() => void submit()}
            >
              {t("workboard.deleteBoardConfirm")}
            </button>
            <button class="btn" type="button" autofocus disabled={saving()} onClick={finish}>
              {t("common.cancel")}
            </button>
          </openclaw-modal-actions>
        </div>
      );
    }, content);
    document.body.append(container);
    const dialog = host.components.mountDialog(container, {
      label: title,
      description: t("workboard.deleteBoardHelp"),
      content,
      onCancel: () => (busy ? false : finish()),
    });
    const stopAbort = listen(host.signal, "abort", finish, { once: true });
  });
}
