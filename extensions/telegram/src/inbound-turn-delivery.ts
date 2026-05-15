export type TelegramInboundTurnDeliveryEnd = () => void;
export type TelegramInboundTurnDeliveryKind = "user_request" | "room_event";

type ActiveTurn = {
  outboundTo: string;
  outboundAccountId?: string;
  markInboundTurnDelivered: () => void;
};

const registry = new Map<string, ActiveTurn>();

export function resolveTelegramInboundTurnDeliveryCorrelationKey(
  sessionKey: string | undefined,
  inboundTurnKind?: TelegramInboundTurnDeliveryKind | string,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return inboundTurnKind === "room_event" ? `${key}:room_event` : key;
}

export function beginTelegramInboundTurnDeliveryCorrelation(
  sessionKey: string | undefined,
  turn: ActiveTurn,
  options?: { inboundTurnKind?: TelegramInboundTurnDeliveryKind | string },
): TelegramInboundTurnDeliveryEnd {
  const key = resolveTelegramInboundTurnDeliveryCorrelationKey(
    sessionKey,
    options?.inboundTurnKind,
  );
  if (!key) {
    return () => {};
  }
  registry.set(key, turn);
  return () => {
    registry.delete(key);
  };
}

export function notifyTelegramInboundTurnOutboundSuccess(params: {
  sessionKey: string | undefined;
  to: string;
  accountId?: string | null;
  inboundTurnKind?: TelegramInboundTurnDeliveryKind | string;
}): void {
  const key = resolveTelegramInboundTurnDeliveryCorrelationKey(
    params.sessionKey,
    params.inboundTurnKind,
  );
  if (!key) {
    return;
  }
  const turn = registry.get(key);
  if (!turn || turn.outboundTo !== params.to) {
    return;
  }
  if (turn.outboundAccountId && params.accountId && params.accountId !== turn.outboundAccountId) {
    return;
  }
  turn.markInboundTurnDelivered();
}
