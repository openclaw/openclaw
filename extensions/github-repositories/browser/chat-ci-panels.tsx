/** @jsxImportSource @solidjs/web */
import { lazy, useContext, type ComponentProps } from "solid-js";
import type { ChatCiDisclosureProps } from "./chat-ci-disclosure.ts";
import { RepositoryCiContext } from "./ci-context.ts";
import { PluginLazyBoundary } from "./plugin-lazy-boundary.tsx";
import { presentationTranslator } from "./presentation-context.ts";
const Details = lazy(() => import("./chat-ci-details.tsx"), { export: "ChatCiDetails" });
const Automation = lazy(() => import("./chat-ci-automation-control.tsx"), {
  export: "ChatCiAutomation",
});

function captureCiCurrent(props: ChatCiDisclosureProps) {
  const services = useContext(RepositoryCiContext);
  return () => {
    const target = { sessionKey: props.sessionKey, pullRequest: props.pullRequest };
    const requests = services.requests;
    return () =>
      services.requests === requests &&
      props.presented &&
      props.sessionKey === target.sessionKey &&
      props.pullRequest === target.pullRequest &&
      services.isPresented() &&
      services.isCurrent(target);
  };
}
export function ChatCiDetailsPanel(props: ComponentProps<typeof Details>) {
  const t = presentationTranslator();
  const captureCurrent = captureCiCurrent(props);
  return (
    <PluginLazyBoundary
      captureCurrent={captureCurrent}
      fallback={
        <div class="chat-ci__notice" role="status">
          {t("common.loading")}
        </div>
      }
    >
      <Details {...props} />
    </PluginLazyBoundary>
  );
}
export function ChatCiAutomationPanel(props: ComponentProps<typeof Automation>) {
  const t = presentationTranslator();
  const captureCurrent = captureCiCurrent(props);
  return (
    <PluginLazyBoundary
      captureCurrent={captureCurrent}
      fallback={
        <div class="chat-ci__notice" role="status">
          {t("common.loading")}
        </div>
      }
    >
      <Automation {...props} />
    </PluginLazyBoundary>
  );
}
