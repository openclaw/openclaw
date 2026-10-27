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
  const booleanFact = (
    field: "configured" | "linked" | "running" | "connected",
    value: boolean | null | undefined,
  ) => ({
    key: field,
    label: t(`common.${field}`),
    value: t(value == null ? "common.na" : value ? "common.yes" : "common.no"),
    kind: value === true ? "ok" : "muted",
  });
  const facts = createMemo(() => {
    const value = status();
    const phone = value?.self?.e164;
    return [
      booleanFact("configured", configured()),
      booleanFact("linked", value?.linked === true),
      ...(phone
        ? [
            {
              key: "phone",
              label: t("channels.whatsapp.phoneNumber"),
              value: props.context.formatPhoneNumber!(phone),
              kind: undefined,
            },
          ]
        : []),
      booleanFact("running", value?.running === true),
      booleanFact("connected", value?.connected === true),
      {
        key: "lastConnect",
        label: t("common.lastConnect"),
        value: value?.lastConnectedAt
          ? props.context.formatRelativeTimestamp(value.lastConnectedAt)
          : t("common.na"),
        kind: undefined,
      },
      {
        key: "lastMessage",
        label: t("common.lastMessage"),
        value: value?.lastMessageAt
          ? props.context.formatRelativeTimestamp(value.lastMessageAt)
          : t("common.na"),
        kind: undefined,
      },
      {
        key: "authAge",
        label: t("common.authAge"),
        value:
          value?.authAgeMs != null
            ? props.context.formatDuration!(value.authAgeMs)
            : t("common.na"),
        kind: undefined,
      },
    ];
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
  const ErrorRow = (errorProps: { error: unknown }) => (
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__title">
          <span class="settings-status settings-status--danger">
            <span class="settings-status__dot" />
            <span>{t("channels.lastError")}</span>
          </span>
        </span>
        <span class="settings-row__desc">{props.context.formatError(errorProps.error)}</span>
      </div>
    </div>
  );
  return (
    <section class="settings-section">
      <div class="settings-section__header">
        <div class="settings-section__copy">
          <h2 class="settings-section__heading">
            {t("channels.whatsapp.title")}
            <Show when={props.snapshot.accounts.length >= 2}>
              {" "}
              <span class="settings-count">{props.snapshot.accounts.length}</span>
            </Show>
          </h2>
          <p class="settings-section__desc">{t("channels.whatsapp.subtitle")}</p>
        </div>
      </div>
      <div class="settings-group">
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
        <Show
          when={status()?.lastError}
          fallback={
            <Loading on={completion()}>
              <Errored fallback={(error) => <ErrorRow error={error()} />}>{completed()}</Errored>
            </Loading>
          }
        >
          {(error) => <ErrorRow error={error()} />}
        </Show>
        <div
          style={{ display: "contents" }}
          ref={(node) => {
            config = node;
          }}
        />
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
            </div>
          )}
        </Show>
        <div class="settings-row settings-row--actions">
          <div class="settings-row__control">
            <button
              type="button"
              class={["btn", { primary: !linked() }]}
              disabled={login()?.busy}
              onClick={() => run(() => props.context.login!.start(linked()))}
            >
              {linked()
                ? t("common.relink")
                : login()?.busy
                  ? t("common.working")
                  : t("common.showQr")}
            </button>
            <Show when={login()?.qrDataUrl != null}>
              <button
                type="button"
                class="btn"
                disabled={login()?.busy}
                onClick={() => run(() => props.context.login!.wait())}
              >
                {t("common.waitForScan")}
              </button>
            </Show>
            <button
              type="button"
              class="btn danger"
              disabled={login()?.busy}
              onClick={() => run(logout)}
            >
              {t("common.logout")}
            </button>
            <button
              type="button"
              class="btn"
              onClick={() => run(() => props.context.refresh(true))}
            >
              {t("common.refresh")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
