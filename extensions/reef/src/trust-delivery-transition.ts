import { sameReefPeerIdentity, type ReefPeerIdentity } from "./friend-types.js";
import {
  matchesReefDeliveryBinding,
  ReefOutboundDeliverySchema,
  ReefOutboundRejectionSchema,
  ReefRejectionNoticeStateSchema,
  type currentReefDeliveries,
  type ReefOutboundDeliveryBinding,
} from "./trust-store-format.js";
import type { ReefDeliveryRejection, ReefRejectionNoticeState } from "./types.js";

export function rejectReefDelivery(
  value: unknown,
  expected: ReefOutboundDeliveryBinding,
  category: string | undefined,
  rejectedAt: number,
) {
  const parsed = ReefOutboundDeliverySchema.safeParse(value);
  if (!parsed.success || !matchesReefDeliveryBinding(parsed.data, expected)) {
    return undefined;
  }
  return {
    changed: parsed.data.rejection === undefined,
    delivery: parsed.data.rejection
      ? parsed.data
      : {
          ...parsed.data,
          rejection: ReefOutboundRejectionSchema.parse({
            ...(category ? { category } : {}),
            ...(parsed.data.resendDisabled ? { notice: { lastRejectionAt: rejectedAt } } : {}),
          }),
        },
  };
}

export function reserveReefRejection(
  value: unknown,
  recipient: ReefPeerIdentity,
  notice: ReefRejectionNoticeState,
) {
  const parsed = ReefOutboundDeliverySchema.safeParse(value);
  if (
    !parsed.success ||
    !parsed.data.rejection ||
    !sameReefPeerIdentity(parsed.data.recipient, recipient)
  ) {
    return undefined;
  }
  const existing = parsed.data.rejection.notice;
  return {
    delivery: existing
      ? parsed.data
      : {
          ...parsed.data,
          rejection: {
            ...parsed.data.rejection,
            notice: ReefRejectionNoticeStateSchema.parse(notice),
          },
        },
    outcome: existing
      ? ({ kind: "existing", state: existing } as const)
      : ({ kind: "reserved" } as const),
  };
}

export function overdueReefDeliveries(
  deliveries: ReturnType<typeof currentReefDeliveries>,
  olderThanMs: number,
  now: number,
) {
  return deliveries.flatMap(({ peer, id, delivery }) =>
    delivery.rejection ||
    delivery.overdueNotifiedAt !== undefined ||
    delivery.sentAt === undefined ||
    delivery.sentAt + olderThanMs > now
      ? []
      : [{ peer, id, sentAt: delivery.sentAt }],
  );
}

export function pendingReefRejections(
  deliveries: ReturnType<typeof currentReefDeliveries>,
): Omit<ReefDeliveryRejection, "recovery">[] {
  return deliveries
    .flatMap(({ peer, id, delivery }) =>
      delivery.rejection
        ? [
            {
              peer,
              id,
              recipient: delivery.recipient,
              ...(delivery.textHash ? { textHash: delivery.textHash } : {}),
              ...(delivery.rejection.category ? { category: delivery.rejection.category } : {}),
              ...(delivery.rejection.notice ? { reservedNotice: delivery.rejection.notice } : {}),
            },
          ]
        : [],
    )
    .toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}
