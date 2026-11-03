/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, For, Show } from "solid-js";
import type { AutofillApprovalSnapshot } from "../src/autofill-contract.js";
import { brandLogoDark, brandLogoLight, brandMark } from "./brand-mark.js";
import "./approval.css";

export type ApprovalSnapshot = AutofillApprovalSnapshot;

type ApprovalContext = Parameters<
  Parameters<ControlUiHost["ui"]["registerInlineView"]>[0]["mount"]
>[1];

/** A quiet, theme-native glyph; the 1Password mark itself is never altered. */
function Glyph(props: { kind: "globe" | "check" | "clock" | "lock" | "arrow" }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show when={props.kind === "globe"}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" />
      </Show>
      <Show when={props.kind === "check"}>
        <path d="m6 12 4 4 8-8" />
      </Show>
      <Show when={props.kind === "clock"}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </Show>
      <Show when={props.kind === "lock"}>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </Show>
      <Show when={props.kind === "arrow"}>
        <path d="M5 12h14m-5-5 5 5-5 5" />
      </Show>
    </svg>
  );
}

/** Use the supplied light/dark primary logos, not a recolored or reconstructed wordmark. */
function BrandLogo() {
  return (
    <span class="onepassword-approval__logo" role="img" aria-label="1Password">
      <img class="onepassword-approval__logo-light" src={brandLogoLight} alt="" />
      <img class="onepassword-approval__logo-dark" src={brandLogoDark} alt="" />
    </span>
  );
}

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
  const unavailableHere = () => {
    // A browser cannot reliably detect an installed protocol handler. Let the
    // person report it rather than guessing from focus loss or a navigation timer.
    stopTimers();
    generation++;
    setSnapshot({ ...snapshot(), appLink: undefined, state: "device_unavailable" });
  };
  const waiting = () => snapshot().state === "pending" && snapshot().openedAt !== undefined;
  const active = () => snapshot().state === "pending" || snapshot().state === "loading";
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
      case "settling":
        return {
          title: "Checking your decision",
          detail: "The 1Password prompt has closed. Finishing the approval check.",
        };
      case "denied":
      case "rejected":
        return {
          title: "You’re in control. Sign-in wasn’t approved.",
          detail: "Nothing was shared. The agent will ask again if needed.",
        };
      case "expired":
        return {
          title: "The approval window closed",
          detail: "The prompt has timed out. Ask the agent for a new request.",
        };
      case "unavailable":
        return {
          title: "This approval link is no longer available",
          detail: "It may have expired or the Gateway restarted. Ask the agent for a new request.",
        };
      case "failed":
        return {
          title: "Sign-in didn’t go through",
          detail: "Ask the agent to try a new approval request when you’re ready.",
        };
      case "device_unavailable":
        return {
          title: "Open this on a computer with 1Password",
          detail:
            "Approval needs the 1Password app on this computer. The agent can ask again when you’re ready.",
        };
      default:
        return {
          title: "We couldn’t load this approval",
          detail: "Check your connection and owner access. Ask the agent for a new request.",
        };
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
          },
        ]}
        aria-label="1Password approval"
      >
        <Show
          when={active()}
          fallback={
            <div class="onepassword-approval__outcome" role="status" aria-live="polite">
              <span class="onepassword-approval__result-icon">
                <Glyph kind={approved() ? "check" : "clock"} />
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
            <div class="onepassword-approval__mark">
              <img src={brandMark} alt="" width="44" height="44" />
            </div>
            <div class="onepassword-approval__heading">
              <span class="onepassword-approval__eyebrow">1Password</span>
              <h3>Approve sign-in</h3>
            </div>
            <span class="onepassword-approval__private" title="Passwords stay in 1Password">
              <Glyph kind="lock" />
            </span>
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
            when={snapshot().state !== "loading"}
            fallback={
              <div class="onepassword-approval__actions">
                <div class="onepassword-approval__skeleton-action" aria-hidden="true" />
                <p class="onepassword-approval__caption" role="status">
                  Preparing your private approval…
                </p>
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
                <div class="onepassword-approval__waiting-detail">
                  <span>The prompt closes after 2 minutes.</span>
                  <a href={snapshot().appLink} onClick={() => void refresh("opened")}>
                    Open again
                  </a>
                </div>
                <button
                  class="onepassword-approval__device-help"
                  type="button"
                  onClick={unavailableHere}
                >
                  1Password isn’t on this computer
                </button>
              </div>
            </Show>
          </Show>
          <footer class="onepassword-approval__footer">
            <BrandLogo />
            <span>Passwords never appear in chat.</span>
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
    return host.ui.registerInlineView({ id: "approval", version: 1, mount: mountApproval });
  },
});
