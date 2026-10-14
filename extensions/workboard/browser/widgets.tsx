/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiHost, ControlUiWidget } from "openclaw/plugin-sdk/control-ui";
import { createSignal, Show } from "solid-js";
import {
  WorkboardBoardWidget,
  WorkboardCardWidget,
  WorkboardMiniWidget,
} from "./widgets/render.tsx";
import { acquireWidgetRuntime, WorkboardWidgetModel } from "./widgets/runtime.ts";

export function createWorkboardWidget(
  activationHost: ControlUiHost,
  kind: "mini" | "card" | "board",
): ControlUiWidget["mount"] {
  const Renderer =
    kind === "mini"
      ? WorkboardMiniWidget
      : kind === "card"
        ? WorkboardCardWidget
        : WorkboardBoardWidget;
  return (container, initialContext) => {
    let context = initialContext;
    let lease: ReturnType<typeof acquireWidgetRuntime> | null = null;
    const [model, setModel] = createSignal<WorkboardWidgetModel | null>(null);
    const [revision, setRevision] = createSignal(0);
    const draw = () => {
      if (!context.presented || !lease) {
        return;
      }
      setModel(
        new WorkboardWidgetModel(
          context.host,
          lease.runtime,
          context.props.widget.props ?? {},
          () => context.presented && lease !== null && !context.signal.aborted,
          () => context.props.canMutate && context.host.connection.canWrite,
        ),
      );
      setRevision((value) => value + 1);
    };
    const sync = () => {
      // The activation owns shared reads; each mount retains its own presentation.
      if (context.presented && !lease) {
        lease = acquireWidgetRuntime(activationHost, draw);
      }
      if (!context.presented && lease) {
        lease.release();
        lease = null;
        setRevision((value) => value + 1);
      }
      draw();
    };
    const disposeRoot = render(
      () => (
        <Show when={model() !== null}>
          <Renderer model={model()!} revision={revision()} />
        </Show>
      ),
      container,
    );
    sync();
    return {
      update(next) {
        context = next;
        sync();
      },
      dispose() {
        lease?.release();
        lease = null;
        disposeRoot();
      },
    };
  };
}
