/** @jsxImportSource @solidjs/web */
import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, Errored, For, Loading, Show, onSettled } from "solid-js";
import { createTranslator } from "./i18n/index.ts";
import type { WhatsAppStatus } from "./types.ts";

export function WhatsAppCard(props: {
  context: ControlUiChannelSettingsContext;
  snapshot: ControlUiChannelSettingsSnapshot;
}) {
  const t = createTranslator(() => props.snapshot.locale);
  const [completion, setCompletion] = createSignal<Promise<void>>();
  // SAFETY: this declared placement receives the WhatsApp status published by its channel.
  const status = () => props.snapshot.status as WhatsAppStatus | undefined;
  const completed = createMemo(() => completion()?.then(() => null) ?? null);
  const linked = () => status()?.linked === true;
  const login = () => props.snapshot.login;
  const configured = () => {
    const value = status()?.configured;
    const account =
      props.snapshot.accounts.find(
        (candidate) => candidate.accountId === props.snapshot.defaultAccountId,
      ) ?? props.snapshot.accounts[0];
    return typeof value === "boolean" ? value : (account?.configured ?? null);
  };
  const phone = createMemo(() => {
    const value = status()?.self?.e164;
    return value ? props.context.formatPhoneNumber!(value) : null;
  });
  const booleanFact = (
    field: "configured" | "linked" | "running" | "connected",
    value: boolean | null | undefined,
  ) => ({
    key: field,
    label: t(`common.${field}`),
    value: value == null ? null : t(value ? "common.yes" : "common.no"),
    kind: value === true ? "ok" : "muted",
  });
  const facts = createMemo(() => {
    const value = status();
    return [
      booleanFact("configured", configured()),
      booleanFact("linked", value?.linked === true),
      booleanFact("running", value?.running === true),
      booleanFact("connected", value?.connected === true),
      {
        key: "lastConnect",
        label: t("common.lastConnect"),
        value: value?.lastConnectedAt
          ? props.context.formatRelativeTimestamp(value.lastConnectedAt)
          : null,
        kind: undefined,
      },
      {
        key: "lastMessage",
        label: t("common.lastMessage"),
        value: value?.lastMessageAt
          ? props.context.formatRelativeTimestamp(value.lastMessageAt)
          : null,
        kind: undefined,
      },
      {
        key: "authAge",
        label: t("common.authAge"),
        value: value?.authAgeMs != null ? props.context.formatDuration!(value.authAgeMs) : null,
        kind: undefined,
      },
    ].filter((fact) => fact.value !== null);
  });
  function run(action: () => Promise<void>) {
    const pending = (async () => {
      try {
        await action();
      } catch (error) {
        if (
          props.context.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      }
    })();
    void setCompletion(pending);
    // The current receipt renders failures; superseded or disposed work still needs a consumer.
    void pending.catch(() => undefined);
  }
  async function logout() {
    const account = props.context.login!.captureLogout();
    if (
      account &&
      (await props.context.confirm!({
        title: t("channels.whatsapp.logoutConfirmTitle", { accountId: account.accountId }),
        message: t("channels.whatsapp.logoutConfirmMessage", { accountId: account.accountId }),
        confirmLabel: t("common.logout"),
        danger: true,
      }))
    ) {
      await account.logout();
    }
  }
  let config!: HTMLDivElement;
  onSettled(() => props.context.mountConfig(config));
  const ErrorCallout = (errorProps: { error: unknown }) => (
    <div class="callout danger" role="alert">
      {props.context.formatError(errorProps.error)}
    </div>
  );
  return (
    <>
      <Show
        when={status()?.lastError}
        fallback={
          <Loading on={completion()}>
            <Errored fallback={(error) => <ErrorCallout error={error()} />}>{completed()}</Errored>
          </Loading>
        }
      >
        {(error) => <ErrorCallout error={error()} />}
      </Show>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row__text">
            <span class="settings-row__title">
              {phone() ? t("channels.whatsapp.phoneNumber") : t("common.linked")}
            </span>
            <span class="settings-row__desc">
              {phone() ?? t(linked() ? "common.yes" : "common.no")}
            </span>
          </div>
          <div class="settings-row__control">
            <button
              type="button"
              class={[
                "btn",
                { primary: !linked() && !login()?.qrDataUrl && configured() === true },
              ]}
              disabled={login()?.busy}
              onClick={() => run(() => props.context.login!.start(linked()))}
            >
              {linked()
                ? t("common.relink")
                : login()?.busy
                  ? t("common.working")
                  : t("common.showQr")}
            </button>
            <button
              type="button"
              class="btn danger"
              disabled={login()?.busy}
              onClick={() => run(logout)}
            >
              {t("common.logout")}
            </button>
          </div>
        </div>
        <Show when={login()?.message}>
          {(message) => (
            <div class="settings-row" role="status">
              <div class="settings-row__text">
                <span class="settings-row__desc">{message()}</span>
              </div>
            </div>
          )}
        </Show>
        <Show when={login()?.qrDataUrl}>
          {(qr) => (
            <div class="settings-row settings-row--stacked">
              <div class="qr-wrap">
                <img src={qr()} alt={t("channels.setup.whatsappQrAlt")} />
              </div>
              <div class="settings-row__control">
                <button
                  type="button"
                  class="btn primary"
                  disabled={login()?.busy}
                  onClick={() => run(() => props.context.login!.wait())}
                >
                  {t("common.waitForScan")}
                </button>
              </div>
            </div>
          )}
        </Show>
      </div>
      <div
        style={{ display: "contents" }}
        ref={(node) => {
          config = node;
        }}
      />
      <details class="settings-group settings-disclosure">
        <summary class="settings-row settings-row--nav settings-disclosure__summary">
          <div class="settings-row__text">
            <span class="settings-row__title">{t("common.details")}</span>
          </div>
          <div class="settings-row__control">
            <span class="settings-row__chevron settings-disclosure__chevron">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
          </div>
        </summary>
        <dl class="settings-kv">
          <For each={facts()} keyed={(fact) => fact.key}>
            {(fact) => (
              <>
                <dt>{fact().label}</dt>
                <dd>
                  <Show when={fact().kind} fallback={fact().value}>
                    {(kind) => (
                      <span class={["settings-status", { "settings-status--ok": kind() === "ok" }]}>
                        <span class="settings-status__dot" />
                        <span>{fact().value}</span>
                      </span>
                    )}
                  </Show>
                </dd>
              </>
            )}
          </For>
        </dl>
      </details>
    </>
  );
}
