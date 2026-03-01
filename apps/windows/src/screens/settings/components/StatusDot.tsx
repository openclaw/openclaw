import { makeStyles, tokens, Text, Tooltip } from "@fluentui/react-components";

type PresenceState = "active" | "idle" | "stale";

interface StatusDotProps {
  state: PresenceState;
  label?: string;
}

const useStyles = makeStyles({
  row: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },
  dot: {
    width: "7px",
    height: "7px",
    borderRadius: "50%",
    flexShrink: 0,
  },
  active: { backgroundColor: tokens.colorPaletteGreenForeground1 },
  idle: { backgroundColor: tokens.colorPaletteYellowForeground1 },
  stale: { backgroundColor: tokens.colorNeutralForeground4 },
  label: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
});

export function StatusDot({ state, label }: StatusDotProps) {
  const styles = useStyles();
  const dotClass = `${styles.dot} ${
    state === "active"
      ? styles.active
      : state === "idle"
        ? styles.idle
        : styles.stale
  }`;
  const tooltip =
    state === "active"
      ? "Active (< 2 min)"
      : state === "idle"
        ? "Idle (< 5 min)"
        : "Stale (> 5 min)";

  return (
    <Tooltip content={tooltip} relationship="label">
      <div className={styles.row}>
        <div className={dotClass} aria-label={tooltip} />
        {label && <Text className={styles.label}>{label}</Text>}
      </div>
    </Tooltip>
  );
}
