/** @jsxImportSource @solidjs/web */

import type { SessionCatalogPullRequestSummary } from "@openclaw/gateway-protocol";
import type {
  ControlUiSessionAccessory,
  ControlUiAccessoryProps,
  ControlUiHostV2,
} from "openclaw/plugin-sdk/control-ui";
import { createSignal, createEffect, createMemo, Show } from "solid-js";
import { Icon, Tooltip } from "./presentation-components.tsx";
import { PresentationContext } from "./presentation-context.ts";
import { pullRequestEnglish } from "./pull-request-english.ts";
import { mountPluginContent } from "./render-owned.ts";
import type { RepositoryBrowserRuntime } from "./repository-runtime.ts";
import { summarizeSessionPullRequests } from "./session-pull-requests.ts";
import { projectSidebarBadge } from "./sidebar-badge-presentation.ts";
type AccessoryContext = {
  host: ControlUiHostV2;
  props: ControlUiAccessoryProps;
  signal: AbortSignal;
  presented: boolean;
};
export function createSidebarAccessoryMount(
  runtime: RepositoryBrowserRuntime,
): ControlUiSessionAccessory["mount"] {
  return (container: HTMLElement, initial: AccessoryContext) => {
    const presentation = initial.host.presentation;
    if (!presentation) {
      throw new Error("Repository presentation services are unavailable.");
    }
    presentation.registerEnglish(pullRequestEnglish);
    let currentContext = initial;
    const [context, setContext] = createSignal(initial, { ownedWrite: true });
    const [revision, setRevision] = createSignal(0, { ownedWrite: true });
    const stopLocale = presentation.subscribe(() => setRevision((value) => value + 1));
    const locale = {
      ...presentation,
      translate: (key: string, params?: Record<string, string>) => {
        revision();
        return presentation.translate(key, params);
      },
    };
    const owner = {};
    let key = "";
    const changed = () => {
      if (!currentContext.signal.aborted) {
        setRevision((value) => value + 1);
      }
    };
    const sync = () => {
      if (currentContext.signal.aborted) {
        return;
      }
      const current = currentContext;
      key = current.host.sessions.artifactKey(current.props);
      runtime.store.watch(owner, current.presented && key ? [key] : [], { passive: true });
      changed();
    };
    const stopHost = initial.host.subscribe(sync);
    const stopStore = runtime.store.subscribe(changed);
    const readBadge = () => {
      const current = context();
      if (current.signal.aborted || !container.isConnected) {
        return undefined;
      }
      revision();
      const value = current.props.artifact;
      const readable = current.host.requests.canCall(
        "controlUi.sessionPullRequests.subscribe",
        "operator.read",
        true,
      );
      const initialSummary =
        (!current.props.worktreeId ||
          (readable && current.host.requests.hasScope("operator.read"))) &&
        isSummary(value)
          ? value
          : undefined;
      const snapshot = runtime.store.get(key);
      const requests = [
        ...(snapshot?.pullRequests ?? []),
        ...(snapshot?.taskPullRequests ?? []).flatMap((task) =>
          task.pullRequest ? [task.pullRequest] : [],
        ),
      ];
      const branchKnown = runtime.store.branchKnown(key);
      const summary =
        summarizeSessionPullRequests(requests) ?? (!branchKnown ? initialSummary : undefined);
      const count =
        snapshot &&
        !branchKnown &&
        snapshot.pullRequests.length === 0 &&
        !snapshot.taskPullRequestCount
          ? undefined
          : (snapshot?.pullRequestCount ??
            (snapshot
              ? Math.max(
                  new Set(
                    [...snapshot.pullRequests, ...(snapshot.taskPullRequests ?? [])].map(
                      (request) => request.url,
                    ),
                  ).size,
                  snapshot.taskPullRequestCount ?? 0,
                )
              : undefined));
      return projectSidebarBadge(summary, count, locale.translate);
    };
    const stop = mountPluginContent(() => {
      const badge = createMemo(readBadge);
      // Logical content presence drives the native row's existing coding fallback.
      createEffect(
        () => Boolean(badge()),
        (present) => {
          if (!currentContext.signal.aborted) {
            currentContext.props.onPresenceChange?.(present);
          }
        },
      );
      return (
        <PresentationContext value={locale}>
          <Show when={badge()}>
            <span class="session-row-badges">
              <Tooltip content={badge()?.label ?? ""}>
                <span
                  class="session-row-badge session-row-badge--pull-request"
                  data-pull-request-state={badge()?.state}
                  role="img"
                  aria-label={badge()?.label}
                >
                  <Icon name={badge()?.icon ?? "gitPullRequest"} />
                  <Show when={badge()?.count}>
                    <span aria-hidden="true">{badge()?.count}</span>
                  </Show>
                </span>
              </Tooltip>
            </span>
          </Show>
        </PresentationContext>
      );
    }, container);
    sync();
    return {
      update(next: AccessoryContext) {
        currentContext = next;
        setContext(next);
        sync();
      },
      dispose() {
        stopLocale();
        stopHost();
        stopStore();
        runtime.store.unwatch(owner);
        stop();
      },
    };
  };
}

function isSummary(value: unknown): value is SessionCatalogPullRequestSummary {
  return (
    typeof value === "object" &&
    value !== null &&
    "numbers" in value &&
    Array.isArray(value.numbers) &&
    value.numbers.every((number) => typeof number === "number") &&
    "state" in value &&
    ["open", "draft", "merged", "closed"].includes(String(value.state))
  );
}
