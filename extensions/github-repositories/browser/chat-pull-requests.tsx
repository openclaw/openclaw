/** @jsxImportSource @solidjs/web */

import { Errored, Loading, Repeat, Show, lazy, onSettled, useContext } from "solid-js";
import { chatPullRequestRows } from "./chat-pull-request-rows.ts";
import type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
import { RepositoryCiContext } from "./ci-context.ts";
import { hostControl } from "./host-control.tsx";
import { ContentPresentation } from "./native-context.tsx";
import { PresentationContext } from "./presentation-context.ts";
import { hasChatPullRequests, showWorkRow } from "./pull-request-dismissal.ts";
export type { ChatPullRequestsProps } from "./chat-pull-request-shared.tsx";
export { hasChatPullRequests } from "./pull-request-dismissal.ts";

/** Keep the large presenter lazy; document recovery remains with the native host. */
export function ChatPullRequests(props: ChatPullRequestsProps) {
  const host = useContext(PresentationContext);
  const services = useContext(RepositoryCiContext);
  const parentPresented = useContext(ContentPresentation);
  const Content = lazy(() => import("./chat-pull-requests-content.tsx"), {
    export: "ChatPullRequestsContent",
  });
  return (
    <Show when={hasChatPullRequests(props)}>
      <Errored
        fallback={(error, reset) => {
          let active = true;
          onSettled(() => () => {
            active = false;
          });
          // A recovery belongs to the failed visible session, not a replacement view.
          const identity = {
            sessionKey: props.sessionKey,
            sessionId: props.sessionId,
            requests: services.requests,
          };
          return hostControl(
            () => ({
              status: "error" as const,
              error: error(),
              onRetry: () => reset(),
              isCurrent: () => {
                const presented = props.presented;
                return (
                  active &&
                  props.sessionKey === identity.sessionKey &&
                  props.sessionId === identity.sessionId &&
                  services.requests === identity.requests &&
                  hasChatPullRequests(props) &&
                  !props.dismissed &&
                  parentPresented() &&
                  (typeof presented === "object" ? presented.isPresented() : (presented ?? true))
                );
              },
            }),
            host.mountLazyState,
          );
        }}
      >
        <Loading
          fallback={
            <Show
              when={props.compact}
              fallback={
                <div class="chat-prs">
                  {hostControl(() => ({ status: "loading" as const }), host.mountLazyState)}
                </div>
              }
            >
              <div
                class="chat-prs"
                role="status"
                aria-busy="true"
                aria-label={host.translate("common.loading")}
              >
                <Repeat
                  count={
                    !props.publishedOnly && showWorkRow(props)
                      ? 1
                      : chatPullRequestRows(props).length
                  }
                >
                  {() => (
                    <div class="chat-pr chat-pr--compact chat-pr--summary" aria-hidden="true">
                      <span class="skeleton skeleton-line skeleton-line--long" />
                    </div>
                  )}
                </Repeat>
              </div>
            </Show>
          }
        >
          <Content {...props} />
        </Loading>
      </Errored>
    </Show>
  );
}
