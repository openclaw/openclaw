/** @jsxImportSource @solidjs/web */
import { createMemo } from "solid-js";
import { icons } from "../../components/icons.tsx";
import { t } from "../../i18n/index.ts";
import type { WorkboardCard, WorkboardLifecycle } from "../../lib/workboard/index.ts";
import { cardAgentLabel } from "./agent-filter.ts";
import {
  OpenSessionCardAction,
  StartExecutionButton,
  StopCardAction,
  type getCardActionState,
} from "./view-card-actions.tsx";
import { formatLifecycle, renderLifecycleIcon, type WorkboardProps } from "./view-helpers.tsx";
import { getSessionStatus, SessionStatusBadge } from "./view-session-status.tsx";

const workboardCardDetailDescriptionId = "workboard-card-detail-description";

export function CardSessionHeading(props: {
  workboard: WorkboardProps;
  card: WorkboardCard;
  lifecycle: WorkboardLifecycle;
  action: ReturnType<typeof getCardActionState>;
  tab: "overview" | "session";
}) {
  const formatted = createMemo(() => formatLifecycle(props.lifecycle));
  const sessionStatus = createMemo(() => getSessionStatus(props.card, props.lifecycle));
  const sessionStateLabel = () => formatted().label;
  const sessionEmpty = () => props.lifecycle.state === "unlinked" && !props.action.linkedSessionKey;
  return (
    <div class="workboard-detail__execution-main">
      <div class="workboard-detail__session-row" title={formatted().detail}>
        {sessionEmpty() || !sessionStatus().visible ? (
          <span
            class="workboard-detail__session-state-icon"
            role="img"
            aria-label={sessionStateLabel()}
            title={sessionStateLabel()}
          >
            {sessionEmpty() ? icons.bot : renderLifecycleIcon(props.lifecycle)}
          </span>
        ) : undefined}
        <div class="workboard-detail__session-copy">
          <span
            class="workboard-detail__session-name"
            id={props.tab === "overview" ? workboardCardDetailDescriptionId : undefined}
          >
            {sessionEmpty()
              ? t("workboard.detailNoSessionYet")
              : (props.lifecycle.session?.displayName ??
                props.lifecycle.session?.label ??
                (props.action.linkedSessionKey ? t("workboard.fieldSession") : formatted().label))}
          </span>
          {!sessionEmpty() && sessionStatus().detail ? (
            <p class="workboard-detail__session-description" textContent={sessionStatus().detail} />
          ) : undefined}
          {sessionEmpty() && props.action.showStartControls && !props.action.archived ? (
            <p class="workboard-detail__session-help">
              {t("workboard.detailStartSessionHelp", {
                agent: cardAgentLabel(props.card, props.workboard.agentsList),
              })}
            </p>
          ) : undefined}
        </div>
        <SessionStatusBadge presentation={sessionStatus()} />
      </div>
      <div class="workboard-detail__actions">
        {props.tab === "overview" && props.action.showStartControls ? (
          <StartExecutionButton
            workboard={props.workboard}
            card={props.card}
            engine={null}
            mode={"autonomous"}
          />
        ) : undefined}
        {props.tab === "overview" &&
        props.action.writable &&
        props.action.linkedSessionKey &&
        props.action.live ? (
          <StopCardAction workboard={props.workboard} card={props.card} busy={props.action.busy} />
        ) : undefined}
        <OpenSessionCardAction
          workboard={props.workboard}
          session={props.action.sessionTarget}
          options={{ quiet: true }}
        />
      </div>
    </div>
  );
}
