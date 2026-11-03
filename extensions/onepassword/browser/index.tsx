/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";

export type ApprovalSnapshot = {
  state: string;
  appLink?: string;
  expiresAt?: number;
  guidance?: string;
};

type ApprovalContext = Parameters<
  Parameters<ControlUiHost["ui"]["registerInlineView"]>[0]["mount"]
>[1];

/** Hydrate only in the authenticated viewer; the transcript carries just a request id. */
export function mountApproval(
  container: HTMLElement,
  context: Pick<ApprovalContext, "props" | "signal"> & {
    host: { request(method: string, params?: Record<string, unknown>): Promise<ApprovalSnapshot> };
  },
) {
  const payload = context.props.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.requestId !== "string"
  ) {
    throw new Error("Unsupported 1Password approval reference.");
  }
  const requestId = payload.requestId;
  const [snapshot, setSnapshot] = createSignal<ApprovalSnapshot>({ state: "loading" });
  let disposed = false;
  let generation = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (action: "get" | "opened" = "get") => {
    const current = ++generation;
    try {
      const result = await context.host.request("onepassword.autofill.approval", {
        requestId,
        action,
        sessionKey: context.props.sessionKey,
        agentId: context.props.agentId,
      });
      if (disposed || context.signal.aborted || current !== generation) {
        return;
      }
      clearTimeout(expiry);
      // Validate the executable sink without parsing or rewriting the opaque link.
      if (result.appLink && !result.appLink.startsWith("onepassword://")) {
        setSnapshot({ state: "error" });
        return;
      }
      setSnapshot(result);
      if (result.expiresAt) {
        expiry = setTimeout(
          () => setSnapshot({ state: "unavailable" }),
          Math.max(0, result.expiresAt - Date.now()),
        );
      }
    } catch {
      if (!disposed && !context.signal.aborted && current === generation) {
        setSnapshot({ state: "error" });
      }
    }
  };
  const opened = () => {
    // The native handler opens the fetched URL; the RPC response then retires it.
    void refresh("opened");
  };
  const dispose = render(
    () => (
      <section class="onepassword-approval card" aria-label="1Password approval">
        <h3>1Password approval</h3>
        <p role="status">{snapshot().state}</p>
        <div style={{ "min-height": "40px" }}>
          <Show when={snapshot().appLink}>
            <a class="btn primary" href={snapshot().appLink} onClick={opened}>
              Approve in 1Password
            </a>
          </Show>
        </div>
        <p>Opens the 1Password app on this computer; the prompt closes after 2 minutes.</p>
        <p>
          {snapshot().guidance ??
            (snapshot().state === "unavailable"
              ? "This private link expired or the Gateway restarted. Ask the agent for a new approval request."
              : snapshot().state === "error"
                ? "Approval is unavailable for this viewer. Check your connection and owner access, then refresh."
                : "After approving, refresh status. No passwords are shown in chat.")}
        </p>
        <button class="btn btn--sm" type="button" onClick={() => void refresh()}>
          Refresh status
        </button>
      </section>
    ),
    container,
  );
  void refresh();
  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      generation++;
      clearTimeout(expiry);
      setSnapshot({ state: "unavailable" });
      dispose();
      container.replaceChildren();
    },
  };
}

export default defineControlUiPlugin({
  id: "onepassword",
  activate(host) {
    return host.ui.registerInlineView({ id: "approval", version: 1, mount: mountApproval });
  },
});
