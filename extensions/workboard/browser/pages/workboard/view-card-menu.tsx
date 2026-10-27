/** @jsxImportSource @solidjs/web */
import type { JSX } from "@solidjs/web";
import {
  createContext,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
  Show,
  useContext,
} from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import {
  CardAction,
  CardMoveControl,
  getCardActionState,
  OpenSessionCardAction,
  StartExecutionButton,
} from "./view-card-actions.tsx";
import { openCardDetails, workboardCardDetailDrawerId } from "./view-card-details.tsx";
import { workboardViewState, type WorkboardProps } from "./view-helpers.tsx";
import { closeWorkboardPopoverOnAction, workboardPopoverRef } from "./view-popover.ts";

export function equalCardActions(
  previous: ReturnType<typeof getCardActionState>,
  next: ReturnType<typeof getCardActionState>,
) {
  return (
    previous.busy === next.busy &&
    previous.live === next.live &&
    previous.linkedSessionKey === next.linkedSessionKey &&
    previous.writable === next.writable &&
    previous.showStartControls === next.showStartControls &&
    previous.archived === next.archived &&
    previous.sessionTarget?.sessionKey === next.sessionTarget?.sessionKey &&
    previous.sessionTarget?.agentId === next.sessionTarget?.agentId
  );
}

type CardMenuOwner = {
  id: string;
  prepare: (cardId: string, trigger: HTMLButtonElement) => void;
  release: (trigger: HTMLButtonElement) => void;
};

const CardMenuContext = createContext<CardMenuOwner>();

export function WorkboardCardMenuTrigger(props: { cardId: string }) {
  const menu = useContext(CardMenuContext);
  let trigger!: HTMLButtonElement;
  onSettled(() => () => menu.release(trigger));
  return (
    <button
      ref={(element) => {
        trigger = element;
      }}
      type="button"
      class="workboard-card__menu-trigger"
      aria-label={t("workboard.cardActions")}
      aria-haspopup="dialog"
      aria-expanded="false"
      popovertarget={menu.id}
      onClick={(event) => menu.prepare(props.cardId, event.currentTarget)}
    >
      {icons.moreHorizontal}
    </button>
  );
}

export function WorkboardCardMenus(props: {
  workboard: WorkboardProps;
  cards: WorkboardCard[];
  // The caller keeps this stable surface inside its existing inert boundary.
  children: (panel: JSX.Element, selectedCardId: () => string | undefined) => JSX.Element;
}) {
  const id = `workboard-card-menu-${createUniqueId()}`;
  let panel!: HTMLDivElement;
  let activeTrigger: HTMLButtonElement | undefined;
  const [selectedId, setSelectedId] = createSignal<string>();
  const card = createMemo(() => {
    const cardId = selectedId();
    return cardId === undefined
      ? props.cards[0]
      : props.cards.find((candidate) => candidate.id === cardId);
  });
  const menu: CardMenuOwner = {
    id,
    prepare(cardId, trigger) {
      if (activeTrigger === trigger) {
        return;
      }
      panel.hidePopover();
      activeTrigger?.setAttribute("aria-expanded", "false");
      activeTrigger = trigger;
      setSelectedId(cardId);
    },
    release(trigger) {
      if (activeTrigger !== trigger) {
        return;
      }
      panel.hidePopover();
      trigger.setAttribute("aria-expanded", "false");
      activeTrigger = undefined;
      setSelectedId(undefined);
    },
  };
  const popover = workboardPopoverRef("end", false, () => activeTrigger);
  return (
    <CardMenuContext value={menu}>
      {props.children(
        <div
          id={id}
          popover="auto"
          role="dialog"
          aria-label={t("workboard.cardActions")}
          class="workboard-card__action-menu-panel"
          ref={[
            popover,
            (element) => {
              panel = element;
            },
          ]}
          onClick={closeWorkboardPopoverOnAction}
        >
          <Show when={card()}>
            {(current) => <CardMenuContent workboard={props.workboard} card={current()} />}
          </Show>
        </div>,
        selectedId,
      )}
    </CardMenuContext>
  );
}

function CardMenuContent(props: { workboard: WorkboardProps; card: WorkboardCard }) {
  const state = workboardViewState(() => props.workboard);
  const action = createMemo(
    () => {
      state();
      return getCardActionState(props.workboard, props.card);
    },
    { equals: equalCardActions },
  );
  const detailOpen = () => state().detailCardId === props.card.id;
  const showDetails = () => {
    openCardDetails(state(), props.card);
    props.workboard.onRequestUpdate?.();
  };
  const MoveAction = () => (
    <CardMoveControl workboard={props.workboard} card={props.card} busy={action().busy} />
  );
  return (
    <>
      <div class="workboard-card__menu-group">
        <button
          class="btn"
          type="button"
          autofocus
          aria-label={t("workboard.viewDetails")}
          aria-haspopup="dialog"
          aria-expanded={detailOpen() ? "true" : "false"}
          aria-controls={workboardCardDetailDrawerId}
          onClick={showDetails}
        >
          {icons.eye}
          <span>{t("workboard.viewDetails")}</span>
        </button>{" "}
        {action().writable && !action().archived ? (
          <CardAction kind="edit" workboard={props.workboard} card={props.card} />
        ) : null}
      </div>
      {action().showStartControls ||
      action().sessionTarget ||
      (action().writable && action().linkedSessionKey && action().live) ? (
        <div class="workboard-card__menu-group">
          {action().showStartControls ? (
            <StartExecutionButton
              workboard={props.workboard}
              card={props.card}
              engine={null}
              mode="autonomous"
            />
          ) : null}{" "}
          <OpenSessionCardAction workboard={props.workboard} session={action().sessionTarget} />{" "}
          {action().writable && action().linkedSessionKey && action().live ? (
            <CardAction
              kind="stop"
              workboard={props.workboard}
              card={props.card}
              busy={action().busy}
            />
          ) : null}
        </div>
      ) : null}
      {!(!action().archived && action().writable) ? null : (
        <div class="workboard-card__menu-status">
          <span>{t("workboard.moveTo")}</span>
          <MoveAction />
        </div>
      )}
      {action().writable ? (
        <div class="workboard-card__menu-group">
          <CardAction
            kind="archive"
            workboard={props.workboard}
            card={props.card}
            busy={action().busy}
            archived={action().archived}
          />{" "}
          <CardAction
            kind="delete"
            workboard={props.workboard}
            card={props.card}
            busy={action().busy}
          />
        </div>
      ) : null}
    </>
  );
}
