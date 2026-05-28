export const TELEGRAM_LONG_TURN_SOFT_DEADLINE_MS = 30_000;

type ProgressPreviewStatus = "idle" | "requested" | "ready" | "unavailable";

export type TelegramLongTurnProgressState = {
  requestProgressPreview: () => void;
  onProgressPreviewRequested: (listener: () => void) => () => void;
  waitForProgressPreview: () => Promise<"ready" | "unavailable">;
  progressPreviewStatus: () => ProgressPreviewStatus;
  hasProgressPreview: () => boolean;
  markProgressPreviewReady: () => void;
  markProgressPreviewUnavailable: () => void;
  markFinalDeliveryStarted: () => void;
  hasFinalDeliveryStarted: () => boolean;
  setCanCreateProgressPreview: (check: () => boolean) => void;
  canCreateProgressPreview: () => boolean;
};

export function createTelegramLongTurnProgressState(): TelegramLongTurnProgressState {
  let status: ProgressPreviewStatus = "idle";
  let finalDeliveryStarted = false;
  let canCreateProgressPreview = () => true;
  let resolveProgressPreview: ((status: "ready" | "unavailable") => void) | undefined;
  const progressPreviewSettled = new Promise<"ready" | "unavailable">((resolve) => {
    resolveProgressPreview = resolve;
  });
  const requestListeners = new Set<() => void>();

  const settleProgressPreview = (nextStatus: "ready" | "unavailable") => {
    if (status === "ready" || status === "unavailable") {
      return;
    }
    status = nextStatus;
    resolveProgressPreview?.(nextStatus);
  };

  const notifyRequestListeners = () => {
    for (const listener of requestListeners) {
      listener();
    }
  };

  return {
    requestProgressPreview: () => {
      if (status !== "idle") {
        return;
      }
      status = "requested";
      notifyRequestListeners();
    },
    onProgressPreviewRequested: (listener) => {
      if (status === "requested") {
        listener();
        return () => {};
      }
      if (status !== "idle") {
        return () => {};
      }
      requestListeners.add(listener);
      return () => {
        requestListeners.delete(listener);
      };
    },
    waitForProgressPreview: async () => {
      if (status === "ready" || status === "unavailable") {
        return status;
      }
      return await progressPreviewSettled;
    },
    progressPreviewStatus: () => status,
    hasProgressPreview: () => status === "ready",
    markProgressPreviewReady: () => {
      settleProgressPreview("ready");
    },
    markProgressPreviewUnavailable: () => {
      settleProgressPreview("unavailable");
    },
    markFinalDeliveryStarted: () => {
      finalDeliveryStarted = true;
      if (status === "requested") {
        settleProgressPreview("unavailable");
      }
    },
    hasFinalDeliveryStarted: () => finalDeliveryStarted,
    setCanCreateProgressPreview: (check) => {
      canCreateProgressPreview = check;
    },
    canCreateProgressPreview: () => canCreateProgressPreview(),
  };
}
