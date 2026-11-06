/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import type { AutofillConnectSnapshot } from "../approval-contract.js";
import { brandMark } from "./brand-mark.js";
import { BrandLogo, Glyph, type GlyphKind } from "./parts.js";

export type ConnectSnapshot = AutofillConnectSnapshot;

type ConnectContext = Parameters<
  Parameters<ControlUiHost["ui"]["registerInlineView"]>[0]["mount"]
>[1];

const connectOrigin = "https://connect.openclaw.ai/1password/start/";

function failureDetail(code: string | undefined): string {
  switch (code) {
    case "connectCheckStopped":
      return "The connection check stopped. Ask the agent to check the connection before trying again.";
    case "disconnectExistingConnectionFirst":
      return "Another 1Password account is already connected. Disconnect it first, then connect again.";
    case "connectionMismatch":
    case "invalidIntegrationKey":
    case "integrationKeyMissingReconnect":
      return "1Password didn’t finish linking this account. Ask the agent to connect again.";
    default:
      return "Nothing was connected. Ask the agent to connect again if you want to.";
  }
}

/** Hydrate only in the authenticated viewer; the transcript carries just a connect session id. */
export function mountConnect(
  container: HTMLElement,
  context: Pick<ConnectContext, "props" | "signal"> & {
    host: { request(method: string, params?: Record<string, unknown>): Promise<ConnectSnapshot> };
  },
) {
  const payload = context.props.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    typeof payload.sessionId !== "string"
  ) {
    throw new Error("Unsupported 1Password connect reference.");
  }
  const sessionId = payload.sessionId;
  const [snapshot, setSnapshot] = createSignal<ConnectSnapshot>({ state: "loading" });
  const [now, setNow] = createSignal(Date.now());
  let disposed = false;
  let generation = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const current = () => !disposed && !context.signal.aborted;
  const stopTimers = () => {
    clearTimeout(poll);
    clearInterval(ticker);
  };
  // Reads only the Gateway's snapshot; its service-owned checker alone talks to the relay.
  const refresh = async (action: "get" | "opened" = "get") => {
    if (!current()) {
      return;
    }
    const next = ++generation;
    stopTimers();
    try {
      const result = await context.host.request("onepassword.autofill.connectView", {
        sessionId,
        action,
        sessionKey: context.props.sessionKey,
        agentId: context.props.agentId,
      });
      if (!current() || next !== generation) {
        return;
      }
      if (result.connectUrl && !result.connectUrl.startsWith(connectOrigin)) {
        setSnapshot({ state: "error" });
        return;
      }
      setNow(Date.now());
      setSnapshot(result);
      if (result.state !== "pending") {
        return;
      }
      ticker = setInterval(() => {
        if (!current()) {
          stopTimers();
          return;
        }
        setNow(Date.now());
        if ((snapshot().expiresAt ?? Infinity) <= Date.now()) {
          void refresh();
        }
      }, 1000);
      if (result.openedAt !== undefined) {
        poll = setTimeout(() => void refresh(), 2000);
      }
    } catch {
      if (current() && next === generation) {
        setSnapshot({ state: "error" });
      }
    }
  };
  const active = () => snapshot().state === "pending" || snapshot().state === "loading";
  const waiting = () => snapshot().state === "pending" && snapshot().openedAt !== undefined;
  const seconds = () => Math.max(0, Math.ceil(((snapshot().expiresAt ?? now()) - now()) / 1000));
  const countdown = () =>
    `${Math.floor(seconds() / 60)}:${String(seconds() % 60).padStart(2, "0")}`;
  const outcome = (): { icon: GlyphKind; title: string; detail: string } => {
    switch (snapshot().state) {
      case "connected":
        return { icon: "check", title: "1Password connected", detail: "The agent will continue." };
      case "failed":
        return {
          icon: "denied",
          title:
            snapshot().code === "connectCheckStopped"
              ? "Connection not confirmed"
              : "Not connected",
          detail: failureDetail(snapshot().code),
        };
      case "expired":
        return {
          icon: "clock",
          title: "Connect link expired",
          detail: "Ask the agent to connect again.",
        };
      case "unavailable":
        return {
          icon: "refresh",
          title: "Connect link unavailable",
          detail: "Ask the agent to connect again.",
        };
      default:
        return {
          icon: "warning",
          title: "Couldn’t load the connect link",
          detail: "Check your connection and owner access, then ask the agent to connect again.",
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
            "onepassword-approval--approved": snapshot().state === "connected",
            "onepassword-approval--warning":
              snapshot().state === "failed" || snapshot().state === "error",
          },
        ]}
        aria-label="Connect 1Password"
      >
        <Show
          when={active()}
          fallback={
            <div class="onepassword-approval__outcome" role="status" aria-live="polite">
              <span class="onepassword-approval__result-icon">
                <Glyph kind={outcome().icon} />
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
            <h3>Connect 1Password</h3>
          </header>
          <p class="onepassword-approval__goal">
            Lets OpenClaw ask for specific logins when a task needs them. Passwords stay in
            1Password.
          </p>
          <div class="onepassword-approval__sites">
            <div class="onepassword-approval__site">
              <span class="onepassword-approval__site-icon">
                <Glyph kind="shield" />
              </span>
              <Show
                when={snapshot().confirmationCode}
                fallback={
                  <div class="onepassword-approval__skeleton-lines" aria-hidden="true">
                    <span />
                    <span />
                  </div>
                }
              >
                <div>
                  <p>Confirmation code</p>
                  <strong class="onepassword-approval__code">{snapshot().confirmationCode}</strong>
                </div>
              </Show>
            </div>
          </div>
          <Show
            when={snapshot().state === "pending"}
            fallback={
              <div class="onepassword-approval__actions">
                <div class="onepassword-approval__skeleton-action" aria-hidden="true" />
                <p class="onepassword-approval__caption" role="status">
                  Preparing connect link…
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
                    href={snapshot().connectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => void refresh("opened")}
                  >
                    <img src={brandMark} alt="" width="24" height="24" />
                    <span>Continue to 1Password</span>
                    <Glyph kind="arrow" />
                  </a>
                  <p class="onepassword-approval__caption">
                    Check that the page shows this code, then approve.
                  </p>
                </div>
              }
            >
              <div class="onepassword-approval__waiting">
                <div class="onepassword-approval__waiting-line">
                  <span class="onepassword-approval__pulse" aria-hidden="true" />
                  <strong role="status" aria-live="polite">
                    Waiting for you to approve
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
                  <a href={snapshot().connectUrl} target="_blank" rel="noopener noreferrer">
                    Open again
                  </a>
                </div>
                <p class="onepassword-approval__help">
                  Finish in the tab that opened. Approve only if it shows this code.
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
