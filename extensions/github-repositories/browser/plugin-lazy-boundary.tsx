/** @jsxImportSource @solidjs/web */
import { Errored, Loading, onSettled, useContext, type Element } from "solid-js";
import { hostControl } from "./host-control.tsx";
import { PresentationContext } from "./presentation-context.ts";

/** Optional plugin content keeps its failed target until retry or retirement. */
export function PluginLazyBoundary(props: {
  children: Element;
  fallback?: Element;
  captureCurrent: () => () => boolean;
}) {
  const host = useContext(PresentationContext);
  return (
    <Errored
      fallback={(error, reset) => {
        const current = props.captureCurrent();
        let active = true;
        onSettled(() => () => {
          active = false;
        });
        return hostControl(
          () => ({
            status: "error" as const,
            error: error(),
            onRetry: () => reset(),
            isCurrent: () => active && current(),
          }),
          host.mountLazyState,
        );
      }}
    >
      <Loading fallback={props.fallback}>{props.children}</Loading>
    </Errored>
  );
}
