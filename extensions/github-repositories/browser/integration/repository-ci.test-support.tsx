/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import { createMemo, onCleanup } from "solid-js";
import type { ApplicationGateway } from "../../../../ui/src/app/gateway.ts";
import { parseAgentSessionKey } from "../../../../ui/src/lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../../ui/src/lib/solid-bridge.ts";
import { createControlUiNativeHost } from "../../../../ui/src/plugins/control-ui-native-host.tsx";
import { createControlUiPresentationHost } from "../../../../ui/src/plugins/control-ui-presentation-host.tsx";
import { createControlUiRequests } from "../../../../ui/src/plugins/control-ui-requests.ts";
import { createApplicationGateway } from "../../../../ui/src/test-helpers/application-context-fixtures.ts";
import { mountSolid } from "../../../../ui/src/test-helpers/mount-solid.ts";
import {
  ChatCiAutomation,
  ChatCiDetails,
  RepositoryCiContext,
  type ChatCiAutomationProps,
  type ChatCiDetailsProps,
  publicationEnglish,
  pullRequestEnglish,
  PresentationContext,
  NativeContext,
} from "../api.ts";

type Inputs = {
  gateway?: ApplicationGateway;
  live?: () => {
    presented: boolean;
    sessionKey: string;
    sessionId?: string;
    pullRequest?: { owner: string; repo: string; number: number; headSha?: string };
  };
};
/** The fixture adapts inputs only; the plugin's actual components own reads, writes and DOM. */
export function RepositoryPresentation(props: Inputs & { children: JSX.Element }) {
  const abort = new AbortController();
  const retained = new Set<() => void>();
  const fallback = createApplicationGateway().gateway;
  const source = createMemo(() => props.gateway ?? fallback);
  const requests = createMemo(() => {
    const gateway = source();
    const lifetime = new AbortController();
    onCleanup(() => lifetime.abort());
    return createControlUiRequests({
      current: () => ({ gateway }),
      signal: lifetime.signal,
      retain(dispose) {
        retained.add(dispose);
        return () => {
          retained.delete(dispose);
          dispose();
        };
      },
    });
  });
  const presentation = createControlUiPresentationHost(() => {
    abort.signal.throwIfAborted();
    return { gateway: source() };
  }, abort.signal);
  presentation.registerEnglish(publicationEnglish);
  presentation.registerEnglish(pullRequestEnglish);
  onCleanup(() => {
    abort.abort();
    retained.forEach((stop) => stop());
  });
  return (
    <PresentationContext value={presentation}>
      <NativeContext value={createControlUiNativeHost(abort.signal)}>
        <RepositoryCiContext
          value={{
            get requests() {
              return requests();
            },
            isPresented: () => props.live?.().presented ?? true,
            isCurrent: (target) => {
              const live = props.live?.();
              return (
                !live ||
                (live.sessionKey === target.sessionKey &&
                  (!target.sessionId || live.sessionId === target.sessionId) &&
                  (!target.pullRequest ||
                    (live.pullRequest?.owner === target.pullRequest.owner &&
                      live.pullRequest.repo === target.pullRequest.repo &&
                      live.pullRequest.number === target.pullRequest.number &&
                      (target.pullRequest.headSha === undefined ||
                        live.pullRequest.headSha === target.pullRequest.headSha))))
              );
            },
            agentId: (key) => parseAgentSessionKey(key)?.agentId,
          }}
        >
          {props.children}
        </RepositoryCiContext>
      </NativeContext>
    </PresentationContext>
  );
}

export function mountRepositorySolid(
  view: () => JSX.Element,
  options?: Parameters<typeof mountSolid>[1],
) {
  return mountSolid(() => <RepositoryPresentation>{view()}</RepositoryPresentation>, options);
}

type AutomationInputs = ChatCiAutomationProps & { gateway?: ApplicationGateway };
type DetailsInputs = ChatCiDetailsProps & { gateway?: ApplicationGateway };
export type CiAutomationTestElement = SolidBridgeElement<AutomationInputs>;
export type CiDetailsTestElement = SolidBridgeElement<DetailsInputs>;
declare global {
  interface HTMLElementTagNameMap {
    "oc-test-ci-details": CiDetailsTestElement;
    "oc-test-ci-automation": CiAutomationTestElement;
  }
}
// These distinct fixture tags never register or replace the plugin's actual host tags.
defineSolidBridge<AutomationInputs>(
  "oc-test-ci-automation",
  (props, host) => (
    <RepositoryPresentation gateway={props.gateway} live={() => host}>
      <ChatCiAutomation {...props} />
    </RepositoryPresentation>
  ),
  {
    properties: {
      gateway: { default: undefined, attribute: false },
      pullRequest: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      sessionId: { default: "", attribute: false },
      presented: { default: true, type: Boolean },
      inline: { default: false, attribute: false },
      menuPresentation: { default: false, attribute: false },
      controls: { default: undefined, attribute: false },
    },
  },
);
defineSolidBridge<DetailsInputs>(
  "oc-test-ci-details",
  (props, host) => (
    <RepositoryPresentation gateway={props.gateway} live={() => host}>
      <ChatCiDetails {...props} />
    </RepositoryPresentation>
  ),
  {
    properties: {
      gateway: { default: undefined, attribute: false },
      pullRequest: { default: undefined, attribute: false },
      sessionKey: { default: "", attribute: false },
      presented: { default: true, type: Boolean },
      inline: { default: false, attribute: false },
      menuControls: { default: false, attribute: false },
      controls: { default: undefined, attribute: false },
    },
  },
);
