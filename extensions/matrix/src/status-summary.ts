type TrafficStatusSnapshot = {
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
};

export function buildTrafficStatusSummary<TSnapshot extends TrafficStatusSnapshot>(
  snapshot?: TSnapshot | null,
) {
  return {
    lastInboundAt: snapshot?.lastInboundAt ?? null,
    lastOutboundAt: snapshot?.lastOutboundAt ?? null,
  };
}
