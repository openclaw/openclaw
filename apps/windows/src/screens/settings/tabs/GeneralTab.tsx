import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Dropdown,
  Input,
  Label,
  Option,
  Spinner,
  Text,
  tokens,
  makeStyles,
} from "@fluentui/react-components";
import {
  CheckmarkCircle20Filled,
  DismissCircle20Filled,
  ArrowClockwise20Regular,
  Power20Regular,
} from "@fluentui/react-icons";
import { SettingsRow } from "../components/SettingsRow";
import { formatError } from "../../../utils/error";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    paddingBottom: "20px",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "16px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground3,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  row3: {
    display: "grid",
    gridTemplateColumns: "140px 1fr auto",
    gap: "8px",
    alignItems: "center",
  },
  label: {
    fontSize: tokens.fontSizeBase300,
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightSemibold,
  },
  healthRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
  },
  healthOk: { color: tokens.colorPaletteGreenForeground1 },
  healthErr: { color: tokens.colorPaletteRedForeground1 },
  divider: {
    height: "1px",
    backgroundColor: tokens.colorNeutralStroke2,
    margin: "4px 0",
  },
  advancedSection: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    paddingTop: "8px",
  },
  quitBtn: { marginTop: "auto", alignSelf: "flex-end" },
  modeRow: { display: "flex", alignItems: "center", gap: "8px" },
  helpText: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  tagBadge: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    padding: "1px 8px",
    borderRadius: "100px",
    backgroundColor: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground2,
  },
});

interface Config {
  authToken?: string;
  isPaused?: boolean;
  startOnLogin?: boolean;
  cameraEnabled?: boolean;
  canvasEnabled?: boolean;
  gatewayMode?: string;
  remoteUrl?: string;
  remoteSshTarget?: string;
  remoteSshIdentity?: string;
  remoteSshProjectRoot?: string;
  remoteSshCliPath?: string;
  iconAnimationsEnabled?: boolean;
  automationBridgeEnabled?: boolean;
  debugPaneEnabled?: boolean;
}
interface Health {
  connected: boolean;
  error?: string;
}
interface TestRemoteResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

type RemoteStatus = "idle" | "checking" | "ok" | { error: string };

export function GeneralTab() {
  const styles = useStyles();
  const [cfg, setCfg] = useState<Config>({});
  const cfgRef = useRef<Config>({});
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatus>("idle");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await invoke<Config>("get_full_config");
      cfgRef.current = c;
      setCfg(c);
    } catch (e) {
      setError(`Load failed: ${formatError(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (patch: Partial<Config>) => {
    // Optimistically apply UI changes, then serialize persistence writes.
    // This prevents rapid toggles from racing and overwriting each other.
    const merged = { ...cfgRef.current, ...patch };
    cfgRef.current = merged;
    setCfg(merged);
    saveQueueRef.current = saveQueueRef.current
      .then(async () => {
        await invoke("save_general_settings", {
          payload: {
            gatewayMode: merged.gatewayMode ?? "local",
            remoteUrl: merged.remoteUrl ?? null,
            remoteSshTarget: merged.remoteSshTarget ?? null,
            remoteSshIdentity: merged.remoteSshIdentity ?? null,
            remoteSshProjectRoot: merged.remoteSshProjectRoot ?? null,
            remoteSshCliPath: merged.remoteSshCliPath ?? null,
            startOnLogin: merged.startOnLogin ?? false,
            cameraEnabled: merged.cameraEnabled ?? false,
            canvasEnabled: merged.canvasEnabled ?? true,
            isPaused: merged.isPaused ?? false,
            iconAnimationsEnabled: merged.iconAnimationsEnabled ?? true,
            automationBridgeEnabled: merged.automationBridgeEnabled ?? false,
            debugPaneEnabled: merged.debugPaneEnabled ?? false,
          },
        });
        if (Object.prototype.hasOwnProperty.call(patch, "debugPaneEnabled")) {
          window.dispatchEvent(
            new CustomEvent("settings:debug-pane", {
              detail: { enabled: merged.debugPaneEnabled ?? false },
            })
          );
        }
      })
      .catch((e) => {
        setError(`Save failed: ${formatError(e)}`);
      });
  }, []);

  const refreshHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const h = await invoke<Health>("get_gateway_health");
      setHealth(h);
    } catch (e) {
      setHealth({ connected: false, error: formatError(e) });
    } finally {
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  useEffect(() => {
    setRemoteStatus("idle");
  }, [cfg.gatewayMode, cfg.remoteUrl, cfg.remoteSshTarget]);

  const testRemote = useCallback(async () => {
    setRemoteStatus("checking");
    try {
      const target =
        cfg.gatewayMode === "remote-ssh" ? cfg.remoteSshTarget : cfg.remoteUrl;
      if (!target?.trim()) {
        setRemoteStatus({ error: "Set a target first" });
        return;
      }
      const result = await invoke<TestRemoteResult>("test_remote_connection", {
        payload: {
          address: target.trim(),
          port: 0,
          token: cfg.authToken ?? "",
          mode: cfg.gatewayMode ?? "local",
        },
      });
      if (result.ok) {
        setRemoteStatus("ok");
      } else {
        setRemoteStatus({ error: result.message || "Connection test failed" });
      }
    } catch (e) {
      setRemoteStatus({ error: formatError(e) });
    }
  }, [cfg]);

  if (loading) return <Spinner size="small" label="Loading..." />;

  return (
    <div className={styles.root}>
      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            padding: "8px 10px",
            borderRadius: "6px",
            backgroundColor: tokens.colorPaletteRedBackground1,
          }}
        >
          <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
            {error}
          </Text>
          <Button
            size="small"
            appearance="subtle"
            onClick={() => setError(null)}
          >
            Dismiss
          </Button>
        </div>
      )}

      <div className={styles.section}>
        <Text className={styles.sectionTitle}>Gateway</Text>

        <SettingsRow
          label="OpenClaw active"
          subtitle="Pause to stop the gateway - no messages will be processed."
          checked={!(cfg.isPaused ?? false)}
          onChange={(v) => save({ isPaused: !v })}
        />

        <div className={styles.divider} />

        <div className={styles.modeRow}>
          <Label style={{ minWidth: 80 }}>Mode</Label>
          <Dropdown
            value={cfg.gatewayMode ?? "local"}
            selectedOptions={[cfg.gatewayMode ?? "local"]}
            onOptionSelect={(_, d) => save({ gatewayMode: d.optionValue! })}
            listbox={{
              style: { backgroundColor: tokens.colorNeutralBackground2 },
            }}
          >
            <Option value="local">Local (this PC)</Option>
            <Option value="remote-ssh">Remote via SSH</Option>
            <Option value="remote-direct">Remote (ws/wss)</Option>
          </Dropdown>
        </div>

        {cfg.gatewayMode === "remote-ssh" && (
          <div className={styles.advancedSection}>
            <div className={styles.row3}>
              <Label className={styles.label}>SSH target</Label>
              <Input
                placeholder="user@host[:22]"
                value={cfg.remoteSshTarget ?? ""}
                onChange={(_, d) =>
                  setCfg((p) => ({ ...p, remoteSshTarget: d.value }))
                }
                onBlur={(e) => save({ remoteSshTarget: e.currentTarget.value })}
              />
              <Button
                appearance="primary"
                size="small"
                disabled={remoteStatus === "checking"}
                onClick={testRemote}
              >
                {remoteStatus === "checking" ? <Spinner size="tiny" /> : "Test"}
              </Button>
            </div>
            <Button
              appearance="subtle"
              size="small"
              onClick={() => setShowAdvanced((p) => !p)}
            >
              {showAdvanced ? "Hide advanced" : "Show advanced"}
            </Button>
            {showAdvanced && (
              <div className={styles.advancedSection}>
                <div className={styles.row3}>
                  <Label className={styles.label}>Identity file</Label>
                  <Input
                    placeholder="/home/you/.ssh/id_ed25519"
                    value={cfg.remoteSshIdentity ?? ""}
                    onChange={(_, d) =>
                      setCfg((p) => ({ ...p, remoteSshIdentity: d.value }))
                    }
                    onBlur={(e) =>
                      save({ remoteSshIdentity: e.currentTarget.value })
                    }
                  />
                </div>
                <div className={styles.row3}>
                  <Label className={styles.label}>Project root</Label>
                  <Input
                    placeholder="/home/you/projects/openclaw"
                    value={cfg.remoteSshProjectRoot ?? ""}
                    onChange={(_, d) =>
                      setCfg((p) => ({ ...p, remoteSshProjectRoot: d.value }))
                    }
                    onBlur={(e) =>
                      save({ remoteSshProjectRoot: e.currentTarget.value })
                    }
                  />
                </div>
                <div className={styles.row3}>
                  <Label className={styles.label}>CLI path</Label>
                  <Input
                    placeholder="/usr/local/bin/openclaw"
                    value={cfg.remoteSshCliPath ?? ""}
                    onChange={(_, d) =>
                      setCfg((p) => ({ ...p, remoteSshCliPath: d.value }))
                    }
                    onBlur={(e) =>
                      save({ remoteSshCliPath: e.currentTarget.value })
                    }
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {cfg.gatewayMode === "remote-direct" && (
          <div className={styles.advancedSection}>
            <div className={styles.row3}>
              <Label className={styles.label}>Gateway URL</Label>
              <Input
                placeholder="wss://gateway.example.ts.net"
                value={cfg.remoteUrl ?? ""}
                onChange={(_, d) =>
                  setCfg((p) => ({ ...p, remoteUrl: d.value }))
                }
                onBlur={(e) => save({ remoteUrl: e.currentTarget.value })}
              />
              <Button
                appearance="primary"
                size="small"
                disabled={remoteStatus === "checking"}
                onClick={testRemote}
              >
                {remoteStatus === "checking" ? <Spinner size="tiny" /> : "Test"}
              </Button>
            </div>
            <Text className={styles.helpText}>
              Use ws:// or wss://. Tip: use Tailscale Serve for a valid HTTPS
              cert.
            </Text>
          </div>
        )}

        {remoteStatus === "ok" && (
          <div className={styles.healthRow}>
            <CheckmarkCircle20Filled className={styles.healthOk} /> Ready
          </div>
        )}
        {typeof remoteStatus === "object" && (
          <div className={styles.healthRow}>
            <DismissCircle20Filled className={styles.healthErr} />{" "}
            {remoteStatus.error}
          </div>
        )}

        {cfg.gatewayMode === "local" && (
          <div className={styles.healthRow}>
            {health?.connected ? (
              <>
                <CheckmarkCircle20Filled className={styles.healthOk} /> Gateway
                connected
              </>
            ) : (
              <>
                <DismissCircle20Filled className={styles.healthErr} />{" "}
                {health?.error ?? "Checking..."}
              </>
            )}
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowClockwise20Regular />}
              onClick={refreshHealth}
              disabled={healthLoading}
            />
          </div>
        )}
      </div>

      <div className={styles.section}>
        <Text className={styles.sectionTitle}>General</Text>
        <SettingsRow
          label="Launch at login"
          subtitle="Automatically start OpenClaw after sign-in."
          checked={cfg.startOnLogin ?? false}
          onChange={(v) => save({ startOnLogin: v })}
        />
        <SettingsRow
          label="Tray icon animations"
          subtitle="Enable idle blinks on the status icon."
          statusText="Coming soon on Windows."
          checked={false}
          disabled
          onChange={() => {}}
        />
        <SettingsRow
          label="Allow Canvas"
          subtitle="Allow the agent to show and control the Canvas panel."
          statusText="Coming soon on Windows."
          checked={false}
          disabled
          onChange={() => {}}
        />
        <SettingsRow
          label="Allow Camera"
          subtitle="Allow the agent to capture photos via the built-in camera."
          checked={cfg.cameraEnabled ?? false}
          onChange={(v) => save({ cameraEnabled: v })}
        />
        <SettingsRow
          label="Enable automation bridge"
          subtitle="Allow signed tools to drive UI automation via the bridge."
          statusText="Coming soon on Windows."
          checked={false}
          disabled
          onChange={() => {}}
        />
        <SettingsRow
          label="Enable debug tab"
          subtitle="Show the Debug tab with development utilities."
          checked={cfg.debugPaneEnabled ?? false}
          onChange={(v) => save({ debugPaneEnabled: v })}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          appearance="primary"
          icon={<Power20Regular />}
          onClick={() => invoke("quit_app")}
        >
          Quit OpenClaw
        </Button>
      </div>
    </div>
  );
}
