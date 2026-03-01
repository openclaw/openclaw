import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Text,
  Switch,
  Button,
  Divider,
  Spinner,
  tokens,
  Option,
  Dropdown,
} from "@fluentui/react-components";
import {
  Wifi1Regular,
  WifiOffRegular,
  MicRegular,
  Speaker0Regular,
  SettingsRegular,
  DismissRegular,
  PowerRegular,
} from "@fluentui/react-icons";
import { useStyles } from "./styles";

interface TrayStatus {
  gatewayConnected: boolean;
  gatewayAddress: string;
  voiceWakeEnabled: boolean;
  talkModeEnabled: boolean;
  nodeName: string;
}

interface AudioDevice {
  id: string;
  name: string;
}

export function TrayMenu() {
  const styles = useStyles();
  const rootRef = useRef<HTMLDivElement>(null);
  const lastSize = useRef({ width: 0, height: 0 });
  const [status, setStatus] = useState<TrayStatus | null>(null);
  const [microphones, setMicrophones] = useState<AudioDevice[]>([]);
  const [currentMicId, setCurrentMicId] = useState("");
  const [voiceWakeLocale, setVoiceWakeLocale] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await invoke<TrayStatus>("get_tray_status");
      setStatus(s);
    } catch (e) {
      console.error("get_tray_status failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMicrophones = useCallback(async () => {
    try {
      const [hw, settings] = await Promise.all([
        invoke<{
          microphones: AudioDevice[];
          locales: string[];
        }>("get_voice_wake_hardware"),
        invoke<{ locale?: string; micId?: string }>("get_voice_wake_settings"),
      ]);
      setMicrophones(hw?.microphones ?? []);
      setVoiceWakeLocale(settings?.locale ?? "");
      setCurrentMicId(settings?.micId ?? "");
    } catch (error) {
      console.error("get_voice_wake_hardware failed", error);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchMicrophones();

    const interval = setInterval(fetchStatus, 3000);

    const win = getCurrentWindow();
    let unsubscribe: (() => void) | null = null;
    win
      .onFocusChanged(({ payload: focused }) => {
        if (!focused) win.hide();
      })
      .then((fn) => {
        unsubscribe = fn;
      });

    return () => {
      clearInterval(interval);
      unsubscribe?.();
    };
  }, [fetchStatus, fetchMicrophones]);

  useLayoutEffect(() => {
    if (!rootRef.current) return;

    const resize = () => {
      const el = rootRef.current;
      if (!el) return;

      const width = Math.ceil(el.scrollWidth);
      const height = Math.min(Math.ceil(el.scrollHeight), 520);

      if (
        width === lastSize.current.width &&
        height === lastSize.current.height
      ) {
        return;
      }

      lastSize.current = { width, height };
      invoke("set_tray_menu_size", { width, height }).catch((e) => {
        console.error("Failed to set tray menu size", e);
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      resize();
    });

    resizeObserver.observe(rootRef.current);
    resize();

    return () => resizeObserver.disconnect();
  }, []);

  const handleVoiceWakeToggle = async (enabled: boolean) => {
    try {
      await invoke("set_voice_wake_enabled", { enabled });
      setStatus((s) => (s ? { ...s, voiceWakeEnabled: enabled } : s));
    } catch (e) {
      console.error(e);
    }
  };

  const handleTalkModeToggle = async (enabled: boolean) => {
    try {
      await invoke("set_talk_mode_enabled", { enabled });
      setStatus((s) => (s ? { ...s, talkModeEnabled: enabled } : s));
    } catch (e) {
      console.error(e);
    }
  };

  const handleQuit = async () => {
    try {
      await invoke("set_voice_wake_enabled", { enabled: false });
    } catch (error) {
      console.error("Failed to disable voice wake before quit", error);
    }
    try {
      await invoke("quit_app");
    } catch {
      window.close();
    }
  };

  const isConnected = status?.gatewayConnected ?? false;

  return (
    <div className={styles.root} ref={rootRef}>
      <div className={styles.header} data-tauri-drag-region>
        <div className={styles.headerLeft}>
          <Text className={styles.appName}>OpenClaw</Text>
          <Text className={styles.nodeName}>{status?.nodeName ?? "-"}</Text>
        </div>
        <Button
          appearance="subtle"
          className={styles.closeBtn}
          icon={<DismissRegular />}
          onClick={() => getCurrentWindow().hide()}
        />
      </div>

      <div className={styles.content}>
        {loading ? (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "24px",
            }}
          >
            <Spinner size="small" />
          </div>
        ) : (
          <>
            <div className={styles.statusRow}>
              <div
                className={styles.dot}
                style={{
                  background: isConnected
                    ? tokens.colorPaletteGreenForeground1
                    : tokens.colorNeutralForeground4,
                }}
              />
              <div className={styles.statusText}>
                <Text className={styles.statusLabel}>
                  {isConnected ? "Gateway Connected" : "Gateway Offline"}
                </Text>
                {isConnected && status?.gatewayAddress && (
                  <Text className={styles.statusSub}>
                    {status.gatewayAddress}
                  </Text>
                )}
              </div>
              {isConnected ? (
                <Wifi1Regular
                  style={{
                    color: tokens.colorPaletteGreenForeground1,
                    fontSize: 16,
                  }}
                />
              ) : (
                <WifiOffRegular
                  style={{
                    color: tokens.colorNeutralForeground4,
                    fontSize: 16,
                  }}
                />
              )}
            </div>

            <Divider style={{ margin: "2px 0" }} />

            <Text className={styles.sectionLabel}>Capabilities</Text>

            <div className={styles.toggleRow}>
              <div className={styles.toggleLabel}>
                <MicRegular fontSize={16} />
                Voice Wake
              </div>
              <Switch
                checked={status?.voiceWakeEnabled ?? false}
                onChange={(_, d) => handleVoiceWakeToggle(d.checked)}
              />
            </div>

            {status?.voiceWakeEnabled && microphones.length > 0 && (
              <div className={styles.subControl}>
                <Dropdown
                  size="small"
                  className={styles.dropdown}
                  listbox={{ className: styles.dropdownPopup }}
                  value={
                    microphones.find((m) => m.id === currentMicId)?.name ??
                    "System Default"
                  }
                  selectedOptions={[currentMicId]}
                  onOptionSelect={async (_, data) => {
                    try {
                      await invoke("set_voice_wake_hardware", {
                        micId: data.optionValue,
                        locale: voiceWakeLocale,
                      });
                      setCurrentMicId(data.optionValue ?? "");
                    } catch (error) {
                      console.error(
                        "Failed to change voice wake hardware",
                        error
                      );
                    }
                  }}
                >
                  <Option value="">System Default</Option>
                  {microphones.map((m) => (
                    <Option key={m.id} value={m.id}>
                      {m.name}
                    </Option>
                  ))}
                </Dropdown>
              </div>
            )}

            <div className={styles.toggleRow}>
              <div className={styles.toggleLabel}>
                <Speaker0Regular fontSize={16} />
                Talk Mode
              </div>
              <Switch
                checked={status?.talkModeEnabled ?? false}
                onChange={(_, d) => handleTalkModeToggle(d.checked)}
              />
            </div>

            <Divider style={{ margin: "2px 0" }} />

            <Text className={styles.sectionLabel}>Quick Actions</Text>
            <div className={styles.actionRow}>
              <Button
                className={styles.actionBtn}
                appearance="subtle"
                icon={<SettingsRegular />}
                onClick={async () => {
                  try {
                    await invoke("open_settings");
                  } catch (error) {
                    console.error("Failed to open settings", error);
                  }
                }}
              >
                Settings
              </Button>
            </div>
          </>
        )}
      </div>

      <div className={styles.footer}>
        <Button
          className={styles.quitBtn}
          appearance="subtle"
          icon={<PowerRegular />}
          onClick={handleQuit}
        >
          Quit OpenClaw
        </Button>
      </div>
    </div>
  );
}

export default TrayMenu;
