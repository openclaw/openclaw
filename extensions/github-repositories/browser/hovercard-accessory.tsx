/** @jsxImportSource @solidjs/web */

import type {
  ControlUiSessionAccessory,
  ControlUiAccessoryProps,
  ControlUiHostV2,
} from "openclaw/plugin-sdk/control-ui";
import { createSignal, createEffect, Show } from "solid-js";
import { PullRequestDetails } from "./hovercard-read.tsx";
import { SessionGitDiff } from "./native-components.tsx";
import { NativeContext } from "./native-context.tsx";
import { Icon } from "./presentation-components.tsx";
import { PresentationContext } from "./presentation-context.ts";
import { pullRequestEnglish } from "./pull-request-english.ts";
import { mountPluginContent } from "./render-owned.ts";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";

type AccessoryContext = {
  host: Pick<ControlUiHostV2, "native" | "presentation" | "subscribe" | "sessions">;
  props: ControlUiAccessoryProps;
  signal: AbortSignal;
  presented: boolean;
};
export function createHovercardAccessoryMount(
  runtime: RepositoryBrowserRuntime,
): ControlUiSessionAccessory["mount"] {
  return (container: HTMLElement, initial: AccessoryContext) => {
    let context = initial;
    const native = initial.host.native,
      presentation = initial.host.presentation;
    if (!native || !presentation) {
      throw new Error("Repository presentation services are unavailable.");
    }
    presentation.registerEnglish(pullRequestEnglish);
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const changed = () => {
      if (context.signal.aborted) {
        return;
      }
      context.props.onContentChange?.("before");
      setRevision((value) => value + 1);
    };
    const locale = {
      ...presentation,
      translate: (key: string, params?: Record<string, string>) => {
        revision();
        return presentation.translate(key, params);
      },
    };
    let key = "";
    const owner = {};
    const sync = () => {
      if (context.signal.aborted) {
        return;
      }
      key = initial.host.sessions.artifactKey(context.props);
      runtime.store.watch(owner, key ? [key] : [], {
        foreground: context.presented,
        passive: !context.presented,
      });
      changed();
    };
    const stopStore = runtime.store.subscribe(changed),
      stopHost = initial.host.subscribe(sync),
      stopLocale = presentation.subscribe(changed);
    const snapshot = () => {
      revision();
      return runtime.store.get(key);
    };
    const hasRequests = () => {
      const value = snapshot();
      return Boolean(
        value &&
        (value.pullRequests.length ||
          (value.taskPullRequests?.length ?? 0) ||
          value.status !== "ready"),
      );
    };
    const stop = mountPluginContent(() => {
      // Complete every owner update after the corresponding DOM bindings commit.
      createEffect(
        () => ({ revision: revision(), notify: context.props.onContentChange }),
        ({ notify }) => {
          if (!context.signal.aborted) {
            notify?.("after");
          }
        },
      );
      return (
        <PresentationContext value={locale}>
          <NativeContext value={native}>
            <Show when={snapshot()?.branch}>
              {(branch) => (
                <section class="session-hovercard__section session-hovercard__section--metadata">
                  <div class="session-hovercard__context">
                    <div class="session-hovercard__context-row" aria-label={branch().branch}>
                      <span class="session-hovercard__context-icon" aria-hidden="true">
                        <Icon name="gitBranch" />
                      </span>
                      <span class="session-hovercard__context-value session-hovercard__context-text">
                        {branch().repo} <span class="session-hovercard__context-separator">/</span>{" "}
                        {branch().branch}
                      </span>
                      <Show when={!snapshot()?.pullRequests.length}>
                        <SessionGitDiff classPrefix="session-hovercard" item={branch()} />
                      </Show>
                    </div>
                  </div>
                </section>
              )}
            </Show>
            <Show when={hasRequests()}>
              <section class="session-hovercard__section session-hovercard__section--prs">
                <PullRequestDetails
                  snapshot={snapshot()}
                  registerControls={context.props.registerControls}
                />
                <Show when={snapshot()?.status !== "ready"}>
                  <div class="session-hovercard__more" role="status">
                    {locale.translate(
                      snapshot()?.status === "rate-limited"
                        ? "chat.pullRequests.rateLimited"
                        : "chat.pullRequests.unavailable",
                    )}
                  </div>
                </Show>
              </section>
            </Show>
          </NativeContext>
        </PresentationContext>
      );
    }, container);
    sync();
    return {
      update(next: AccessoryContext) {
        context = next;
        sync();
      },
      dispose() {
        stopHost();
        stopStore();
        stopLocale();
        runtime.store.unwatch(owner);
        stop();
      },
    };
  };
}
