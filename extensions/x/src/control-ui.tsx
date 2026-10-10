/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import { defineControlUiPlugin, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { createStore, For } from "solid-js";
import type { XAllowlistSnapshot } from "./admin.js";
import "./control-ui.css";

type RepliesState = {
  accountId: string | undefined;
  snapshot: XAllowlistSnapshot | undefined;
  github: XAllowlistSnapshot["verifiedFromGitHub"];
  username: string;
  busy: boolean;
  error: string;
  notice: string;
  connected: boolean;
  canAdmin: boolean;
};

const mountXReplies: ControlUiView = (container, initialContext) => {
  const host = initialContext.host;
  let context = initialContext;
  let accountId: string | undefined;
  let snapshot: XAllowlistSnapshot | undefined;
  let username = "";
  let busy = false;
  let error = "";
  let notice = "";
  let generation = 0;
  let disposed = false;
  let available = false;
  // Request authority stays synchronous; the store only publishes presentation.
  const [view, setView] = createStore<RepliesState>({
    accountId,
    snapshot,
    github: undefined,
    username,
    busy,
    error,
    notice,
    connected: host.connection.connected,
    canAdmin: host.connection.canAdmin,
  });
  const canManage = () => host.connection.connected && host.connection.canAdmin;
  const usd = new Intl.NumberFormat(host.locale, {
    style: "currency",
    currency: "USD",
  });
  const dateTime = new Intl.DateTimeFormat(host.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const isCurrent = (id: number) =>
    !disposed && !context.signal.aborted && generation === id && canManage();

  async function request(method: string, params: Record<string, unknown> = {}) {
    if (busy || !canManage()) {
      return;
    }
    const id = ++generation;
    const selectedAccount = accountId;
    busy = true;
    error = "";
    notice = "";
    publish();
    try {
      const result = await host.request<XAllowlistSnapshot>(method, {
        ...(selectedAccount ? { accountId: selectedAccount } : {}),
        ...params,
      });
      if (!isCurrent(id)) {
        return;
      }
      snapshot = result;
      accountId = result.accountId;
      if (method === "x.allowlist.add") {
        username = "";
        notice = "Account added. Its mentions can now receive replies.";
      } else if (method === "x.allowlist.remove") {
        notice = "Stored entry removed. Any other allowlist source still applies.";
      } else if (method === "x.guests.set") {
        notice = result.guests.enabled
          ? result.guests.blockedReason
            ? "Guest mode is on. Complete the setup below before guests can receive replies."
            : "Guest mode is on. Guest replies use the configured repository restrictions and limits."
          : "Guest mode is off. Only maintainers can receive replies.";
      }
    } catch (cause) {
      if (isCurrent(id)) {
        error = host.redact(
          cause instanceof Error ? cause.message : "The request failed. Try again.",
        );
      }
    } finally {
      if (isCurrent(id)) {
        busy = false;
        publish();
      }
    }
  }

  function XReplies() {
    return (
      <section class="x-replies" aria-labelledby="x-replies-title">
        <header class="x-replies__header">
          <div>
            <h1 id="x-replies-title">X replies</h1>
            <p>Choose whose mentions the bot can answer publicly.</p>
          </div>
          <button
            class="btn"
            type="button"
            disabled={view.busy || !view.connected || !view.canAdmin}
            onClick={() => void request("x.allowlist.list")}
          >
            Refresh
          </button>
        </header>
        {!view.connected ? (
          <p role="status">Connect to the Gateway to manage X replies.</p>
        ) : !view.canAdmin ? (
          <p role="status">Administrator access is required to manage X replies.</p>
        ) : (
          <>
            <div class="x-replies__controls">
              <label class="x-replies__field">
                <span>Bot account</span>
                <select
                  value={view.accountId ?? ""}
                  disabled={view.busy || !view.snapshot}
                  onChange={(event: Event) => {
                    if (!(event.currentTarget instanceof HTMLSelectElement)) {
                      return;
                    }
                    accountId = event.currentTarget.value;
                    snapshot = undefined;
                    void request("x.allowlist.list");
                  }}
                >
                  {view.snapshot ? (
                    <For each={view.snapshot.accounts} keyed={(row) => row.accountId}>
                      {(account) => (
                        <option
                          value={account().accountId}
                          selected={account().accountId === view.accountId}
                        >
                          {account().username ? `@${account().username}` : account().accountId} (
                          {account().accountId})
                        </option>
                      )}
                    </For>
                  ) : (
                    <option value={view.accountId ?? ""}>
                      {view.accountId ?? "Select an account"}
                    </option>
                  )}
                </select>
              </label>
              <form
                class="x-replies__add"
                onSubmit={(event: Event) => {
                  event.preventDefault();
                  void request("x.allowlist.add", { username });
                }}
              >
                <label class="x-replies__field">
                  <span>Add by X handle</span>
                  <input
                    name="username"
                    autocomplete="off"
                    placeholder="@handle"
                    maxlength="16"
                    required
                    value={view.username}
                    disabled={view.busy}
                    onInput={(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        username = event.currentTarget.value;
                        publish();
                      }
                    }}
                  />
                </label>
                <button class="btn primary" type="submit" disabled={view.busy}>
                  Add account
                </button>
              </form>
            </div>
            <p class="x-replies__hint">
              Handle lookup costs $0.01. Config entries are read-only here.
            </p>
            {view.error ? (
              <p class="x-replies__error" role="alert">
                {view.error}
              </p>
            ) : null}
            <div aria-live="polite">
              {view.busy ? <p>Updating X replies…</p> : view.notice ? <p>{view.notice}</p> : null}
            </div>
            {view.snapshot ? (
              <>
                <section class="x-replies__guests" aria-labelledby="x-guests-title">
                  <div class="x-replies__guest-header">
                    <div>
                      <h2 id="x-guests-title">Guest mode</h2>
                      <p>Let anyone ask questions about the OpenClaw repository.</p>
                    </div>
                    <button
                      class="x-replies__switch"
                      type="button"
                      role="switch"
                      aria-label="Guest mode"
                      aria-checked={view.snapshot.guests.enabled ? "true" : "false"}
                      disabled={view.busy}
                      onClick={() =>
                        void request("x.guests.set", { enabled: !view.snapshot?.guests.enabled })
                      }
                    >
                      <span class="x-replies__switch-track" aria-hidden="true"></span>
                      <span>{view.snapshot.guests.enabled ? "On" : "Off"}</span>
                    </button>
                  </div>
                  <dl class="x-replies__guest-counts">
                    <div>
                      <dt>Per guest, per UTC day</dt>
                      <dd>{view.snapshot.guests.maxMentionsPerAuthorPerDay} mentions</dd>
                    </div>
                    <div>
                      <dt>Admitted today</dt>
                      <dd>{view.snapshot.guests.admittedToday}</dd>
                    </div>
                    <div>
                      <dt>Rate-limited today</dt>
                      <dd>{view.snapshot.guests.rateLimitedToday}</dd>
                    </div>
                  </dl>
                  <p class="x-replies__hint">
                    {view.snapshot.guests.helpersAvailable ? (
                      <>
                        Applies to the selected bot account. Guests get repository answers with
                        hidden helpers of the same agent. No writes, commands, visible work
                        sessions, or other agents. Maintainers keep their normal access.
                      </>
                    ) : (
                      <>
                        Applies to the selected bot account. Guests can read the repository without
                        starting helpers. Upgrade OpenClaw to enable hidden helpers safely.
                        Maintainers keep their normal access.
                      </>
                    )}{" "}
                    <a
                      href="https://docs.openclaw.ai/channels/x#guest-mode"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Guest setup and limits
                    </a>
                  </p>
                  {view.snapshot.guests.blockedReason ? (
                    <p class="x-replies__error" role="alert">
                      {view.snapshot.guests.blockedReason}
                    </p>
                  ) : null}
                </section>
                <dl class="x-replies__spend" aria-label="X API spend">
                  <div>
                    <dt>Today (UTC)</dt>
                    <dd>
                      <strong>{usd.format(view.snapshot.spend.dayUsd)}</strong>
                      <span> / {usd.format(view.snapshot.spend.dailyLimitUsd)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Billing cycle since {view.snapshot.spend.cycleStart}</dt>
                    <dd>
                      <strong>{usd.format(view.snapshot.spend.cycleUsd)}</strong>
                      <span> / {usd.format(view.snapshot.spend.monthlyLimitUsd)}</span>
                    </dd>
                  </div>
                </dl>
                {view.snapshot.spend.exhaustedUntil ? (
                  <p class="x-replies__budget" role="status">
                    X API budget reached. Paid requests resume at{" "}
                    <time datetime={view.snapshot.spend.exhaustedUntil}>
                      {view.snapshot.spend.exhaustedUntil}
                    </time>
                    .
                  </p>
                ) : null}
                <div class="x-replies__list" aria-busy={view.busy ? "true" : "false"}>
                  {view.snapshot.entries.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Source</th>
                          <th>Added by</th>
                          <th>
                            <span class="x-replies__sr-only">Actions</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={view.snapshot.entries} keyed={(row) => row.userId}>
                          {(entry) => (
                            <tr>
                              <td>
                                <strong>
                                  {entry().username ? `@${entry().username}` : entry().userId}
                                </strong>
                                {entry().name ? <span>{entry().name}</span> : null}
                                {entry().username ? <small>{entry().userId}</small> : null}
                              </td>
                              <td>
                                {entry().configured
                                  ? entry().editable
                                    ? "Config + stored"
                                    : "Config"
                                  : "Stored"}
                              </td>
                              <td>{entry().addedBy ?? "—"}</td>
                              <td>
                                {entry().editable ? (
                                  <button
                                    class="btn"
                                    type="button"
                                    aria-label={`Remove stored entry for ${entry().username ? `@${entry().username}` : entry().userId}`}
                                    disabled={view.busy}
                                    onClick={() =>
                                      void request("x.allowlist.remove", {
                                        userId: entry().userId,
                                      })
                                    }
                                  >
                                    Remove
                                  </button>
                                ) : (
                                  <span class="x-replies__hint">Read-only</span>
                                )}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  ) : (
                    <p class="x-replies__empty">
                      No manual entries yet. Add a maintainer above or set <code>allowFrom</code> in
                      config.
                    </p>
                  )}
                </div>
                {view.github ? (
                  <section class="x-replies__github" aria-labelledby="x-github-title">
                    <h2 id="x-github-title">From GitHub</h2>
                    <p>
                      Verified through{" "}
                      <a
                        href={`https://github.com/${view.github.repo}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {view.github.repo}
                      </a>
                      . To enable yourself, add your X handle to your GitHub profile.{" "}
                      <a
                        href="https://docs.openclaw.ai/channels/x#enable-yourself"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Profile setup
                      </a>
                    </p>
                    <p class="x-replies__hint" role="status">
                      {view.github.stale ? "Sync is stale. " : ""}
                      {view.github.lastSyncAt !== undefined ? (
                        <>
                          Last successful sync:{" "}
                          <time datetime={new Date(view.github.lastSyncAt).toISOString()}>
                            {dateTime.format(view.github.lastSyncAt)}
                          </time>
                          . {view.github.stale ? "The last good set remains active. " : ""}
                        </>
                      ) : (
                        "No successful sync yet."
                      )}
                      Entries update automatically and are read-only here.
                    </p>
                    {view.github.message ? (
                      <p class="x-replies__error" role="alert">
                        {host.redact(view.github.message)}
                      </p>
                    ) : null}
                    {view.github.unresolvedHandles.length ? (
                      <p class="x-replies__hint">
                        Could not resolve on X:{" "}
                        {view.github.unresolvedHandles.map((handle) => `@${handle}`).join(", ")}.
                        Check the declared profiles.
                      </p>
                    ) : null}
                    <div class="x-replies__list">
                      {view.github.entries.length ? (
                        <table>
                          <thead>
                            <tr>
                              <th>X account</th>
                              <th>GitHub account</th>
                              <th>Permission</th>
                              <th>Last sync</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={view.github.entries} keyed={(row) => row.xUserId}>
                              {(entry) => (
                                <tr>
                                  <td>
                                    <strong>@{entry().xHandle}</strong>
                                    <small>{entry().xUserId}</small>
                                  </td>
                                  <td>
                                    <a
                                      href={`https://github.com/${encodeURIComponent(entry().githubLogin)}`}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      @{entry().githubLogin}
                                    </a>
                                  </td>
                                  <td>{entry().permission}</td>
                                  <td>
                                    <time datetime={new Date(entry().syncedAt).toISOString()}>
                                      {dateTime.format(entry().syncedAt)}
                                    </time>
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      ) : (
                        <p class="x-replies__empty">No GitHub-derived accounts yet.</p>
                      )}
                    </div>
                  </section>
                ) : null}
                <p class="x-replies__hint">
                  {view.snapshot.guests.enabled
                    ? view.snapshot.guests.blockedReason
                      ? "Guest replies are blocked until the setup above is complete."
                      : "Allowlisted users are maintainers. Other users receive limited guest replies."
                    : "Guest mode is off. Only allowlisted maintainers receive replies."}
                </p>
              </>
            ) : null}
          </>
        )}
      </section>
    );
  }

  function publish() {
    if (!disposed) {
      setView(() => ({
        accountId,
        snapshot,
        github: snapshot?.verifiedFromGitHub,
        username,
        busy,
        error,
        notice,
        connected: host.connection.connected,
        canAdmin: host.connection.canAdmin,
      }));
    }
  }

  function sync() {
    const next = canManage() && context.presented;
    if (next !== available) {
      available = next;
      generation += 1;
      busy = false;
      snapshot = undefined;
      error = "";
      notice = "";
      if (next) {
        void request("x.allowlist.list");
        return;
      }
    }
    publish();
  }
  const disposeRoot = render(() => <XReplies />, container);
  const unsubscribe = host.subscribe(sync);
  sync();
  return {
    update(next) {
      context = next;
      sync();
    },
    dispose() {
      disposed = true;
      generation += 1;
      unsubscribe();
      disposeRoot();
    },
  };
};

export default defineControlUiPlugin({
  id: "x",
  activate(host) {
    const disposePage = host.ui.registerPage({
      id: "replies",
      label: "X replies",
      mount: mountXReplies,
    });
    const disposeNavigation = host.ui.registerNavigation({
      id: "replies",
      label: "X replies",
      page: { id: "replies" },
      icon: "at-sign",
      order: 40,
    });
    return () => {
      disposeNavigation();
      disposePage();
    };
  },
});
