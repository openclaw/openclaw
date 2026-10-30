/** @jsxImportSource @solidjs/web */

import type { JSX } from "@solidjs/web";
import type {
  ControlUiChannelSettingsContext,
  ControlUiChannelSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { asNullableRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createMemo, For, Show, onSettled } from "solid-js";
import { SettingsRow, SettingsSection, SettingsStatus } from "./components.tsx";
import type { createProfileController } from "./controller.ts";
import { createTranslator } from "./i18n/index.ts";
import { createNostrProfileForm } from "./profile-form.tsx";
import type { NostrProfile, NostrStatus } from "./types.ts";

type ChannelAccountSnapshot = ControlUiChannelSettingsSnapshot["accounts"][number];
type Controller = ReturnType<typeof createProfileController>;
const PROFILE_FIELDS = ["name", "displayName", "about", "nip05"] as const;

export function createProfileCard(
  context: ControlUiChannelSettingsContext,
  state: () => ReturnType<Controller["read"]>,
  controller: Controller,
) {
  const t = createTranslator(() => state().snapshot.locale);
  const formatRelativeTimestamp = context.formatRelativeTimestamp;
  const NostrProfileForm = createNostrProfileForm(t);
  const boolStatusKind = (value: boolean | null | undefined) =>
    value === true ? ("ok" as const) : ("muted" as const);
  function BooleanChannelFact(props: {
    field: "configured" | "running";
    value: boolean | null | undefined;
  }) {
    return (
      <>
        <dt>{t(`common.${props.field}`)}</dt>
        <dd>
          <SettingsStatus
            kind={boolStatusKind(props.value)}
            label={t(props.value == null ? "common.na" : props.value ? "common.yes" : "common.no")}
          />
        </dd>
      </>
    );
  }
  function ChannelError(props: { message: unknown }) {
    return (
      <SettingsRow
        title={<SettingsStatus kind="danger" label={t("channels.lastError")} />}
        description={context.formatError(props.message)}
      />
    );
  }
  function ChannelActions(props: { children: JSX.Element }) {
    return (
      <div class="settings-row settings-row--actions">
        <div class="settings-row__control">{props.children}</div>
      </div>
    );
  }
  function ChannelAccount(props: {
    title: string;
    accountId: string;
    facts: readonly string[];
    status: { kind: "ok" | "muted"; label: string };
    lastInboundAt?: number | null;
    lastError?: string | null;
  }) {
    return (
      <div class="settings-row">
        <div class="settings-row__text">
          <span class="settings-row__title">{props.title}</span>
          <span class="settings-row__desc">{[props.accountId, ...props.facts].join(" · ")}</span>
          <Show when={props.lastError}>
            <span class="settings-row__desc">{context.formatExternalText(props.lastError!)}</span>
          </Show>
        </div>
        <div class="settings-row__control">
          <SettingsStatus {...props.status} />
          <span class="settings-row__value">
            {props.lastInboundAt ? formatRelativeTimestamp(props.lastInboundAt) : t("common.na")}
          </span>
        </div>
      </div>
    );
  }
  function ConfigSlot() {
    let container!: HTMLDivElement;
    onSettled(() => context.mountConfig(container));
    return (
      <div
        style={{ display: "contents" }}
        ref={(node) => {
          container = node;
        }}
      />
    );
  }
  function truncatePubkey(pubkey: string | null | undefined): string {
    if (!pubkey) {
      return t("common.na");
    }
    return pubkey.length <= 20 ? pubkey : `${pubkey.slice(0, 8)}...${pubkey.slice(-8)}`;
  }

  function NostrAccount(props: { account: ChannelAccountSnapshot }) {
    const account = () => props.account;
    const publicKey = () => readStringField(asNullableRecord(account()), "publicKey");
    const profile = createMemo(() => {
      // SAFETY: Nostr resolveAccountSnapshot copies its schema-validated account.profile into this metadata field.
      return asNullableRecord(account())?.profile as NostrProfile | null | undefined;
    });
    const displayName = () =>
      profile()?.displayName ?? profile()?.name ?? account().name ?? account().accountId;
    return (
      <ChannelAccount
        title={displayName()}
        accountId={account().accountId}
        facts={[
          `${t("common.configured")}: ${account().configured ? t("common.yes") : t("common.no")}`,
          `${t("common.publicKey")}: ${truncatePubkey(publicKey())}`,
        ]}
        status={{
          kind: boolStatusKind(account().running),
          label: account().running ? t("common.running") : t("common.no"),
        }}
        lastInboundAt={account().lastInboundAt}
        lastError={account().lastError}
      />
    );
  }

  function NostrCard() {
    const accounts = () => state().snapshot.accounts;
    const nostr = createMemo(() => {
      // SAFETY: The bundled Nostr plugin owns the channels.nostr status payload.
      return state().snapshot.status as NostrStatus | undefined;
    });
    const accountId = () => accounts()[0]?.accountId ?? "default";
    const form = createMemo(() => (state().accountId === accountId() ? state().form : null));
    const primaryAccount = () => accounts()[0];
    const configured = () => nostr()?.configured ?? primaryAccount()?.configured ?? false;
    const publicKey = () =>
      nostr()?.publicKey ?? readStringField(asNullableRecord(primaryAccount()), "publicKey");
    const lastStart = () => nostr()?.lastStartAt ?? primaryAccount()?.lastStartAt;
    const lastError = () => nostr()?.lastError ?? primaryAccount()?.lastError;

    const profile = createMemo(() => {
      // SAFETY: Nostr account profile metadata comes from the plugin's schema-validated config.
      const accountProfile = asNullableRecord(primaryAccount())?.profile as
        | NostrProfile
        | null
        | undefined;
      return accountProfile ?? nostr()?.profile ?? null;
    });
    function ProfileSection() {
      const hasAnyProfileData = () =>
        profile()?.picture || PROFILE_FIELDS.some((field) => profile()?.[field]);

      return (
        <>
          <SettingsRow
            title={t("channels.nostr.profile")}
            description={
              hasAnyProfileData() ? undefined : (
                <>
                  {t("channels.nostr.noProfile")} {t("channels.nostr.noProfileHint")}
                </>
              )
            }
            control={
              configured() ? (
                <button class="btn btn--sm" onClick={() => controller.edit(accountId(), profile())}>
                  {t("channels.nostr.editProfile")}
                </button>
              ) : undefined
            }
          />
          <Show when={hasAnyProfileData()}>
            <dl class="settings-kv">
              <Show when={profile()?.picture} keyed>
                {(picture) => (
                  <>
                    <dt>{t("channels.nostr.profilePicture")}</dt>
                    <dd>
                      <img
                        style={{
                          width: "48px",
                          height: "48px",
                          "border-radius": "50%",
                          "object-fit": "cover",
                        }}
                        src={picture}
                        alt={t("channels.nostr.profilePicture")}
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    </dd>
                  </>
                )}
              </Show>
              <For each={PROFILE_FIELDS}>
                {(field) => (
                  <Show when={profile()?.[field]}>
                    {(value) => (
                      <>
                        <dt>{field === "nip05" ? "NIP-05" : t(`channels.nostr.${field}`)}</dt>
                        <dd>{value()}</dd>
                      </>
                    )}
                  </Show>
                )}
              </For>
            </dl>
          </Show>
        </>
      );
    }

    return (
      <SettingsSection
        title={t("channels.nostr.title")}
        description={t("channels.nostr.subtitle")}
        count={accounts().length >= 2 ? accounts().length : undefined}
      >
        {accounts().length > 1 ? (
          <For each={accounts()} keyed={(account) => account.accountId}>
            {(account) => <NostrAccount account={account()} />}
          </For>
        ) : (
          <dl class="settings-kv">
            <BooleanChannelFact field="configured" value={configured()} />
            <BooleanChannelFact
              field="running"
              value={nostr()?.running ?? primaryAccount()?.running ?? false}
            />
            <dt>{t("common.publicKey")}</dt>
            <dd>
              <code title={publicKey() ?? ""}>{truncatePubkey(publicKey())}</code>
            </dd>
            <dt>{t("common.lastStart")}</dt>
            <dd>{lastStart() ? formatRelativeTimestamp(lastStart()) : t("common.na")}</dd>
          </dl>
        )}
        {lastError() ? <ChannelError message={lastError()} /> : undefined}
        <Show when={form()} fallback={<ProfileSection />}>
          {(formState) => (
            <NostrProfileForm
              state={formState()}
              connected={state().snapshot.connected}
              accountId={accountId()}
              callbacks={{
                onFieldChange: (field, value) => controller.field(field, value),
                onSave: () => void controller.save(),
                onImport: () => void controller.import(),
                onCancel: () => controller.cancel(),
                onToggleAdvanced: () => controller.toggleAdvanced(),
              }}
            />
          )}
        </Show>
        <ConfigSlot />
        <ChannelActions>
          <button class="btn" onClick={() => void context.refresh(false)}>
            {t("common.refresh")}
          </button>
        </ChannelActions>
      </SettingsSection>
    );
  }

  return NostrCard;
}
