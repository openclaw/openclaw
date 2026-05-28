import { useEffect } from "react";
import {
  getPushNotificationPermission,
  showPushNotificationPreview,
} from "../api/push-notification";
import { cloudStorage } from "../api/telegram-bridge";
import { useGateway } from "./useGateway";

const SETTINGS_KEY = "superclaw.preferences.v1";

type Preferences = {
  notifyLevel?: "silent" | "quiet" | "loud";
  pushEnabled?: boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNotifyLevel(raw: string | null): "silent" | "quiet" | "loud" {
  if (!raw) {
    return "quiet";
  }
  try {
    const parsed = JSON.parse(raw) as Preferences;
    if (
      parsed.notifyLevel === "silent" ||
      parsed.notifyLevel === "quiet" ||
      parsed.notifyLevel === "loud"
    ) {
      return parsed.notifyLevel;
    }
  } catch {
    // ignore
  }
  return "quiet";
}

function readPushEnabled(raw: string | null): boolean {
  if (!raw) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw) as Preferences;
    return parsed.pushEnabled === true;
  } catch {
    return false;
  }
}

export function usePushNotifications() {
  const { subscribe } = useGateway();

  useEffect(() => {
    let disposed = false;
    let lastHighAttentionId = "";
    let lastErrorPhaseAt = 0;

    const run = async (): Promise<(() => void) | undefined> => {
      const raw = await cloudStorage.get(SETTINGS_KEY).catch(() => null);
      const notifyLevel = readNotifyLevel(raw);
      const pushEnabled = readPushEnabled(raw);
      if (disposed || notifyLevel === "silent" || !pushEnabled) {
        return undefined;
      }
      if (getPushNotificationPermission() !== "granted") {
        return undefined;
      }

      const unsubscribers = [
        subscribe("agent.attention-items", (payload) => {
          const items = asArray(payload);
          const high = items.find(
            (item) =>
              isObject(item) &&
              item.urgency === "high" &&
              typeof item.id === "string" &&
              typeof item.title === "string",
          ) as { id: string; title: string } | undefined;

          if (!high || high.id === lastHighAttentionId) {
            return;
          }
          lastHighAttentionId = high.id;
          void showPushNotificationPreview("SuperClaw 重要提醒", high.title);
        }),
        subscribe("agent.phase", (payload) => {
          if (payload !== "error") {
            return;
          }
          const now = Date.now();
          if (now - lastErrorPhaseAt < 30_000) {
            return;
          }
          lastErrorPhaseAt = now;
          void showPushNotificationPreview("SuperClaw 狀態", "偵測到 Agent 進入錯誤狀態。");
        }),
      ];

      return () => {
        unsubscribers.forEach((unsubscribe) => unsubscribe());
      };
    };

    let cleanup: (() => void) | undefined;
    void run().then((fn) => {
      cleanup = fn;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [subscribe]);
}
