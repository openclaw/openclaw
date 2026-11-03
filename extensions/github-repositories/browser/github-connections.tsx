/** @jsxImportSource @solidjs/web */

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
  SettingsSegmented,
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
    projectOwner: context.projectOwner,
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
  return (
    <openclaw-github-connections>
      <div id={"settings-profile-github-connections"}>
        <SettingsSection
          title={t("githubConnections.title")}
          description={t("githubConnections.description")}
          actions={
            view().canRead && (view().profileId || view().canAdmin) ? (
              <>
                <button
                  class="btn btn--sm"
                  disabled={view().locked || (!view().profileId && !systemView().status)}
                  onClick={() => openSetup(view().profileId ? "personal" : "system")}
                >
                  {t("githubConnections.manage")}
                </button>
                <button class="btn btn--sm" disabled={view().locked} onClick={verify}>
                  {t("agentTools.githubVerify")}
                </button>
              </>
            ) : undefined
          }
        >
          <div data-github-connection="personal">
            <SettingsRow
              title={t("githubConnections.mine")}
              description={
                view().profileId ? (
                  <>
                    {view().account?.account ? `@${view().account?.account?.login} · ` : ""}
                    {t("githubConnections.personalDescription")}
                  </>
                ) : (
                  t("githubConnections.unboundDescription")
                )
              }
              control={
                <>
                  {view().profileId && !view().account ? (
                    <GitHubUnloadedStatus request={personalView()} />
                  ) : (
                    <SettingsStatus
                      kind={view().reconnectRequired ? "warn" : view().connected ? "ok" : "muted"}
                      label={view().personalLabel}
                    />
                  )}
                  {view().profileId && view().canRead && view().account ? (
                    <button
                      class="btn btn--sm"
                      disabled={view().locked}
                      onClick={() => openSetup("personal")}
                    >
                      {t(
                        view().connected
                          ? "githubConnections.changeMine"
                          : "githubConnections.connectMine",
                      )}
                    </button>
                  ) : undefined}
                </>
              }
            />
          </div>
          <div data-github-connection="system">
            <SettingsRow
              title={t("githubConnections.system")}
              description={
                <>
                  {view().systemIdentity?.account
                    ? `@${view().systemIdentity?.account?.login} · `
                    : ""}
                  {t("githubConnections.systemDescription")}
                </>
              }
              control={
                <>
                  <GitHubHealth
                    identity={view().systemIdentity}
                    request={view().canAdmin ? systemView() : personalView()}
                  />
                  {view().canAdmin ? (
                    <button
                      class="btn btn--sm"
                      disabled={view().locked || !systemView().status}
                      onClick={() => openSetup("system")}
                    >
                      {t("githubConnections.changeSystem")}
                    </button>
                  ) : (
                    <SettingsValue value={t("githubConnections.adminManaged")} />
                  )}
                </>
              }
            />
          </div>
          {view().canAdmin && view().agentId ? (
            <div data-github-connection="agent">
              <SettingsRow
                title={t("githubConnections.agentFor", {
                  agent: view().agent?.identity?.name ?? view().agent?.name ?? view().agentId!,
                })}
                description={
                  <>
                    {view().effective?.account ? `@${view().effective?.account?.login} · ` : ""}
                    {view().effective
                      ? t(
                          view().effective?.source === "agent-override"
                            ? "githubConnections.agentOverride"
                            : "githubConnections.system",
                        )
                      : ""}
                    <br />
                    {t("githubConnections.agentDescription")}
                  </>
                }
                control={
                  <>
                    <GitHubHealth identity={view().effective} request={systemView()} />
                    <button
                      class="btn btn--sm"
                      onClick={() => context.navigateTo!({ page: "agent-tools" })}
                    >
                      {t("githubConnections.viewAgent")}
                    </button>
                  </>
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
          {view().showSetup ? (
            <div class="settings-subrows" data-github-setup>
              <SettingsRow
                title={t("githubConnections.purpose")}
                control={
                  view().profileId && view().canAdmin && systemView().status ? (
                    <SettingsSegmented
                      value={purpose()}
                      options={[
                        { value: "personal", label: t("githubConnections.forMe") },
                        { value: "system", label: t("githubConnections.forSystem") },
                      ]}
                      disabled={view().locked}
                      ariaLabel={t("githubConnections.purpose")}
                      onChange={openSetup}
                    />
                  ) : (
                    <SettingsValue
                      value={t(
                        purpose() === "personal"
                          ? "githubConnections.forMe"
                          : "githubConnections.forSystem",
                      )}
                    />
                  )
                }
              />
              <GitHubConnectionSetup identity={active()} />
              {!view().locked ? (
                <SettingsRow
                  title={t("githubConnections.purposeHint")}
                  control={
                    <button
                      class="btn btn--sm"
                      onClick={() => {
                        setSetupOpen(false);
                        active().hidePatFallback();
                      }}
                    >
                      {t("common.close")}
                    </button>
                  }
                />
              ) : undefined}
            </div>
          ) : undefined}
          <details class="settings-row settings-row--stacked">
            <summary class="settings-row__title">{t("githubConnections.usage")}</summary>
            <div class="settings-row__desc">{t("githubConnections.usageDescription")}</div>
            <GitHubDetails identity={view().systemIdentity} />
          </details>
          {view().canAdmin && systemView().status?.selected.configured ? (
            <SettingsRow
              title={t("agentTools.githubUseNativeNewRuns")}
              description={t("agentTools.githubSystemMutationHint")}
              control={
                <button
                  class="btn btn--sm"
                  disabled={view().locked}
                  onClick={() => void system.inherit()}
                >
                  {t("agentTools.githubUseNativeNewRuns")}
                </button>
              }
            />
          ) : undefined}
        </SettingsSection>
        {view().profileId &&
        view().canRead &&
        view().account &&
        view().account?.state !== "disconnected" ? (
          <SettingsSection danger>
            <SettingsRow
              title={t("githubConnections.disconnectMine")}
              description={t("githubConnections.disconnectDescription")}
              control={
                <button
                  class="btn btn--sm"
                  disabled={view().locked}
                  onClick={() => void personal.disconnect()}
                >
                  {t("githubConnections.disconnectMine")}
                </button>
              }
            />
          </SettingsSection>
        ) : undefined}
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
