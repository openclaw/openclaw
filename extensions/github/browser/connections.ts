import { html, nothing } from "lit";
import type { GitHubIdentityView } from "./identity-contract.js";
import type { GitHubIdentityHost } from "./identity-host.js";
import { createGitHubIdentityRenderer } from "./identity.js";

export type GitHubConnectionsProps = {
  personal: GitHubIdentityView;
  system: GitHubIdentityView;
  purpose: "personal" | "system";
  setupOpen: boolean;
  hasProfile: boolean;
  canRead: boolean;
  canAdmin: boolean;
  locked: boolean;
  agent?: { id: string; label: string };
  targetId: string;
  onOpenSetup: (purpose?: "personal" | "system") => void;
  onCloseSetup: () => void;
  onOpenAgent: (agentId: string) => void;
};

export function createGitHubConnectionsRenderer(host: GitHubIdentityHost) {
  const {
    t,
    renderSettingsRow,
    renderSettingsSection,
    renderSettingsSegmented,
    renderSettingsStatus,
    renderSettingsValue,
  } = host;
  const {
    renderGitHubConnectionError,
    renderGitHubConnectionSetup,
    renderGitHubDetails,
    renderGitHubHealth,
    renderGitHubUnloadedStatus,
  } = createGitHubIdentityRenderer(host);
  return (props: GitHubConnectionsProps) => {
    const personal = props.personal.personal;
    const system = props.system.status?.selected.identity ?? props.personal.system;
    const agentId = props.agent?.id;
    const effective = props.system.status?.effective ?? null;
    const active = props.purpose === "personal" ? props.personal : props.system;
    const showSetup =
      props.setupOpen || props.personal.authorizationActive || props.system.authorizationActive;
    const connected = personal?.state === "connected";
    const reconnectRequired =
      personal?.state === "unavailable" ||
      personal?.refreshState === "expired" ||
      personal?.refreshState === "failed";
    const personalLabel = !props.hasProfile
      ? t("githubConnections.signInRequired")
      : reconnectRequired
        ? t("githubConnections.reconnectRequired")
        : connected
          ? t("githubConnections.connected")
          : t("githubConnections.disconnected");
    return html`<div id=${props.targetId}>
      ${renderSettingsSection(
        {
          title: t("githubConnections.title"),
          description: t("githubConnections.description"),
          actions:
            props.canRead && (props.hasProfile || props.canAdmin)
              ? html`<button
                    class="btn btn--sm"
                    ?disabled=${props.locked || (!props.hasProfile && !props.system.status)}
                    @click=${() => props.onOpenSetup()}
                  >
                    ${t("githubConnections.manage")}
                  </button>
                  <button
                    class="btn btn--sm"
                    ?disabled=${props.locked}
                    @click=${() => {
                      void props.personal.verify();
                      void props.system.verify();
                    }}
                  >
                    ${t("agentTools.githubVerify")}
                  </button>`
              : undefined,
        },
        html`
          <div data-github-connection="personal">
            ${renderSettingsRow({
              title: t("githubConnections.mine"),
              description: props.hasProfile
                ? html`${personal?.account ? `@${personal.account.login} · ` : ""}${t(
                    "githubConnections.personalDescription",
                  )}`
                : t("githubConnections.unboundDescription"),
              control: html`${
                props.hasProfile && !personal
                  ? renderGitHubUnloadedStatus(props.personal)
                  : renderSettingsStatus({
                      kind: reconnectRequired ? "warn" : connected ? "ok" : "muted",
                      label: personalLabel,
                    })
              }
              ${
                props.hasProfile && props.canRead && personal
                  ? html`<button
                      class="btn btn--sm"
                      ?disabled=${props.locked}
                      @click=${() => props.onOpenSetup("personal")}
                    >
                      ${
                        connected
                          ? t("githubConnections.changeMine")
                          : t("githubConnections.connectMine")
                      }
                    </button>`
                  : nothing
              }`,
            })}
          </div>
          <div data-github-connection="system">
            ${renderSettingsRow({
              title: t("githubConnections.system"),
              description: html`${system?.account ? `@${system.account.login} · ` : ""}${t(
                "githubConnections.systemDescription",
              )}`,
              control: html`${renderGitHubHealth(system, {
                loading: props.system.loading || props.personal.loading,
                error: props.system.error ?? props.personal.error,
              })}${
                props.canAdmin
                  ? html`<button
                      class="btn btn--sm"
                      ?disabled=${props.locked || !props.system.status}
                      @click=${() => props.onOpenSetup("system")}
                    >
                      ${t("githubConnections.changeSystem")}
                    </button>`
                  : renderSettingsValue(t("githubConnections.adminManaged"))
              }`,
            })}
          </div>
          ${
            props.canAdmin && agentId
              ? html`<div data-github-connection="agent">
                  ${renderSettingsRow({
                    title: t("githubConnections.agentFor", {
                      agent: props.agent?.label ?? agentId,
                    }),
                    description: html`${effective?.account ? `@${effective.account.login} · ` : ""}${
                        effective
                          ? t(
                              effective.source === "agent-override"
                                ? "githubConnections.agentOverride"
                                : "githubConnections.system",
                            )
                          : ""
                      }<br />${t("githubConnections.agentDescription")}`,
                    control: html`${renderGitHubHealth(effective, props.system)}<button
                        class="btn btn--sm"
                        @click=${() => props.onOpenAgent(agentId)}
                      >
                        ${t("githubConnections.viewAgent")}
                      </button>`,
                  })}
                </div>`
              : nothing
          }
          ${renderGitHubConnectionError(
            props.personal.error ?? props.system.error,
            html`<button
              class="btn btn--sm"
              ?disabled=${props.locked}
              @click=${() => {
                void props.personal.verify();
                void props.system.verify();
              }}
            >
              ${t("common.retry")}
            </button>`,
          )}
          ${
            showSetup
              ? html`<div class="settings-subrows" data-github-setup>
                  ${renderSettingsRow({
                    title: t("githubConnections.purpose"),
                    control:
                      props.hasProfile && props.canAdmin && props.system.status
                        ? renderSettingsSegmented({
                            value: props.purpose,
                            options: [
                              { value: "personal", label: t("githubConnections.forMe") },
                              { value: "system", label: t("githubConnections.forSystem") },
                            ],
                            disabled: props.locked,
                            ariaLabel: t("githubConnections.purpose"),
                            onChange: (purpose) => props.onOpenSetup(purpose),
                          })
                        : renderSettingsValue(
                            props.purpose === "personal"
                              ? t("githubConnections.forMe")
                              : t("githubConnections.forSystem"),
                          ),
                  })}
                  ${renderGitHubConnectionSetup(active)}
                  ${
                    !props.locked
                      ? renderSettingsRow({
                          title: t("githubConnections.purposeHint"),
                          control: html`<button
                            class="btn btn--sm"
                            @click=${() => {
                              props.onCloseSetup();
                              active.hidePatFallback();
                            }}
                          >
                            ${t("common.close")}
                          </button>`,
                        })
                      : nothing
                  }
                </div>`
              : nothing
          }
          <details class="settings-row settings-row--stacked">
            <summary class="settings-row__title">${t("githubConnections.usage")}</summary>
            <div class="settings-row__desc">${t("githubConnections.usageDescription")}</div>
            ${renderGitHubDetails(system)}
          </details>
          ${
            props.canAdmin && props.system.status?.selected.configured
              ? renderSettingsRow({
                  title: t("agentTools.githubUseNativeNewRuns"),
                  description: t("agentTools.githubSystemMutationHint"),
                  control: html`<button
                    class="btn btn--sm"
                    ?disabled=${props.locked}
                    @click=${() => void props.system.inherit()}
                  >
                    ${t("agentTools.githubUseNativeNewRuns")}
                  </button>`,
                })
              : nothing
          }
        `,
      )}
      ${
        props.hasProfile && props.canRead && personal && personal.state !== "disconnected"
          ? renderSettingsSection(
              { danger: true },
              renderSettingsRow({
                title: t("githubConnections.disconnectMine"),
                description: t("githubConnections.disconnectDescription"),
                control: html`<button
                  class="btn btn--sm"
                  ?disabled=${props.locked}
                  @click=${() => void props.personal.disconnect()}
                >
                  ${t("githubConnections.disconnectMine")}
                </button>`,
              }),
            )
          : nothing
      }
    </div>`;
  };
}
