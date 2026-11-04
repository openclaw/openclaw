/** @jsxImportSource @solidjs/web */

import type { JSX as SolidJSX } from "@solidjs/web";
import type {
  ControlUiSettingsContextV2 as ControlUiSettingsContext,
  ControlUiContributionSettingsSnapshot as ControlUiSettingsSnapshot,
} from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, onSettled, untrack } from "solid-js";
import {
  createGitHubIdentityView,
  GitHubConnectionError,
  GitHubConnectionSetup,
  GitHubDetails,
  GitHubHealth,
  GitHubUnloadedStatus,
} from "./github-identity-view.tsx";
import { translator } from "./i18n.ts";
import {
  SettingsRow,
  SettingsSection,
  SettingsDetailsRow,
  SettingsSectionHelp,
  SettingsStatus,
  SettingsValue,
} from "./settings-components.tsx";
import { readSettingsIdentityConfig } from "./settings-config.ts";
export type SettingsSource = {
  read: () => ControlUiSettingsSnapshot;
  subscribe: (listener: () => void) => () => void;
};
export function createIdentityDependencies(context: ControlUiSettingsContext) {
  const client = { request: context.request };
  const runExternalMutation = context.runConfigMutation;
  return {
    client,
    translate: translator(context),
    confirm: context.confirm,
    formatError: context.formatError,
    runExternalMutation,
  };
}
export function GitHubConnections(props: {
  context: ControlUiSettingsContext;
  source: SettingsSource;
}) {
  const context = untrack(() => props.context);
  const t = translator(context);
  // The mounted owner captures its initial identity; later replacements arrive through sync.
  const initial = untrack(() => context.props);
  const [purpose, setPurpose] = createSignal<"personal" | "system">(
    initial.profile?.id ? "personal" : "system",
  );
  const [setupOpen, setSetupOpen] = createSignal(false);
  const deps = createIdentityDependencies(context);
  const authorizationSucceeded = () => setSetupOpen(false);
  const personal = createGitHubIdentityView({ ...deps, authorizationSucceeded });
  const system = createGitHubIdentityView({ ...deps, authorizationSucceeded });
  let observedProfileId: string | null = initial.profile?.id ?? null;
  let previousCanRead = initial.canRead === true;
  let previousCanAdmin = initial.canAdmin === true;
  const syncIdentities = () => {
    const current = untrack(() => props.source.read());
    const profileId =
      current.profile === undefined ? observedProfileId : (current.profile?.id ?? null);
    const canRead = current.canRead === true;
    const canAdmin = current.canAdmin === true;
    if (
      observedProfileId !== profileId ||
      (previousCanRead && !canRead) ||
      (previousCanAdmin && !canAdmin)
    ) {
      setSetupOpen(false);
      setPurpose(profileId ? "personal" : "system");
    }
    observedProfileId = profileId;
    previousCanRead = canRead;
    previousCanAdmin = canAdmin;
    const has = (method: string) => current.advertisedMethods?.includes(method) === true;
    const common = {
      client: deps.client,
      connected: current.connected,
      permissionsReady: current.permissionsReady ?? current.connected,
      clientRevision: current.connectionEpoch,
    };
    personal.sync({
      ...common,
      target: profileId ? { kind: "personal", profileId } : null,
      statusReadable: canRead && Boolean(profileId) && has("users.github.status"),
      authorizable: canRead && Boolean(profileId) && has("users.github.authorize.start"),
      configurable: false,
    });
    system.sync({
      ...common,
      target: current.agentId
        ? {
            kind: "shared",
            scope: "system",
            profileId,
            agentId: current.agentId,
            config: readSettingsIdentityConfig(context, current.agentId),
          }
        : null,
      statusReadable: canAdmin && has("tools.github.status"),
      authorizable: canAdmin && has("tools.github.authorize.start"),
      configurable: canAdmin && has("tools.github.configure"),
    });
    personal.ensureVerified();
    system.ensureVerified();
    if (canAdmin) {
      void context.ensureConfig?.();
    }
  };
  onSettled(() => {
    const stop = props.source.subscribe(syncIdentities);
    syncIdentities();
    return stop;
  });
  const view = createMemo(() => {
    const current = props.source.read();
    const personalState = personal.read();
    const systemState = system.read();
    const account = personalState.personal;
    const profileId =
      current.profile === undefined ? observedProfileId : (current.profile?.id ?? null);
    const connected = account?.state === "connected";
    const reconnectRequired =
      account?.state === "unavailable" ||
      account?.refreshState === "expired" ||
      account?.refreshState === "failed";
    return {
      account,
      agentId: current.agentId,
      agent: current.agents?.find((entry) => entry.id === current.agentId),
      connected,
      reconnectRequired,
      profileId,
      canRead: current.canRead === true,
      canAdmin: current.canAdmin === true,
      systemIdentity: systemState.status?.selected.identity ?? personalState.system,
      effective: systemState.status?.effective ?? null,
      locked:
        !current.connected ||
        personalState.loading ||
        systemState.loading ||
        personalState.authorizationActive ||
        systemState.authorizationActive ||
        personalState.busy ||
        systemState.busy,
      showSetup:
        setupOpen() || personalState.authorizationActive || systemState.authorizationActive,
      personalLabel: !profileId
        ? t("githubConnections.signInRequired")
        : reconnectRequired
          ? t("githubConnections.reconnectRequired")
          : connected
            ? t("githubConnections.connected")
            : t("githubConnections.disconnected"),
    };
  });
  const personalView = personal.read;
  const systemView = system.read;
  const active = () => (purpose() === "personal" ? personal : system);
  const openSetup = (next: "personal" | "system") => {
    const current = props.source.read();
    if (
      view().locked ||
      (next === "personal" ? !current.profile?.id || !current.canRead : !current.canAdmin)
    ) {
      return;
    }
    setPurpose(next);
    setSetupOpen(true);
  };
  const verify = () => {
    void personal.verify();
    void system.verify();
  };
  const closeSetup = () => {
    setSetupOpen(false);
    active().hidePatFallback();
  };
  /** The flow opens under the connection it changes, so nothing has to name its purpose. */
  const setupFor = (target: "personal" | "system") =>
    view().showSetup && purpose() === target ? (
      <div class="settings-subrows" data-github-setup>
        <GitHubConnectionSetup identity={active()} />
        {!view().locked ? (
          <>
            {target === "personal" &&
            view().account &&
            view().account?.state !== "disconnected" &&
            view().canRead ? (
              <SettingsRow
                title={t("githubConnections.disconnectMine")}
                description={t("githubConnections.disconnectDescription")}
                control={
                  <button
                    class="btn btn--sm danger"
                    onClick={() => {
                      setSetupOpen(false);
                      void personal.disconnect();
                    }}
                  >
                    {t("githubConnections.disconnect")}
                  </button>
                }
              />
            ) : undefined}
            <div class="settings-row">
              <span class="settings-row__desc">{t("githubConnections.purposeHint")}</span>
              <div class="settings-row__control">
                {target === "system" &&
                view().canAdmin &&
                systemView().status?.selected.configured ? (
                  <button class="btn btn--sm" onClick={() => void system.inherit()}>
                    {t("agentTools.githubUseNativeNewRuns")}
                  </button>
                ) : undefined}
                <button class="btn btn--sm" onClick={closeSetup}>
                  {t("common.close")}
                </button>
              </div>
            </div>
          </>
        ) : undefined}
      </div>
    ) : undefined;
  /** Status, who the connection acts as, and a short use: read at a glance at every width. */
  const meta = (status: SolidJSX.Element, handle: string | undefined, use: string | undefined) => (
    <span class="settings-row__meta">
      {status}
      {handle ? <span class="github-connection__login">@{handle}</span> : undefined}
      {use ? <span>{use}</span> : undefined}
    </span>
  );
  const agentTitle = () =>
    t("githubConnections.agentFor", {
      agent: view().agent?.identity?.name ?? view().agent?.name ?? view().agentId!,
    });
  return (
    <openclaw-github-connections>
      <div id={"settings-profile-github-connections"}>
        <SettingsSection
          title={t("githubConnections.title")}
          description={t("githubConnections.description")}
          actions={
            <>
              {view().canRead && (view().profileId || view().canAdmin) ? (
                <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                  {t("agentTools.githubVerify")}
                </button>
              ) : undefined}
              <SettingsSectionHelp
                id="settings-profile-github-connections-help"
                section={t("githubConnections.title")}
              >
                <p>{t("githubConnections.descriptionMore")}</p>
                <p>
                  <strong>{t("githubConnections.mine")}</strong>{" "}
                  {t(
                    view().profileId
                      ? "githubConnections.personalDescription"
                      : "githubConnections.unboundDescription",
                  )}
                </p>
                <p>
                  <strong>{t("githubConnections.system")}</strong>{" "}
                  {t("githubConnections.systemDescription")}
                </p>
                {view().canAdmin && view().agentId ? (
                  <p>
                    <strong>{agentTitle()}</strong> {t("githubConnections.agentDescription")}
                  </p>
                ) : undefined}
                <p>
                  <strong>{t("githubConnections.usage")}</strong>{" "}
                  {t("githubConnections.usageDescription")}
                </p>
              </SettingsSectionHelp>
            </>
          }
        >
          <div data-github-connection="personal">
            <SettingsRow
              title={t("githubConnections.mine")}
              description={meta(
                view().profileId && !view().account ? (
                  <GitHubUnloadedStatus request={personalView()} />
                ) : (
                  <SettingsStatus
                    kind={view().reconnectRequired ? "warn" : view().connected ? "ok" : "muted"}
                    label={view().personalLabel}
                  />
                ),
                view().account?.account?.login,
                view().profileId ? t("githubConnections.personalUse") : undefined,
              )}
              control={
                view().profileId && view().canRead ? (
                  <button
                    class="btn btn--sm"
                    disabled={view().locked}
                    aria-label={t(
                      !view().account
                        ? "githubConnections.manage"
                        : view().connected
                          ? "githubConnections.changeMine"
                          : "githubConnections.connectMine",
                    )}
                    onClick={() => openSetup("personal")}
                  >
                    {/* An unknown status can't promise either "connect" or "change". */}
                    {t(
                      !view().account
                        ? "githubConnections.manageShort"
                        : view().connected
                          ? "githubConnections.changeShort"
                          : "githubConnections.connectShort",
                    )}
                  </button>
                ) : undefined
              }
            />
            {setupFor("personal")}
          </div>
          <div data-github-connection="system">
            <SettingsDetailsRow
              detailsLabel={t("githubConnections.details")}
              hasDetails={Boolean(view().systemIdentity)}
              title={t("githubConnections.system")}
              description={meta(
                <GitHubHealth
                  identity={view().systemIdentity}
                  request={view().canAdmin ? systemView() : personalView()}
                />,
                view().systemIdentity?.account?.login,
                t(
                  view().systemIdentity?.credentialKind === "app-installation"
                    ? "agentTools.githubKindAppInstallation"
                    : "githubConnections.systemUse",
                ),
              )}
              control={
                view().canAdmin ? (
                  <button
                    class="btn btn--sm"
                    disabled={view().locked || !systemView().status}
                    aria-label={t("githubConnections.changeSystem")}
                    onClick={() => openSetup("system")}
                  >
                    {t("githubConnections.changeShort")}
                  </button>
                ) : (
                  <SettingsValue value={t("githubConnections.adminManaged")} />
                )
              }
            >
              <GitHubDetails identity={view().systemIdentity} />
            </SettingsDetailsRow>
            {setupFor("system")}
          </div>
          {view().canAdmin && view().agentId ? (
            <div data-github-connection="agent">
              <SettingsRow
                title={agentTitle()}
                description={meta(
                  <GitHubHealth identity={view().effective} request={systemView()} />,
                  view().effective?.account?.login,
                  view().effective
                    ? t(
                        view().effective?.source === "agent-override"
                          ? "githubConnections.agentOverride"
                          : "githubConnections.system",
                      )
                    : undefined,
                )}
                control={
                  <button
                    class="btn btn--sm"
                    aria-label={t("githubConnections.viewAgent")}
                    onClick={() => context.navigateTo({ page: "agent-tools" })}
                  >
                    {t("githubConnections.viewShort")}
                  </button>
                }
              />
            </div>
          ) : undefined}
          <GitHubConnectionError
            error={personalView().error ?? systemView().error}
            completion={personalView().completion}
            secondaryCompletion={systemView().completion}
            control={
              <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                {t("common.retry")}
              </button>
            }
          />
        </SettingsSection>
      </div>
    </openclaw-github-connections>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-github-connections": HTMLAttributes<HTMLElement>;
    }
  }
}
