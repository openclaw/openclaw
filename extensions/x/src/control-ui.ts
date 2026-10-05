import { html, nothing, render } from "lit";
import { defineControlUiPlugin, type ControlUiView } from "openclaw/plugin-sdk/control-ui";
import type { XAllowlistSnapshot } from "./admin.js";
import "./control-ui.css";

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
  const canManage = () => host.connection.connected && host.connection.canAdmin;
  const usd = new Intl.NumberFormat(host.locale, {
    style: "currency",
    currency: "USD",
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
    draw();
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
        notice = "Stored entry removed. Any config entry still applies.";
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
        draw();
      }
    }
  }

  function draw() {
    if (disposed) {
      return;
    }
    render(
      html`
        <section class="x-replies" aria-labelledby="x-replies-title">
          <header class="x-replies__header">
            <div>
              <h1 id="x-replies-title">X replies</h1>
              <p>Choose whose mentions the bot can answer publicly.</p>
            </div>
            <button
              class="btn"
              type="button"
              ?disabled=${busy || !canManage()}
              @click=${() => void request("x.allowlist.list")}
            >
              Refresh
            </button>
          </header>
          ${
            !host.connection.connected
              ? html`<p role="status">Connect to the Gateway to manage X replies.</p>`
              : !host.connection.canAdmin
                ? html`<p role="status">Administrator access is required to manage X replies.</p>`
                : html`
                    <div class="x-replies__controls">
                      <label class="x-replies__field">
                        <span>Bot account</span>
                        <select
                          .value=${accountId ?? ""}
                          ?disabled=${busy || !snapshot}
                          @change=${(event: Event) => {
                            if (!(event.currentTarget instanceof HTMLSelectElement)) {
                              return;
                            }
                            accountId = event.currentTarget.value;
                            snapshot = undefined;
                            void request("x.allowlist.list");
                          }}
                        >
                          ${
                            snapshot
                              ? snapshot.accounts.map(
                                  (account) => html`<option
                                    value=${account.accountId}
                                    ?selected=${account.accountId === accountId}
                                  >
                                    ${account.username ? `@${account.username}` : account.accountId}
                                    (${account.accountId})
                                  </option>`,
                                )
                              : html`<option value=${accountId ?? ""}>
                                  ${accountId ?? "Select an account"}
                                </option>`
                          }
                        </select>
                      </label>
                      <form
                        class="x-replies__add"
                        @submit=${(event: Event) => {
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
                            .value=${username}
                            ?disabled=${busy}
                            @input=${(event: Event) => {
                              if (event.currentTarget instanceof HTMLInputElement) {
                                username = event.currentTarget.value;
                              }
                            }}
                          />
                        </label>
                        <button class="btn primary" type="submit" ?disabled=${busy}>
                          Add account
                        </button>
                      </form>
                    </div>
                    <p class="x-replies__hint">
                      Handle lookup costs $0.01. Config entries are read-only here.
                    </p>
                    ${error ? html`<p class="x-replies__error" role="alert">${error}</p>` : nothing}
                    <div aria-live="polite">
                      ${busy ? html`<p>Updating allowlist…</p>` : notice ? html`<p>${notice}</p>` : nothing}
                    </div>
                    ${
                      snapshot
                        ? html`
                            <dl class="x-replies__spend" aria-label="X API spend">
                              <div>
                                <dt>Today (UTC)</dt>
                                <dd>
                                  <strong>${usd.format(snapshot.spend.dayUsd)}</strong>
                                  <span> / ${usd.format(snapshot.spend.dailyLimitUsd)}</span>
                                </dd>
                              </div>
                              <div>
                                <dt>Billing cycle since ${snapshot.spend.cycleStart}</dt>
                                <dd>
                                  <strong>${usd.format(snapshot.spend.cycleUsd)}</strong>
                                  <span> / ${usd.format(snapshot.spend.monthlyLimitUsd)}</span>
                                </dd>
                              </div>
                            </dl>
                            ${
                              snapshot.spend.exhaustedUntil
                                ? html`<p class="x-replies__budget" role="status">
                                    X API budget reached. Paid requests resume at
                                    <time datetime=${snapshot.spend.exhaustedUntil}
                                      >${snapshot.spend.exhaustedUntil}</time
                                    >.
                                  </p>`
                                : nothing
                            }
                            <div class="x-replies__list" aria-busy=${busy}>
                              ${
                                snapshot.entries.length
                                  ? html`<table>
                                      <thead>
                                        <tr>
                                          <th>Account</th>
                                          <th>Source</th>
                                          <th>Added by</th>
                                          <th><span class="x-replies__sr-only">Actions</span></th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        ${snapshot.entries.map(
                                          (entry) => html`
                                            <tr>
                                              <td>
                                                <strong
                                                  >${entry.username ? `@${entry.username}` : entry.userId}</strong
                                                >
                                                ${entry.name ? html`<span>${entry.name}</span>` : nothing}
                                                ${entry.username ? html`<small>${entry.userId}</small>` : nothing}
                                              </td>
                                              <td>
                                                ${entry.configured ? (entry.editable ? "Config + stored" : "Config") : "Stored"}
                                              </td>
                                              <td>${entry.addedBy ?? "—"}</td>
                                              <td>
                                                ${
                                                  entry.editable
                                                    ? html`<button
                                                        class="btn"
                                                        type="button"
                                                        aria-label=${`Remove stored entry for ${entry.username ? `@${entry.username}` : entry.userId}`}
                                                        ?disabled=${busy}
                                                        @click=${() => void request("x.allowlist.remove", { userId: entry.userId })}
                                                      >
                                                        Remove
                                                      </button>`
                                                    : html`<span class="x-replies__hint"
                                                        >Read-only</span
                                                      >`
                                                }
                                              </td>
                                            </tr>
                                          `,
                                        )}
                                      </tbody>
                                    </table>`
                                  : html`<p class="x-replies__empty">
                                      No accounts are allowed yet. Add a maintainer above or set
                                      <code>allowFrom</code> in config.
                                    </p>`
                              }
                            </div>
                            <p class="x-replies__hint">
                              With the default allowlist policy, all other mentions are ignored.
                            </p>
                          `
                        : nothing
                    }
                  `
          }
        </section>
      `,
      container,
    );
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
    draw();
  }
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
      render(nothing, container);
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
