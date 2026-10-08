import type { RemoteProject } from "@openclaw/gateway-protocol";
import { html, nothing } from "lit";
import type { GitHubPresentationHost } from "./presentation-host.js";

type GitHubRepositorySearchProps = {
  remoteProjects: readonly RemoteProject[];
  selectedRemoteProject: { cloneUrl: string } | null;
  projectSearchCredentialMissing: boolean;
  projectSearchLoading: boolean;
  projectSearchError: string | null;
  projectAddAvailable: boolean;
  submitting: boolean;
  onSelectRemoteProject: (project: {
    identity: string;
    cloneUrl: string;
    defaultBranch?: string;
  }) => void;
};

export function createGitHubRepositoryPickerRenderer(
  host: Pick<GitHubPresentationHost, "t"> & {
    gitBranchIcon: unknown;
    renderMenuItem: (
      item: {
        value: string;
        label: string;
        icon: unknown;
        sub: string;
        checked: boolean;
        title: string;
        onSelect: () => void;
      },
      disabled: boolean,
    ) => unknown;
  },
) {
  const { t } = host;
  return (props: GitHubRepositorySearchProps) => html`
    <div class="new-session-page__menu-title">${t("newSession.githubProjects")}</div>
    ${
      props.projectSearchCredentialMissing
        ? html`<div class="new-session-page__menu-note">${t("newSession.githubTokenHint")}</div>`
        : nothing
    }
    ${
      props.projectSearchLoading
        ? html`<div class="new-session-page__project-status" role="status">
            ${t("common.loading")}
          </div>`
        : nothing
    }
    ${
      props.projectSearchError
        ? html`<div class="new-session-page__project-error" role="alert">
            ${props.projectSearchError}
          </div>`
        : nothing
    }
    ${props.remoteProjects.map((project) =>
      host.renderMenuItem(
        {
          value: `remote-project:${project.fullName}`,
          label: project.fullName,
          icon: host.gitBranchIcon,
          sub: project.description ?? t("newSession.cloneProject"),
          checked: props.selectedRemoteProject?.cloneUrl === project.cloneUrl,
          title: project.webUrl,
          onSelect: () =>
            props.onSelectRemoteProject({
              identity: project.fullName,
              cloneUrl: project.cloneUrl,
              ...(project.defaultBranch ? { defaultBranch: project.defaultBranch } : {}),
            }),
        },
        props.submitting || !props.projectAddAvailable,
      ),
    )}
  `;
}
