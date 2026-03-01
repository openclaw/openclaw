import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Spinner,
  Text,
  tokens,
  makeStyles,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular } from "@fluentui/react-icons";
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
    flexDirection: "column",
    gap: "6px",
    padding: "10px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  topRow: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "8px",
  },
  label: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  age: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  badges: { display: "flex", gap: "6px", flexWrap: "wrap" },
  badge: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    padding: "2px 8px",
    borderRadius: "100px",
  },
  contextBar: {
    height: "4px",
    borderRadius: "2px",
    backgroundColor: tokens.colorNeutralBackground5,
    overflow: "hidden",
  },
  contextFill: {
    height: "100%",
    backgroundColor: tokens.colorBrandForeground1,
  },
  metaRow: { display: "flex", gap: "12px", flexWrap: "wrap" },
  metaItem: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  sessionId: {
    fontSize: tokens.fontSizeBase100,
    fontFamily: "monospace",
    color: tokens.colorNeutralForeground3,
    maxWidth: "120px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  empty: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    padding: "8px 0",
  },
});

interface Session {
  key: string;
  label: string;
  model?: string;
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number;
  contextMax?: number;
  kind?: string;
  flags?: string[];
  updatedAt?: number;
}

function kindColor(kind?: string): string {
  switch (kind) {
    case "direct":
      return tokens.colorPaletteGreenForeground1;
    case "rpc":
      return tokens.colorBrandForeground1;
    default:
      return tokens.colorNeutralForeground3;
  }
}

function ageText(ts?: number): string {
  if (!ts) return "";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function fmt(n?: number): string {
  if (!n) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function SessionsTab() {
  const styles = useStyles();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Session[]>("get_sessions");
      setSessions(data.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)));
    } catch (e) {
      setError(formatError(e, "Failed to load sessions"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
            Sessions
          </Text>
          <Text
            style={{
              fontSize: tokens.fontSizeBase200,
              color: tokens.colorNeutralForeground3,
            }}
          >
            Stored conversation buckets the CLI reuses for context and rate
            limits.
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
          {error}
        </Text>
      )}

      {sessions.length === 0 && !loading && !error && (
        <Text className={styles.empty}>
          No sessions yet. They appear after the first inbound message or
          heartbeat.
        </Text>
      )}

      {sessions.map((sess) => {
        const barPct =
          sess.contextMax && sess.contextUsed
            ? Math.min(100, (sess.contextUsed / sess.contextMax) * 100)
            : 0;
        return (
          <div key={sess.key} className={styles.row}>
            <div className={styles.topRow}>
              <Text
                className={styles.label}
                style={{
                  maxWidth: "280px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {sess.label || sess.key}
              </Text>
              <Text className={styles.age}>{ageText(sess.updatedAt)}</Text>
            </div>

            {(sess.kind || (sess.flags?.length ?? 0) > 0) && (
              <div className={styles.badges}>
                {sess.kind && sess.kind !== "direct" && (
                  <span
                    className={styles.badge}
                    style={{
                      backgroundColor: `${kindColor(sess.kind)}22`,
                      color: kindColor(sess.kind),
                    }}
                  >
                    {sess.kind.toUpperCase()}
                  </span>
                )}
                {sess.flags?.map((f) => (
                  <span
                    key={f}
                    className={styles.badge}
                    style={{
                      backgroundColor: tokens.colorNeutralBackground5,
                      color: tokens.colorNeutralForeground2,
                    }}
                  >
                    {f}
                  </span>
                ))}
              </div>
            )}

            <div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "3px",
                }}
              >
                <Text
                  style={{
                    fontSize: tokens.fontSizeBase100,
                    fontWeight: tokens.fontWeightSemibold,
                    color: tokens.colorNeutralForeground3,
                  }}
                >
                  Context
                </Text>
                <Text
                  style={{
                    fontSize: tokens.fontSizeBase100,
                    color: tokens.colorNeutralForeground3,
                    fontFamily: "monospace",
                  }}
                >
                  {sess.contextUsed
                    ? `${fmt(sess.contextUsed)} / ${fmt(sess.contextMax)} tok`
                    : "—"}
                </Text>
              </div>
              <div className={styles.contextBar}>
                <div
                  className={styles.contextFill}
                  style={{ width: `${barPct}%` }}
                />
              </div>
            </div>

            <div className={styles.metaRow}>
              {sess.model && (
                <span className={styles.metaItem}>⚙ {sess.model}</span>
              )}
              <span className={styles.metaItem}>
                ↓ {fmt(sess.inputTokens)} in
              </span>
              <span className={styles.metaItem}>
                ↑ {fmt(sess.outputTokens)} out
              </span>
              {sess.sessionId && (
                <span className={styles.sessionId} title={sess.sessionId}>
                  # {sess.sessionId}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
