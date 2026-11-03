/** @jsxImportSource @solidjs/web */

import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, Show } from "solid-js";
import type { GitHubPublicationView } from "./github-publication-owner.ts";
import type { PresentationValue } from "./native-context.tsx";
import { projectPresentation } from "./native-context.tsx";
import { Icon, Menu, type MenuControls, type MenuEntry } from "./presentation-components.tsx";
import { presentationTranslator } from "./presentation-context.ts";

const avatarInitial = (login: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(login)]
    .slice(0, 1)
    .map((part) => part.segment)
    .join("")
    .toUpperCase() || "?";

/** The Gateway supplies verified GitHub account images; initials cover absent or failed loads. */
export function GitHubPublicationAvatar(props: { login: string; url?: string }) {
  const [failedUrl, setFailedUrl] = createSignal<string>();
  return (
    <span class="github-publication-mobile__avatar" aria-hidden="true">
      <Show when={props.url !== failedUrl() && props.url} fallback={avatarInitial(props.login)}>
        {(url) => (
          <img
            src={url()}
            alt=""
            referrerpolicy="no-referrer"
            onError={() => setFailedUrl(props.url)}
          />
        )}
      </Show>
    </span>
  );
}

type GitHubPublicationMenuProps = {
  choices: readonly {
    source: "shared" | "personal";
    login: string;
    label: string;
    avatarUrl?: string;
  }[];
  selected?: "shared" | "personal";
  duplicateLogin: boolean;
  busy: boolean;
  presented: PresentationValue;
  mobile?: boolean;
  menuControls?: boolean;
  controls?: MenuControls;
  trigger?: JSX.Element;
  onSelect: (source: "shared" | "personal") => void;
};

export function createGitHubPublicationAccountMenuItems(
  props: Pick<
    GitHubPublicationMenuProps,
    "choices" | "selected" | "duplicateLogin" | "busy" | "mobile"
  > & { trailingCheck?: boolean; accountLabels?: boolean },
) {
  return createMemo<MenuEntry[]>(() =>
    props.choices.map((choice) => ({
      id: choice.source,
      label: `@${choice.login}${props.mobile || props.duplicateLogin ? ` · ${choice.label}` : ""}`,
      class: "session-menu__item",
      type: "radio" as const,
      checked: props.selected === choice.source,
      disabled: props.busy,
      content: props.mobile ? (
        <span class="github-publication-mobile__choice">
          <GitHubPublicationAvatar login={choice.login} url={choice.avatarUrl} />
          <span class="github-publication-mobile__choice-text">
            <span>{choice.label}</span>
            <span class="github-publication-mobile__choice-login">@{choice.login}</span>
          </span>
        </span>
      ) : props.accountLabels ? (
        <span class="chat-pr-account-choice">
          <span>{choice.label}</span>
          <span class="chat-pr-account-choice__login">@{choice.login}</span>
        </span>
      ) : (
        <span class="session-menu__text">
          @{choice.login}
          {props.duplicateLogin ? ` · ${choice.label}` : undefined}
        </span>
      ),
      details:
        props.trailingCheck === false ? undefined : (
          <span class="session-menu__icon" aria-hidden="true">
            {props.selected === choice.source && <Icon name="check" />}
          </span>
        ),
    })),
  );
}

export function GitHubPublicationMenu(props: GitHubPublicationMenuProps) {
  const t = presentationTranslator();
  const id = createUniqueId();
  const triggerRef = props.controls?.ref();
  const presentation = createMemo(() => projectPresentation(props.presented));
  const selectedChoice = () => props.choices.find((choice) => choice.source === props.selected);
  const label = () => {
    const selected = props.mobile ? selectedChoice() : undefined;
    return selected
      ? `${t("githubPublication.account")}: ${selected.label}, @${selected.login}`
      : t("githubPublication.account");
  };
  const items = createGitHubPublicationAccountMenuItems(props);
  return (
    <Menu
      ref={(handle) => {
        if (handle.overlay.trigger) {
          triggerRef?.(handle.overlay.trigger);
        }
      }}
      id={`github-publication-${id}`}
      class={props.mobile ? "github-publication-mobile__accounts" : "chat-pr__accounts"}
      panelClass={
        props.mobile ? "github-publication-mobile__accounts-panel" : "chat-pr__accounts-panel"
      }
      placement="top-end"
      label={label()}
      disabled={props.busy}
      triggerAttributes={{ "data-form-control": props.menuControls ? "" : undefined }}
      triggerClass={
        props.mobile
          ? "github-publication-mobile__account-trigger"
          : "btn btn--ghost btn--icon chat-icon-btn"
      }
      trigger={
        <Show when={props.trigger} fallback={<Icon name="chevronDown" />}>
          {props.trigger}
        </Show>
      }
      items={items()}
      open={presentation().read() ? undefined : false}
      onBeforeShow={(event) => {
        if (!presentation().read()) {
          event.preventDefault();
        }
      }}
      onSelect={(item) => {
        if (item.id === "shared" || item.id === "personal") {
          props.onSelect(item.id);
        }
      }}
    />
  );
}

export function githubPublicationSourceLabel(
  source: string,
  t: ReturnType<typeof presentationTranslator>,
): string {
  return t(
    source === "personal"
      ? "githubPublication.personal"
      : source === "agent-override"
        ? "githubPublication.agent"
        : "githubPublication.system",
  );
}

export function githubPublicationAvatarUrl(
  options: GitHubPublicationView["options"],
  publisher: { source: string; accountId: number },
): string | undefined {
  const source = publisher.source === "personal" ? "personal" : "shared";
  const offered = source === "personal" ? options?.personal?.account : options?.shared;
  return offered?.accountId === publisher.accountId ? options?.avatarUrls?.[source] : undefined;
}
