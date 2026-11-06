/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, Show } from "solid-js";
import type { AutofillApprovalSnapshot } from "../approval-contract.js";
import { brandMark } from "./brand-mark.js";
import { mountConnect } from "./connect.js";
import { BrandLogo, Glyph } from "./parts.js";
import "./approval.css";

export type ApprovalSnapshot = AutofillApprovalSnapshot;

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
  const [now, setNow] = createSignal(Date.now());
  let disposed = false;
  let generation = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const current = () => !disposed && !context.signal.aborted;
  const stopTimers = () => {
    clearTimeout(expiry);
    clearTimeout(poll);
    clearInterval(ticker);
  };
  // This observes only the Gateway's owned snapshot. The service alone checks 1Password.
  // Schedule after each answer, never overlap reads, and release everything at final/dispose.
  const refresh = async (action: "get" | "opened" = "get") => {
    if (!current()) {
      return;
    }
    const next = ++generation;
    clearTimeout(poll);
    try {
      const result = await context.host.request("onepassword.autofill.approval", {
        requestId,
        action,
        sessionKey: context.props.sessionKey,
        agentId: context.props.agentId,
      });
      if (!current() || next !== generation) {
        return;
      }
      stopTimers();
      // Validate the executable sink without parsing or rewriting the opaque link.
      if (result.appLink && !result.appLink.startsWith("onepassword://")) {
        setSnapshot({ state: "error" });
        return;
      }
      const time = Date.now();
      setNow(time);
      // Reconcile once at the deadline before resolving the view: an approval may
      // have arrived between the last snapshot and the end of the native prompt.
      if (result.state === "pending" && result.deadline !== undefined && result.deadline <= time) {
        setSnapshot({ ...result, appLink: undefined, state: "expired" });
        return;
      }
      setSnapshot(result);
      if (result.state !== "pending") {
        return;
      }
      const waiting = result.openedAt !== undefined;
      const deadline = waiting ? result.deadline : result.expiresAt;
      if (deadline !== undefined) {
        expiry = setTimeout(
          () => {
            if (!current()) {
              stopTimers();
              return;
            }
            stopTimers();
            if (waiting) {
              setNow(Date.now());
              setSnapshot({ ...result, appLink: undefined, state: "settling" });
              void refresh();
            } else {
              generation++;
              setSnapshot({ ...result, appLink: undefined, state: "unavailable" });
            }
          },
          Math.max(0, deadline - time),
        );
      }
      if (waiting) {
        ticker = setInterval(() => {
          if (!current()) {
            stopTimers();
            return;
          }
          setNow(Date.now());
        }, 1000);
        poll = setTimeout(() => void refresh(), 2000);
      }
    } catch {
      if (current() && next === generation) {
        stopTimers();
        setSnapshot({ state: "error" });
      }
    }
  };
  const waiting = () => snapshot().state === "pending" && snapshot().openedAt !== undefined;
  const active = () =>
    snapshot().state === "pending" ||
    snapshot().state === "loading" ||
    snapshot().state === "settling";
  const approved = () => snapshot().state === "resolved";
  const seconds = () => Math.max(0, Math.ceil(((snapshot().deadline ?? now()) - now()) / 1000));
  const countdown = () =>
    `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, "0")}`;
  const granted = () => snapshot().entries?.filter((entry) => entry.granted) ?? [];
  const outcome = () => {
    if (approved()) {
      return {
        title: granted().length === 1 ? "Sign-in approved" : `${granted().length} logins approved`,
        detail:
          granted().length === 1
            ? `OpenClaw can sign in to ${granted()[0]!.domain}.`
            : "OpenClaw can continue with the logins you selected.",
      };
    }
    switch (snapshot().state) {
      case "denied":
      case "rejected":
        return {
          title: "Sign-in not approved",
          detail: "Nothing was shared. The agent will ask again if it needs this.",
        };
      case "expired":
        return {
          title: "Approval expired",
          detail: "Ask the agent for a new approval request.",
        };
      case "unavailable":
        return {
          title: "Approval link unavailable",
          detail: "Ask the agent for a new approval request.",
        };
      case "failed":
        return {
          title: "Sign-in failed",
          detail: "Ask the agent for a new approval request.",
        };
      default:
        return {
          title: "Couldn’t load approval",
          detail: "Check your connection and owner access. Ask the agent for a new request.",
        };
    }
  };
  // Icons follow the host's stroke vocabulary, owned locally because the SDK exposes no icon component.
  const outcomeIcon = () => {
    switch (snapshot().state) {
      case "resolved":
        return "check";
      case "denied":
      case "rejected":
        return "denied";
      case "expired":
        return "clock";
      case "unavailable":
        return "refresh";
      default:
        return "warning";
    }
  };
  const dispose = render(
    () => (
      <section
        class={[
          "onepassword-approval",
          {
            "onepassword-approval--complete": !active(),
            "onepassword-approval--approved": approved(),
            "onepassword-approval--warning":
              snapshot().state === "failed" || snapshot().state === "error",
          },
        ]}
        aria-label="1Password approval"
      >
        <Show
          when={active()}
          fallback={
            <div class="onepassword-approval__outcome" role="status" aria-live="polite">
              <span class="onepassword-approval__result-icon">
                <Glyph kind={outcomeIcon()} />
              </span>
              <div>
                <h3>{outcome().title}</h3>
                <p>{outcome().detail}</p>
              </div>
              <BrandLogo />
            </div>
          }
        >
          <header class="onepassword-approval__header">
            <h3>Approve sign-in</h3>
          </header>
          <p class="onepassword-approval__goal">
            {snapshot().goal ?? "Choose which logins OpenClaw can use for this task."}
          </p>
          <div class="onepassword-approval__sites">
            <Show when={snapshot().state === "loading"}>
              <div class="onepassword-approval__site" aria-hidden="true">
                <span class="onepassword-approval__site-icon">
                  <Glyph kind="globe" />
                </span>
                <div class="onepassword-approval__skeleton-lines">
                  <span />
                  <span />
                </div>
              </div>
            </Show>
            <For each={snapshot().entries ?? []}>
              {(entry) => (
                <div class="onepassword-approval__site">
                  <span class="onepassword-approval__site-icon">
                    <Glyph kind="globe" />
                  </span>
                  <div>
                    <strong>{entry.domain}</strong>
                    <Show when={entry.reason}>
                      <p>{entry.reason}</p>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
          <Show
            when={snapshot().state !== "loading" && snapshot().state !== "settling"}
            fallback={
              <div class="onepassword-approval__actions">
                <Show
                  when={snapshot().state === "settling"}
                  fallback={
                    <>
                      <div class="onepassword-approval__skeleton-action" aria-hidden="true" />
                      <p class="onepassword-approval__caption" role="status">
                        Preparing approval…
                      </p>
                    </>
                  }
                >
                  <div class="onepassword-approval__settling" role="status" aria-live="polite">
                    <span class="onepassword-approval__pulse" aria-hidden="true" />
                    <div>
                      <strong>Checking your decision</strong>
                      <p>Finishing the approval check.</p>
                    </div>
                  </div>
                </Show>
              </div>
            }
          >
            <Show
              when={waiting()}
              fallback={
                <div class="onepassword-approval__actions">
                  <a
                    class="onepassword-approval__open"
                    href={snapshot().appLink}
                    onClick={() => void refresh("opened")}
                  >
                    <img src={brandMark} alt="" width="24" height="24" />
                    <span>Open 1Password</span>
                    <Glyph kind="arrow" />
                  </a>
                  <p class="onepassword-approval__caption">
                    Approve in the 1Password app on this computer.
                  </p>
                </div>
              }
            >
              <div class="onepassword-approval__waiting">
                <div class="onepassword-approval__waiting-line">
                  <span class="onepassword-approval__pulse" aria-hidden="true" />
                  <strong role="status" aria-live="polite">
                    Waiting for you in 1Password
                  </strong>
                  <span
                    class="onepassword-approval__countdown"
                    aria-label={`${seconds()} seconds remaining`}
                    role="timer"
                  >
                    {countdown()}
                  </span>
                </div>
                <div class="onepassword-approval__waiting-actions">
                  <a href={snapshot().appLink} onClick={() => void refresh("opened")}>
                    Open again
                  </a>
                </div>
                <p class="onepassword-approval__help">
                  Nothing opened? Open this chat on a computer with the 1Password app.
                </p>
              </div>
            </Show>
          </Show>
          <footer class="onepassword-approval__footer">
            <BrandLogo />
          </footer>
        </Show>
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
      stopTimers();
      dispose();
      container.replaceChildren();
    },
  };
}

export default defineControlUiPlugin({
  id: "onepassword",
  activate(host) {
    const disposeApproval = host.ui.registerInlineView({
      id: "approval",
      version: 1,
      mount: mountApproval,
    });
    const disposeConnect = host.ui.registerInlineView({
      id: "connect",
      version: 1,
      mount: mountConnect,
    });
    return () => {
      disposeApproval();
      disposeConnect();
    };
  },
});
