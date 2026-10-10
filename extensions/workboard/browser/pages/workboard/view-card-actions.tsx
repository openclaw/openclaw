/** @jsxImportSource @solidjs/web */
import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, onCleanup } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import {
  isActiveWorkboardCard,
  nextWorkboardCardPosition,
  workboardCardSessionKey,
} from "../../lib/workboard/card-state.ts";
import { canStartWorkboardCard } from "../../lib/workboard/execution.ts";
import {
  archiveWorkboardCard,
  deleteWorkboardCard,
  findWorkboardSession,
  getWorkboardState,
  moveWorkboardCard,
  startWorkboardCard,
  stopWorkboardCard,
  type WorkboardCard,
  type WorkboardExecutionEngine,
  type WorkboardExecutionMode,
  type WorkboardStatus,
} from "../../lib/workboard/index.ts";
import { workboardCardSessionTarget } from "../../lib/workboard/session-resolution.ts";
import { openEditModal } from "./view-card-modal.tsx";
import {
  canMutate,
  cardHasUnresolvedStartedRun,
  engineBlockedByRuntime,
  formatStatusLabel,
  workboardMutationContext,
  type WorkboardProps,
} from "./view-helpers.tsx";
export async function moveCardToStatus(
  props: WorkboardProps,
  card: WorkboardCard,
  status: WorkboardStatus,
) {
  const state = getWorkboardState(props.host);
  if (
    !isActiveWorkboardCard(card) ||
    status === card.status ||
    state.busyCardIds.has(card.id) ||
    state.dispatching ||
    !canMutate(props) ||
    !props.connected ||
    !props.client
  ) {
    return;
  }
  await moveWorkboardCard({
    ...workboardMutationContext(props),
    cardId: card.id,
    status,
    position: nextWorkboardCardPosition(state.cards, card, status),
  });
}
export function CardMoveControl(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
  options?: {
    wide?: boolean;
  };
}) {
  const state = () => {
    void input.workboard.revision;
    return getWorkboardState(input.workboard.host);
  };
  const statuses = createMemo(() =>
    state().statuses.includes(input.card.status)
      ? state().statuses
      : [input.card.status, ...state().statuses],
  );
  const StatusSelect = () => {
    let select: HTMLSelectElement | undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
        return;
      }
      if (
        state().busyCardIds.has(input.card.id) ||
        state().dispatching ||
        !input.workboard.connected ||
        !input.workboard.client
      ) {
        event.preventDefault();
        return;
      }
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const status = statuses()[statuses().indexOf(input.card.status) + offset];
      if (!status) {
        return;
      }
      event.preventDefault();
      void moveCardToStatus(input.workboard, input.card, status);
    };
    onCleanup(() => {
      if (select) {
        select.removeEventListener("keydown", handleKeyDown);
      }
    });
    return (
      <select
        class="workboard-card__move-select"
        aria-keyshortcuts="ArrowLeft ArrowRight"
        aria-label={`${t("workboard.fieldStatus")}: ${input.card.title}`}
        value={input.card.status}
        disabled={input.busy || !input.workboard.connected || !input.workboard.client}
        onChange={(event: Event) => {
          const target = event.currentTarget;
          if (!(target instanceof HTMLSelectElement)) {
            return;
          }
          const status = statuses().find((candidate) => candidate === target.value);
          if (status) {
            void moveCardToStatus(input.workboard, input.card, status);
          }
        }}
        ref={(element: HTMLSelectElement) => {
          select = element;
          element.addEventListener("keydown", handleKeyDown);
        }}
      >
        <For each={statuses()} keyed={(status) => status}>
          {(status) => (
            <option value={status()} selected={status() === input.card.status}>
              {formatStatusLabel(status())}
            </option>
          )}
        </For>
      </select>
    );
  };
  return (
    <>
      {!isActiveWorkboardCard(input.card) || statuses().length < 2 ? null : (
        <label
          class={["workboard-card__move", input.options?.wide ? "workboard-card__move--wide" : ""]}
          title={t("workboard.fieldStatus")}
        >
          <StatusSelect />
          <span class="workboard-card__move-chevron" aria-hidden="true">
            {icons.chevronDown}
          </span>
        </label>
      )}
    </>
  );
}
export function getCardActionState(props: WorkboardProps, card: WorkboardCard) {
  const state = getWorkboardState(props.host);
  const session = findWorkboardSession(card, props.sessions, props.sessionResolution);
  const linkedSessionKey = workboardCardSessionKey(card);
  const sessionTarget = workboardCardSessionTarget(
    card,
    session
      ? {
          sessionKey: session.key,
          ...(session.agentId
            ? {
                agentId: session.agentId,
              }
            : {}),
        }
      : undefined,
  );
  const busy = state.busyCardIds.has(card.id) || state.dispatching;
  const writable = canMutate(props);
  const live =
    cardHasUnresolvedStartedRun(card) ||
    session?.hasActiveRun === true ||
    (session?.hasActiveRun !== false && session?.status === "running");
  return {
    state,
    busy,
    live,
    linkedSessionKey,
    sessionTarget,
    writable,
    showStartControls: writable && canStartWorkboardCard(card),
    archived: Boolean(card.metadata?.archivedAt),
  };
}
function CardActionButton(input: {
  params: {
    label: string;
    icon: JSX.Element;
    className?: string;
    disabled?: boolean;
    ariaHaspopup?: "dialog";
    onClick: (event: MouseEvent) => void;
    requestAction?: (action: () => void) => void;
  };
}) {
  return (
    <button
      class={["btn", input.params.className ?? ""]}
      type="button"
      aria-label={input.params.label}
      aria-haspopup={input.params.ariaHaspopup}
      disabled={input.params.disabled}
      onClick={(event: MouseEvent) => {
        if (input.params.requestAction) {
          input.params.requestAction(() => input.params.onClick(event));
        } else {
          input.params.onClick(event);
        }
      }}
    >
      {input.params.icon}
      <span>{input.params.label}</span>
    </button>
  );
}
export function EditCardAction(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  options?: {
    requestAction?: (action: () => void) => void;
  };
}) {
  const state = () => {
    void input.workboard.revision;
    return getWorkboardState(input.workboard.host);
  };
  return (
    <CardActionButton
      params={{
        label: t("workboard.editCard"),
        icon: icons.edit,
        requestAction: input.options?.requestAction,
        ariaHaspopup: "dialog",
        disabled: state().dispatching,
        onClick: () => {
          openEditModal(state(), input.card);
          input.workboard.onRequestUpdate?.();
        },
      }}
    />
  );
}
export function ArchiveCardAction(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
  archived: boolean;
  options?: {
    requestAction?: (action: () => void) => void;
  };
}) {
  const label = createMemo(() =>
    input.archived ? t("workboard.unarchiveCard") : t("workboard.archiveCard"),
  );
  return (
    <CardActionButton
      params={{
        label: label(),
        icon: input.archived ? icons.archiveRestore : icons.archive,
        requestAction: input.options?.requestAction,
        disabled: input.busy,
        onClick: () => {
          void archiveWorkboardCard({
            ...workboardMutationContext(input.workboard),
            cardId: input.card.id,
            archived: !input.archived,
          });
        },
      }}
    />
  );
}
export function OpenSessionCardAction(input: {
  workboard: WorkboardProps;
  session: BoardGetParams | undefined;
  options?: {
    quiet?: boolean;
  };
}) {
  const open = () => {
    const session = input.session;
    if (session) {
      input.workboard.onOpenSession(session);
    }
  };
  return (
    <Show when={input.session}>
      {input.options?.quiet ? (
        <button type="button" class="workboard-detail__session-link" onClick={open}>
          {t("workboard.openSession")}
        </button>
      ) : (
        <CardActionButton
          params={{
            label: t("workboard.openSession"),
            icon: icons.messageSquare,
            onClick: open,
          }}
        />
      )}
    </Show>
  );
}
export function StopCardAction(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
}) {
  return (
    <CardActionButton
      params={{
        label: t("workboard.stopSession"),
        icon: icons.stop,
        disabled: input.busy || !input.workboard.connected,
        onClick: () => {
          void stopWorkboardCard({
            ...workboardMutationContext(input.workboard),
            card: input.card,
            session: getCardActionState(input.workboard, input.card).sessionTarget,
          });
        },
      }}
    />
  );
}
export function DeleteCardAction(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  busy: boolean;
  options?: {
    requestAction?: (action: () => void) => void;
  };
}) {
  return (
    <CardActionButton
      params={{
        label: t("workboard.deleteCard"),
        icon: icons.trash,
        requestAction: input.options?.requestAction,
        className: "workboard-card__delete",
        disabled: input.busy,
        onClick: () => {
          void deleteWorkboardCard({
            ...workboardMutationContext(input.workboard),
            cardId: input.card.id,
          });
        },
      }}
    />
  );
}
export function StartExecutionButton(input: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  engine: WorkboardExecutionEngine | null;
  mode: WorkboardExecutionMode;
}) {
  const state = () => {
    void input.workboard.revision;
    return getWorkboardState(input.workboard.host);
  };
  const busy = createMemo(() => state().busyCardIds.has(input.card.id) || state().dispatching);
  const runtimeBlock = createMemo(() =>
    engineBlockedByRuntime(input.workboard, input.card, input.engine),
  );
  const engineName = createMemo(() =>
    input.engine === "codex" ? t("workboard.engineOpenAI") : t("workboard.engineClaude"),
  );
  const disabled = createMemo(
    () =>
      busy() ||
      !input.workboard.connected ||
      Boolean(runtimeBlock()) ||
      Boolean(input.card.metadata?.archivedAt),
  );
  const title = createMemo(() => {
    const blocked = runtimeBlock();
    return blocked
      ? blocked
      : input.engine
        ? input.mode === "autonomous"
          ? t("workboard.runEngine", {
              engine: engineName(),
            })
          : t("workboard.openEngine", {
              engine: engineName(),
            })
        : t("workboard.runDefaultAgent");
  });
  const start = async () => {
    const key = await startWorkboardCard({
      ...workboardMutationContext(input.workboard),
      card: input.card,
      ...(input.engine
        ? {
            engine: input.engine,
          }
        : {}),
      mode: input.mode,
    });
    if (key) {
      input.workboard.onOpenSession({
        sessionKey: key,
      });
    }
  };
  return (
    <button
      class={[
        "btn",
        "btn--xs",
        "workboard-card__start",
        `workboard-card__start--${input.mode}`,
        input.engine ? "" : "workboard-card__start--default",
      ]}
      type="button"
      aria-label={title()}
      disabled={disabled()}
      onClick={() => void start()}
    >
      {input.engine ? (
        <span>{engineName()}</span>
      ) : (
        <>
          {input.mode === "autonomous" ? icons.play : icons.penLine}
          <span>{t("workboard.start")}</span>
        </>
      )}
    </button>
  );
}
