import { useEffect, useState } from "react";
import {
  getPushNotificationPermission,
  requestPushNotificationPermission,
  showPushNotificationPreview,
} from "../api/push-notification";
import { cloudStorage, getTelegramUser, hapticFeedback } from "../api/telegram-bridge";
import "./Settings.css";

type NotifyLevel = "silent" | "quiet" | "loud";

type Preferences = {
  notifyLevel: NotifyLevel;
  autoApproveSafeActions: boolean;
  pushEnabled: boolean;
};

const SETTINGS_KEY = "superclaw.preferences.v1";

function safeParsePreferences(raw: string | null): Preferences | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    const notifyLevel: NotifyLevel =
      parsed.notifyLevel === "silent" ||
      parsed.notifyLevel === "quiet" ||
      parsed.notifyLevel === "loud"
        ? parsed.notifyLevel
        : "quiet";
    const autoApproveSafeActions =
      typeof parsed.autoApproveSafeActions === "boolean" ? parsed.autoApproveSafeActions : false;
    const pushEnabled = typeof parsed.pushEnabled === "boolean" ? parsed.pushEnabled : false;
    return { notifyLevel, autoApproveSafeActions, pushEnabled };
  } catch {
    return null;
  }
}

export function Settings() {
  const telegramUser = getTelegramUser();
  const [notifyLevel, setNotifyLevel] = useState<NotifyLevel>("quiet");
  const [autoApproveSafeActions, setAutoApproveSafeActions] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushPermission, setPushPermission] = useState(getPushNotificationPermission());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const raw = await cloudStorage.get(SETTINGS_KEY);
        const loaded = safeParsePreferences(raw);
        if (loaded) {
          setNotifyLevel(loaded.notifyLevel);
          setAutoApproveSafeActions(loaded.autoApproveSafeActions);
          setPushEnabled(loaded.pushEnabled);
        }
      } catch {
        setMessage("讀取偏好失敗，已使用預設值。");
      } finally {
        setPushPermission(getPushNotificationPermission());
        setLoading(false);
      }
    })();
  }, []);

  async function savePreferences() {
    setMessage("");
    const payload: Preferences = { notifyLevel, autoApproveSafeActions, pushEnabled };
    try {
      await cloudStorage.set(SETTINGS_KEY, JSON.stringify(payload));
      hapticFeedback("success");
      setMessage("偏好設定已儲存。");
    } catch {
      hapticFeedback("warning");
      setMessage("儲存失敗，請稍後重試。");
    }
  }

  return (
    <section className="settings-page">
      <article className="settings-card">
        <h1>設定面板</h1>
        {loading ? <p>載入中...</p> : null}
      </article>

      <article className="settings-card">
        <h2>通知級別</h2>
        <div className="settings-segment">
          {(["silent", "quiet", "loud"] as const).map((level) => (
            <button
              key={level}
              type="button"
              className={notifyLevel === level ? "segment-btn segment-btn-active" : "segment-btn"}
              onClick={() => {
                setNotifyLevel(level);
                hapticFeedback("selection");
              }}
            >
              {level}
            </button>
          ))}
        </div>
      </article>

      <article className="settings-card">
        <h2>安全偏好</h2>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={autoApproveSafeActions}
            onChange={(event) => setAutoApproveSafeActions(event.target.checked)}
          />
          <span>允許低風險動作快速確認</span>
        </label>
      </article>

      <article className="settings-card">
        <h2>Push 通知</h2>
        <p>權限狀態：{pushPermission}</p>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={pushEnabled}
            onChange={(event) => setPushEnabled(event.target.checked)}
          />
          <span>啟用 OpenClaw 即時推播</span>
        </label>
        <div className="settings-inline-actions">
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={async () => {
              const permission = await requestPushNotificationPermission();
              setPushPermission(permission);
              if (permission === "granted") {
                hapticFeedback("success");
                setMessage("Push 權限已啟用。");
              } else {
                hapticFeedback("warning");
                setMessage("Push 權限未啟用。");
              }
            }}
          >
            申請通知權限
          </button>
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={async () => {
              const ok = await showPushNotificationPreview(
                "SuperClaw 通知測試",
                "通知通道已連接 OpenClaw 事件。",
              );
              if (ok) {
                hapticFeedback("success");
                setMessage("已送出測試通知。");
              } else {
                hapticFeedback("warning");
                setMessage("測試通知失敗，請先啟用權限。");
              }
            }}
          >
            測試通知
          </button>
        </div>
      </article>

      <article className="settings-card">
        <h2>帳號資訊</h2>
        <p>ID：{telegramUser?.id ?? "N/A"}</p>
        <p>名稱：{telegramUser?.first_name ?? "N/A"}</p>
        <p>帳號：{telegramUser?.username ?? "N/A"}</p>
      </article>

      <article className="settings-card">
        <button type="button" className="settings-save-btn" onClick={() => void savePreferences()}>
          儲存設定
        </button>
        {message ? <p className="settings-message">{message}</p> : null}
      </article>
    </section>
  );
}
