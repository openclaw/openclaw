/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type { ControlUiAccessory } from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, Show } from "solid-js";
import { icons } from "./components/icons.tsx";
import { t } from "./i18n/index.ts";
import { workboardCardBoardId } from "./lib/workboard/board-filter.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { isActiveWorkboardCard } from "./lib/workboard/card-state.ts";
import { findWorkboardSessionCard } from "./lib/workboard/session-links.ts";
import { matchesAgentScope } from "./pages/workboard/agent-filter.ts";
import { workboardPageTarget } from "./pages/workboard/page-target.ts";

export function createWorkboardSessionAccessory(
  workboard: WorkboardCapability,
): ControlUiAccessory["mount"] {
  return (container, initialContext) => {
    let context = initialContext;
    let disposed = false;
    const host = context.host;
    const [revision, setRevision] = createSignal(0);
    const publish = () => setRevision((value) => value + 1);
    function SessionAccessory() {
      const card = createMemo(() => {
        revision();
        const current =
          context.presented && host.connection.connected
            ? findWorkboardSessionCard(workboard.state.cards, context.props.sessionKey)
            : null;
        return current && isActiveWorkboardCard(current) ? current : null;
      });
      const target = () => workboardPageTarget(workboardCardBoardId(card()!));
      return (
        <Show when={card()}>
          {(current) => (
            <a
              class="workboard-session-chip"
              href={host.navigation.pageHref(target())}
              aria-label={`${current().title} — ${t(`workboard.status.${current().status}`)}`}
              onClick={(event: MouseEvent) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                event.preventDefault();
                if (
                  disposed ||
                  !context.presented ||
                  context.signal.aborted ||
                  !host.connection.connected
                ) {
                  return;
                }
                const activeCard = findWorkboardSessionCard(
                  workboard.state.cards,
                  context.props.sessionKey,
                );
                if (!activeCard || !isActiveWorkboardCard(activeCard)) {
                  return;
                }
                if (
                  !matchesAgentScope(
                    activeCard,
                    host.agents.defaultId ?? host.connection.assistantAgentId,
                    host.agents.scopeId,
                  )
                ) {
                  host.agents.setScope(null);
                }
                host.navigation.openPage(workboardPageTarget(workboardCardBoardId(activeCard)));
              }}
            >
              {icons.kanban}
              <span class="workboard-session-chip__title">{current().title}</span>
              <span class="workboard-session-chip__status">
                {t(`workboard.status.${current().status}`)}
              </span>
            </a>
          )}
        </Show>
      );
    }
    const disposeRoot = render(() => <SessionAccessory />, container);
    const stopHost = host.subscribe(publish);
    const stopState = workboard.subscribe(publish);
    return {
      update(next) {
        context = next;
        publish();
      },
      dispose() {
        disposed = true;
        stopHost();
        stopState();
        disposeRoot();
      },
    };
  };
}
