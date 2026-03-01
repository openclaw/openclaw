import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Spinner,
  Text,
  tokens,
  makeStyles,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  DesktopRegular,
  PhoneRegular,
  LaptopRegular,
} from "@fluentui/react-icons";
import { StatusDot } from "../components/StatusDot";
import { formatError } from "../../../utils/error";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "12px" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "12px",
  },
  titleBlock: { display: "flex", flexDirection: "column", gap: "4px" },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "10px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  icon: {
    fontSize: "22px",
    width: "28px",
    textAlign: "center",
    marginTop: "2px",
    flexShrink: 0,
  },
  info: { display: "flex", flexDirection: "column", gap: "4px", flex: 1 },
  nameRow: { display: "flex", alignItems: "center", gap: "8px" },
  name: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  ip: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    fontFamily: "monospace",
  },
  metaRow: { display: "flex", gap: "10px", flexWrap: "wrap" },
  metaTag: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  badge: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    padding: "1px 8px",
    borderRadius: "100px",
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    padding: "12px 0",
  },
});

interface InstanceInfo {
  id: string;
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  mode?: string;
  reason?: string;
  lastInputSeconds?: number;
  ts?: number;
}

function platformIcon(platform?: string) {
  if (!platform) return <DesktopRegular />;
  if (
    platform.toLowerCase().includes("ios") ||
    platform.toLowerCase().includes("iphone")
  )
    return <PhoneRegular />;
  if (platform.toLowerCase().includes("mac")) return <LaptopRegular />;
  return <DesktopRegular />;
}

function prettyPlatform(p?: string): string {
  if (!p) return "";
  return p.replace(/([A-Z])/g, " $1").trim();
}

function normalizeEpochMs(ts?: number): number | null {
  if (!ts || ts <= 0) return null;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
}

function presenceState(ts?: number): "active" | "idle" | "stale" {
  const epochMs = normalizeEpochMs(ts);
  if (!epochMs) return "stale";
  const ageSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (ageSec <= 120) return "active";
  if (ageSec <= 300) return "idle";
  return "stale";
}

export function InstancesTab() {
  const styles = useStyles();
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<InstanceInfo[]>("get_instances");
      setInstances(data);
    } catch (e) {
      setError(formatError(e, "Failed to load instances"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const isGateway = (inst: InstanceInfo) =>
    (inst.mode ?? "").trim().toLowerCase() === "gateway";

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <Text
            style={{
              fontWeight: tokens.fontWeightSemibold,
              fontSize: tokens.fontSizeBase400,
            }}
          >
            Connected Instances
          </Text>
          <Text
            style={{
              fontSize: tokens.fontSizeBase200,
              color: tokens.colorNeutralForeground3,
            }}
          >
            Latest presence beacons from OpenClaw nodes.{" "}
            {instances.length > 0
              ? `${instances.length} instance${instances.length !== 1 ? "s" : ""}`
              : "Updated periodically."}
          </Text>
        </div>
        {loading ? (
          <Spinner size="tiny" />
        ) : (
          <Button
            appearance="subtle"
            icon={<ArrowClockwise20Regular />}
            size="small"
            onClick={refresh}
          >
            Refresh
          </Button>
        )}
      </div>

      {error && (
        <Text
          style={{
            color: tokens.colorPaletteRedForeground1,
            fontSize: tokens.fontSizeBase200,
          }}
        >
          Error: {error}
        </Text>
      )}

      {instances.length === 0 && !loading && !error && (
        <Text className={styles.empty}>No instances reported yet.</Text>
      )}

      {instances.map((inst) => (
        <div key={inst.id} className={styles.row}>
          <div className={styles.icon}>
            {isGateway(inst) ? "🖧" : platformIcon(inst.platform)}
          </div>
          <div className={styles.info}>
            <div className={styles.nameRow}>
              <Text className={styles.name}>{inst.host ?? "unknown host"}</Text>
              <StatusDot state={presenceState(inst.ts)} />
              {isGateway(inst) && <span className={styles.badge}>gateway</span>}
              {inst.ip && <Text className={styles.ip}>({inst.ip})</Text>}
            </div>
            <div className={styles.metaRow}>
              {inst.version && (
                <span className={styles.metaTag}>📦 {inst.version}</span>
              )}
              {inst.deviceFamily && (
                <span className={styles.metaTag}>
                  {platformIcon(inst.platform)} {inst.deviceFamily}
                </span>
              )}
              {inst.platform && (
                <span className={styles.metaTag}>
                  {prettyPlatform(inst.platform)}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
