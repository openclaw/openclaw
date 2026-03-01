import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Badge,
  Button,
  Input,
  mergeClasses,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  tokens,
  makeStyles,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular, Link20Regular } from "@fluentui/react-icons";
import { formatError } from "../../../utils/error";
import { ChannelConfigSchemaForm } from "./ChannelConfigSchemaForm";
import {
  type ConfigPath,
  type ConfigSchemaNode,
  type ConfigUiHint,
  decodeUiHints,
  getValueAtPath,
  keySegment,
  parseConfigSchemaNode,
  schemaNodeAtPath,
  setValueAtPath,
} from "./channel-config-schema-utils";

const POLL_INTERVAL_MS = 45_000;

type Intent = "success" | "error";

type JsonObject = Record<string, unknown>;

interface GatewayConfigSchemaResponse {
  schema: unknown;
  uihints?: unknown;
}

const useStyles = makeStyles({
  root: { display: "flex", height: "100%", overflow: "hidden" },
  sidebar: {
    width: "220px",
    minWidth: "200px",
    overflowY: "auto",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    padding: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  sectionHeader: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground3,
    textTransform: "uppercase",
    padding: "6px 8px 2px",
    letterSpacing: "0.05em",
  },
  sidebarRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "8px",
    padding: "6px 10px",
    borderRadius: "8px",
    width: "100%",
    textAlign: "left",
  },
  sidebarRowSelected: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  dot: { width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0 },
  sidebarText: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  sidebarName: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  sidebarSub: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  detail: {
    flex: 1,
    overflowY: "auto",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  detailEmpty: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    padding: "20px 24px",
  },
  detailHeader: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "4px",
  },
  headerActions: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  badge: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    padding: "2px 10px",
    borderRadius: "100px",
  },
  badgeOk: {
    backgroundColor: tokens.colorPaletteGreenBackground2,
    color: tokens.colorPaletteGreenForeground1,
  },
  badgeMissing: {
    backgroundColor: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground3,
  },
  badgeError: {
    backgroundColor: tokens.colorPaletteRedBackground2,
    color: tokens.colorPaletteRedForeground1,
  },
  badgeWarn: {
    backgroundColor: tokens.colorPaletteYellowBackground2,
    color: tokens.colorPaletteYellowForeground2,
  },
  lastCheck: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    padding: "10px 12px",
    borderRadius: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  keyInput: { fontFamily: "monospace" },
  row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
  qr: {
    width: "180px",
    height: "180px",
    objectFit: "contain",
    borderRadius: "8px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
});

interface ChannelInfo {
  id: string;
  name: string;
  detailName: string;
  systemImage?: string;
  provider: string;
  apiKeySet: boolean;
  configured: boolean;
  linked: boolean;
  running: boolean;
  connected: boolean;
  hasError: boolean;
  supportsApiKey: boolean;
  statusLabel: string;
  details?: string;
  lastCheckedMs?: number;
  lastCheckedAt?: string;
  errorMessage?: string;
}

interface WhatsAppLoginStartResult {
  qrDataUrl?: string;
  message: string;
}

interface WhatsAppLoginWaitResult {
  connected: boolean;
  message: string;
}

interface ChannelLogoutResult {
  cleared: boolean;
  envToken?: boolean;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function channelDot(ch: ChannelInfo): string {
  if (ch.hasError) return tokens.colorPaletteRedForeground1;
  if (ch.id === "whatsapp" && ch.configured && !ch.linked) {
    return tokens.colorPaletteRedForeground1;
  }
  if (ch.connected) return tokens.colorPaletteGreenForeground1;
  if (ch.running || ch.linked || ch.configured)
    return tokens.colorPaletteYellowForeground2;
  return tokens.colorNeutralForeground4;
}

function channelSummary(ch: ChannelInfo): string {
  if (ch.statusLabel?.trim()) return ch.statusLabel;
  if (ch.errorMessage) return "Error";
  if (ch.connected) return "Connected";
  if (ch.running) return "Running";
  if (ch.linked) return "Linked";
  if (ch.configured) return "Configured";
  return "Not configured";
}

function channelBadgeClass(
  ch: ChannelInfo,
  styles: ReturnType<typeof useStyles>
): string {
  if (ch.hasError) return styles.badgeError;
  if (ch.connected) return styles.badgeOk;
  if (ch.running || ch.linked || ch.configured) return styles.badgeWarn;
  return styles.badgeMissing;
}

export function ChannelsTab() {
  const styles = useStyles();
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [apiInput, setApiInput] = useState("");
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [apiKeyMsg, setApiKeyMsg] = useState<string | null>(null);
  const [apiKeyIntent, setApiKeyIntent] = useState<Intent>("success");

  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [actionIntent, setActionIntent] = useState<Intent>("success");
  const [whatsappBusy, setWhatsappBusy] = useState(false);
  const [telegramBusy, setTelegramBusy] = useState(false);
  const [whatsappLoginMessage, setWhatsappLoginMessage] = useState<
    string | null
  >(null);
  const [whatsappLoginQrDataUrl, setWhatsappLoginQrDataUrl] = useState<
    string | null
  >(null);

  const [schemaRoot, setSchemaRoot] = useState<ConfigSchemaNode | null>(null);
  const [schemaHints, setSchemaHints] = useState<Record<string, ConfigUiHint>>(
    {}
  );
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configDraftRoot, setConfigDraftRoot] = useState<unknown>(null);
  const [configOriginalHash, setConfigOriginalHash] = useState("");
  const [configMsg, setConfigMsg] = useState<string | null>(null);
  const [configIntent, setConfigIntent] = useState<Intent>("success");

  const selected = useMemo(
    () => channels.find((c) => c.id === selectedId) ?? null,
    [channels, selectedId]
  );

  const selectedSchema = useMemo(() => {
    if (!schemaRoot || !selected) return null;
    return (
      schemaNodeAtPath(schemaRoot, [
        keySegment("channels"),
        keySegment(selected.id),
      ]) ?? schemaNodeAtPath(schemaRoot, [keySegment(selected.id)])
    );
  }, [schemaRoot, selected]);

  const configPathBase = useMemo<ConfigPath | null>(() => {
    if (!selected) return null;
    return [keySegment("channels"), keySegment(selected.id)];
  }, [selected]);

  const loadSchema = useCallback(async () => {
    setSchemaLoading(true);
    setSchemaError(null);
    try {
      const res =
        await invoke<GatewayConfigSchemaResponse>("get_config_schema");
      const parsed = parseConfigSchemaNode(res.schema);
      setSchemaRoot(parsed);
      setSchemaHints(decodeUiHints(res.uihints));
      if (!parsed) {
        setSchemaError("Schema unavailable.");
      }
    } catch (e) {
      setSchemaRoot(null);
      setSchemaHints({});
      setSchemaError(formatError(e, "Failed to load config schema."));
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  const loadChannels = useCallback(async (probe = false) => {
    setLoading(true);
    setLoadError(null);
    try {
      const chs = await invoke<ChannelInfo[]>("get_channels", {
        payload: { probe, timeoutMs: 8000 },
      });
      setChannels(chs);
      setSelectedId((prev) => {
        if (!prev) return chs[0]?.id ?? null;
        return chs.some((ch) => ch.id === prev) ? prev : (chs[0]?.id ?? null);
      });
    } catch (e) {
      setChannels([]);
      setSelectedId(null);
      setLoadError(formatError(e, "Failed to load channels."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadChannelConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigMsg(null);
    try {
      const root = await invoke<unknown>("get_openclaw_json");
      const normalized = isRecord(root) ? root : {};
      setConfigDraftRoot(normalized);
      setConfigOriginalHash(JSON.stringify(normalized));
    } catch (e) {
      setConfigDraftRoot(null);
      setConfigOriginalHash("");
      setConfigMsg(formatError(e, "Failed to load channel config."));
      setConfigIntent("error");
    } finally {
      setConfigLoading(false);
    }
  }, []);

  const getConfigValue = useCallback(
    (path: ConfigPath): unknown => {
      if (configDraftRoot === null || configDraftRoot === undefined)
        return undefined;
      const direct = getValueAtPath(configDraftRoot, path);
      if (direct !== undefined) return direct;
      if (
        path.length >= 2 &&
        path[0].kind === "key" &&
        path[0].key === "channels" &&
        path[1].kind === "key"
      ) {
        return getValueAtPath(configDraftRoot, path.slice(1));
      }
      return undefined;
    },
    [configDraftRoot]
  );

  const setConfigValue = useCallback(
    (path: ConfigPath, value: unknown | undefined) => {
      setConfigDraftRoot((prev: unknown) => {
        const root = prev ?? {};
        return setValueAtPath(root, path, value);
      });
    },
    []
  );

  useEffect(() => {
    void loadSchema();
    void loadChannels(true);
    const timer = window.setInterval(() => {
      void loadChannels(false);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [loadChannels, loadSchema]);

  useEffect(() => {
    if (!selectedId) {
      setConfigDraftRoot(null);
      setConfigOriginalHash("");
      return;
    }
    void loadChannelConfig();
    setApiInput("");
    setApiKeyMsg(null);
  }, [selectedId, loadChannelConfig]);

  const waitWhatsAppLogin = useCallback(async () => {
    setWhatsappBusy(true);
    try {
      const result = await invoke<WhatsAppLoginWaitResult>(
        "channels_whatsapp_login_wait",
        {
          payload: { timeoutMs: 120000 },
        }
      );
      setWhatsappLoginMessage(result.message);
      if (result.connected) {
        setWhatsappLoginQrDataUrl(null);
      }
      setActionMsg(result.message);
      setActionIntent("success");
    } catch (e) {
      const message = formatError(e, "WhatsApp login wait failed.");
      setWhatsappLoginMessage(message);
      setActionMsg(message);
      setActionIntent("error");
    } finally {
      setWhatsappBusy(false);
      await loadChannels(true);
    }
  }, [loadChannels]);

  const startWhatsAppLogin = useCallback(
    async (force: boolean) => {
      setWhatsappBusy(true);
      setActionMsg(null);
      let shouldAutoWait = false;
      try {
        const result = await invoke<WhatsAppLoginStartResult>(
          "channels_whatsapp_login_start",
          {
            payload: { force, timeoutMs: 30000 },
          }
        );
        setWhatsappLoginMessage(result.message);
        setWhatsappLoginQrDataUrl(result.qrDataUrl ?? null);
        setActionMsg(result.message);
        setActionIntent("success");
        shouldAutoWait = Boolean(result.qrDataUrl);
      } catch (e) {
        const message = formatError(e, "Failed to start WhatsApp login.");
        setWhatsappLoginMessage(message);
        setWhatsappLoginQrDataUrl(null);
        setActionMsg(message);
        setActionIntent("error");
      } finally {
        setWhatsappBusy(false);
        await loadChannels(true);
      }

      if (shouldAutoWait) {
        void waitWhatsAppLogin();
      }
    },
    [loadChannels, waitWhatsAppLogin]
  );

  const logoutChannel = useCallback(
    async (channel: "whatsapp" | "telegram") => {
      if (channel === "whatsapp") {
        setWhatsappBusy(true);
      } else {
        setTelegramBusy(true);
      }
      setActionMsg(null);
      try {
        const result = await invoke<ChannelLogoutResult>("channels_logout", {
          payload: { channel },
        });

        if (channel === "whatsapp") {
          const message = result.cleared
            ? "Logged out and cleared credentials."
            : "No WhatsApp session found.";
          setWhatsappLoginMessage(message);
          setWhatsappLoginQrDataUrl(null);
          setActionMsg(message);
          setActionIntent("success");
        } else {
          const message = result.envToken
            ? "Telegram token still set via env; config cleared."
            : result.cleared
              ? "Telegram token cleared."
              : "No Telegram token configured.";
          setActionMsg(message);
          setActionIntent("success");
        }
      } catch (e) {
        const message = formatError(e, "Channel logout failed.");
        setActionMsg(message);
        setActionIntent("error");
      } finally {
        if (channel === "whatsapp") {
          setWhatsappBusy(false);
        } else {
          setTelegramBusy(false);
        }
        await loadChannels(true);
        await loadChannelConfig();
      }
    },
    [loadChannelConfig, loadChannels]
  );

  const saveApiKey = useCallback(async () => {
    if (!selected || !selected.supportsApiKey || !apiInput.trim()) return;
    setSavingApiKey(true);
    setApiKeyMsg(null);
    try {
      await invoke("set_channel_api_key", {
        payload: { channelId: selected.id, apiKey: apiInput.trim() },
      });
      setApiInput("");
      setApiKeyMsg("API key saved.");
      setApiKeyIntent("success");
      await loadChannels(true);
      await loadChannelConfig();
    } catch (e) {
      setApiKeyMsg(formatError(e, "Failed to save API key."));
      setApiKeyIntent("error");
    } finally {
      setSavingApiKey(false);
    }
  }, [apiInput, loadChannelConfig, loadChannels, selected]);

  const saveChannelConfig = useCallback(async () => {
    if (configDraftRoot === null || configDraftRoot === undefined) return;

    setConfigSaving(true);
    setConfigMsg(null);
    try {
      await invoke("save_openclaw_json", { content: configDraftRoot });
      setConfigOriginalHash(JSON.stringify(configDraftRoot));
      setConfigMsg("Configuration saved.");
      setConfigIntent("success");
      await loadChannels(true);
    } catch (e) {
      setConfigMsg(formatError(e, "Failed to save channel config."));
      setConfigIntent("error");
    } finally {
      setConfigSaving(false);
    }
  }, [configDraftRoot, loadChannels]);

  const configured = channels.filter(
    (c) => c.configured || c.running || c.connected
  );
  const available = channels.filter(
    (c) => !(c.configured || c.running || c.connected)
  );

  const configDirty =
    configDraftRoot !== null &&
    JSON.stringify(configDraftRoot) !== configOriginalHash;

  return (
    <div className={styles.root}>
      <div className={styles.sidebar}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "0 4px 4px",
          }}
        >
          <Text style={{ fontWeight: tokens.fontWeightSemibold }}>
            Channels
          </Text>
          <Button
            appearance="subtle"
            size="small"
            icon={
              loading ? <Spinner size="tiny" /> : <ArrowClockwise20Regular />
            }
            onClick={() => void loadChannels(true)}
            disabled={loading}
          />
        </div>

        {configured.length > 0 && (
          <>
            <Text className={styles.sectionHeader}>Configured</Text>
            {configured.map((ch) => (
              <Button
                key={ch.id}
                appearance="subtle"
                className={mergeClasses(
                  styles.sidebarRow,
                  selected?.id === ch.id ? styles.sidebarRowSelected : undefined
                )}
                onClick={() => setSelectedId(ch.id)}
              >
                <span
                  className={styles.dot}
                  style={{ backgroundColor: channelDot(ch) }}
                />
                <div className={styles.sidebarText}>
                  <Text className={styles.sidebarName}>{ch.name}</Text>
                  <Text className={styles.sidebarSub}>
                    {channelSummary(ch)}
                  </Text>
                </div>
              </Button>
            ))}
          </>
        )}

        {available.length > 0 && (
          <>
            <Text className={styles.sectionHeader}>Available</Text>
            {available.map((ch) => (
              <Button
                key={ch.id}
                appearance="subtle"
                className={mergeClasses(
                  styles.sidebarRow,
                  selected?.id === ch.id ? styles.sidebarRowSelected : undefined
                )}
                onClick={() => setSelectedId(ch.id)}
              >
                <span
                  className={styles.dot}
                  style={{ backgroundColor: channelDot(ch) }}
                />
                <div className={styles.sidebarText}>
                  <Text className={styles.sidebarName}>{ch.name}</Text>
                  <Text className={styles.sidebarSub}>
                    {channelSummary(ch)}
                  </Text>
                </div>
              </Button>
            ))}
          </>
        )}

        {channels.length === 0 && !loading && !loadError && (
          <Text className={styles.sidebarSub} style={{ padding: "8px" }}>
            No channels reported
          </Text>
        )}

        {loadError && (
          <MessageBar intent="error">
            <MessageBarBody>{loadError}</MessageBarBody>
          </MessageBar>
        )}
      </div>

      {selected ? (
        <div className={styles.detail}>
          <div className={styles.detailHeader}>
            <Link20Regular />
            <Text
              style={{
                fontSize: tokens.fontSizeBase400,
                fontWeight: tokens.fontWeightSemibold,
              }}
            >
              {selected.detailName || selected.name}
            </Text>
            <Badge
              className={mergeClasses(
                styles.badge,
                channelBadgeClass(selected, styles)
              )}
            >
              {channelSummary(selected)}
            </Badge>

            <div className={styles.headerActions}>
              {selected.id === "whatsapp" && (
                <>
                  <Button
                    appearance="secondary"
                    onClick={() => void startWhatsAppLogin(false)}
                    disabled={whatsappBusy}
                  >
                    {whatsappBusy ? <Spinner size="tiny" /> : "Show QR"}
                  </Button>
                  <Button
                    appearance="secondary"
                    onClick={() => void startWhatsAppLogin(true)}
                    disabled={whatsappBusy}
                  >
                    Relink
                  </Button>
                  <Button
                    appearance="secondary"
                    onClick={() => void logoutChannel("whatsapp")}
                    disabled={whatsappBusy}
                  >
                    Logout
                  </Button>
                </>
              )}

              {selected.id === "telegram" && (
                <Button
                  appearance="secondary"
                  onClick={() => void logoutChannel("telegram")}
                  disabled={telegramBusy}
                >
                  {telegramBusy ? <Spinner size="tiny" /> : "Logout"}
                </Button>
              )}

              <Button
                appearance="secondary"
                onClick={() => {
                  void loadSchema();
                  void loadChannels(true);
                }}
                disabled={loading || schemaLoading}
              >
                {loading || schemaLoading ? <Spinner size="tiny" /> : "Refresh"}
              </Button>
            </div>
          </div>

          {(selected.lastCheckedAt || selected.lastCheckedMs) && (
            <Text className={styles.lastCheck}>
              Last check{" "}
              {selected.lastCheckedAt ||
                new Date(selected.lastCheckedMs ?? 0).toLocaleString()}
            </Text>
          )}

          {selected.details && (
            <Text className={styles.lastCheck}>{selected.details}</Text>
          )}

          {selected.errorMessage && (
            <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
              {selected.errorMessage}
            </Text>
          )}

          {actionMsg && (
            <MessageBar intent={actionIntent === "error" ? "error" : "success"}>
              <MessageBarBody>{actionMsg}</MessageBarBody>
            </MessageBar>
          )}

          {selected.id === "whatsapp" && (
            <div className={styles.section}>
              <Text className={styles.sectionTitle}>Linking</Text>
              {whatsappLoginMessage && <Text>{whatsappLoginMessage}</Text>}
              {whatsappLoginQrDataUrl && (
                <img
                  src={whatsappLoginQrDataUrl}
                  alt="WhatsApp QR code"
                  className={styles.qr}
                />
              )}
            </div>
          )}

          {selected.supportsApiKey && (
            <div className={styles.section}>
              <Text className={styles.sectionTitle}>
                {selected.apiKeySet ? "Update API Key" : "Set API Key"}
              </Text>
              <Text className={styles.lastCheck}>
                Provider: {selected.provider}
              </Text>
              <Input
                type="password"
                placeholder="sk-..."
                value={apiInput}
                onChange={(_, d) => setApiInput(d.value)}
                onKeyDown={(e) => e.key === "Enter" && void saveApiKey()}
                className={styles.keyInput}
              />
              <div className={styles.row}>
                <Button
                  appearance="primary"
                  onClick={() => void saveApiKey()}
                  disabled={savingApiKey || !apiInput.trim()}
                >
                  {savingApiKey ? <Spinner size="tiny" /> : "Save Key"}
                </Button>
                {apiKeyMsg && (
                  <Text
                    style={{
                      color:
                        apiKeyIntent === "error"
                          ? tokens.colorPaletteRedForeground1
                          : tokens.colorNeutralForeground2,
                    }}
                  >
                    {apiKeyMsg}
                  </Text>
                )}
              </div>
            </div>
          )}

          <div className={styles.section}>
            <Text className={styles.sectionTitle}>Configuration</Text>
            <Text className={styles.lastCheck}>
              Schema-driven settings for channel <code>{selected.id}</code>.
            </Text>

            {schemaError && (
              <MessageBar intent="error">
                <MessageBarBody>{schemaError}</MessageBarBody>
              </MessageBar>
            )}

            {configMsg && (
              <MessageBar
                intent={configIntent === "error" ? "error" : "success"}
              >
                <MessageBarBody>{configMsg}</MessageBarBody>
              </MessageBar>
            )}

            {configLoading || schemaLoading ? (
              <Spinner size="small" label="Loading channel config..." />
            ) : selectedSchema && configPathBase ? (
              <ChannelConfigSchemaForm
                schema={selectedSchema}
                basePath={configPathBase}
                hints={schemaHints}
                getValue={getConfigValue}
                setValue={setConfigValue}
                disabled={configSaving}
              />
            ) : (
              <Text className={styles.lastCheck}>
                Schema unavailable for this channel.
              </Text>
            )}

            <div className={styles.row}>
              <Button
                appearance="primary"
                onClick={() => void saveChannelConfig()}
                disabled={
                  configSaving ||
                  configLoading ||
                  schemaLoading ||
                  !configDirty ||
                  configDraftRoot === null
                }
              >
                {configSaving ? <Spinner size="tiny" /> : "Save"}
              </Button>
              <Button
                appearance="secondary"
                onClick={() => void loadChannelConfig()}
                disabled={configSaving || configLoading}
              >
                Reload
              </Button>
              {configDirty && (
                <Text className={styles.lastCheck}>Unsaved changes</Text>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.detailEmpty}>
          <Text
            style={{
              fontSize: tokens.fontSizeBase400,
              fontWeight: tokens.fontWeightSemibold,
            }}
          >
            Channels
          </Text>
          <Text style={{ color: tokens.colorNeutralForeground3 }}>
            Select a channel to view status and settings.
          </Text>
        </div>
      )}
    </div>
  );
}

export default ChannelsTab;
