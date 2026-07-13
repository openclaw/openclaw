import type { SignalProbe } from "./probe.js";

export function formatSignalCapabilitiesProbe({ probe }: { probe?: SignalProbe }) {
  if (!probe) {
    return [];
  }
  const readiness = (() => {
    switch (probe.readiness) {
      case "ready":
        return { text: "Signal readiness: ready", tone: "success" as const };
      case "account_missing":
        return { text: "Signal readiness: account missing", tone: "warn" as const };
      case "receive_unavailable":
        return { text: "Signal readiness: receive unavailable", tone: "warn" as const };
      case "unreachable":
        return { text: "Signal readiness: daemon unreachable", tone: "error" as const };
      default:
        return null;
    }
  })();
  if (!readiness) {
    return [];
  }
  return [readiness, ...(probe.version ? [{ text: `Signal daemon: ${probe.version}` }] : [])];
}
