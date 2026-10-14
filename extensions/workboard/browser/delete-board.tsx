/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal } from "solid-js";
import { t } from "./i18n/index.ts";
import { formatUiError } from "./lib/format-error.ts";
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
    let error = "";
    let closed = false;
    const [view, setView] = createSignal({ busy, error });
    const update = () => setView({ busy, error });
    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      host.signal.removeEventListener("abort", finish);
      dialog.dispose();
      disposeRoot();
      container.remove();
      resolve();
    };
    const remove = async () => {
      if (busy || closed) {
        return;
      }
      busy = true;
      error = "";
      update();
      try {
        if (!host.connection.connected || !host.connection.canWrite) {
          throw new Error(t("workboard.deleteBoardUnavailable"));
        }
        await host.request("workboard.boards.delete", { id: board.id });
        if (!closed) {
          onDeleted();
          finish();
        }
      } catch (cause) {
        if (!closed) {
          busy = false;
          error = formatUiError(cause);
          update();
        }
      }
    };
    const disposeRoot = render(
      () => (
        <div class="exec-approval-card">
          <div class="exec-approval-header">
            <div>
              <div class="exec-approval-title">{title}</div>
              <div class="exec-approval-sub">{t("workboard.deleteBoardHelp")}</div>
            </div>
          </div>
          {view().error ? <div role="alert">{view().error}</div> : null}
          <div class="exec-approval-actions">
            <button
              class="btn danger"
              type="button"
              disabled={view().busy}
              onClick={() => {
                void remove();
              }}
            >
              {t("workboard.deleteBoardConfirm")}
            </button>
            <button class="btn" type="button" autofocus disabled={view().busy} onClick={finish}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ),
      content,
    );
    document.body.append(container);
    update();
    const dialog = host.components.mountDialog(container, {
      label: title,
      description: t("workboard.deleteBoardHelp"),
      content,
      onCancel: () => (busy ? false : finish()),
    });
    host.signal.addEventListener("abort", finish, { once: true });
  });
}
