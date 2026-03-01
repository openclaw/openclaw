import {
  makeStyles,
  mergeClasses,
  tokens,
  Text,
  Switch,
} from "@fluentui/react-components";
import type { SwitchOnChangeData } from "@fluentui/react-components";
import type { ChangeEvent, ReactNode } from "react";

interface SettingsRowProps {
  icon?: ReactNode;
  label: string;
  subtitle?: string;
  statusText?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

const useStyles = makeStyles({
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "10px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    "&:last-child": {
      borderBottom: "none",
    },
  },
  rowDisabled: {
    opacity: 0.66,
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flex: 1,
    minWidth: 0,
  },
  icon: {
    color: tokens.colorNeutralForeground2,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "20px",
  },
  iconDisabled: {
    color: tokens.colorNeutralForegroundDisabled,
  },
  labelGroup: {
    display: "flex",
    flexDirection: "column",
    gap: "1px",
    minWidth: 0,
  },
  label: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase300,
  },
  labelDisabled: {
    color: tokens.colorNeutralForeground3,
  },
  subtitle: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase200,
  },
  subtitleDisabled: {
    color: tokens.colorNeutralForegroundDisabled,
  },
  status: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    lineHeight: tokens.lineHeightBase100,
    marginTop: "1px",
    fontWeight: tokens.fontWeightSemibold,
  },
});

export function SettingsRow({
  icon,
  label,
  subtitle,
  statusText,
  checked,
  disabled = false,
  onChange,
}: SettingsRowProps) {
  const styles = useStyles();

  const handleChange = (
    _: ChangeEvent<HTMLInputElement>,
    data: SwitchOnChangeData
  ) => {
    onChange(data.checked);
  };

  return (
    <div className={mergeClasses(styles.row, disabled && styles.rowDisabled)}>
      <div className={styles.left}>
        {icon && (
          <span
            className={mergeClasses(
              styles.icon,
              disabled && styles.iconDisabled
            )}
          >
            {icon}
          </span>
        )}
        <div className={styles.labelGroup}>
          <Text
            className={mergeClasses(
              styles.label,
              disabled && styles.labelDisabled
            )}
          >
            {label}
          </Text>
          {subtitle && (
            <Text
              className={mergeClasses(
                styles.subtitle,
                disabled && styles.subtitleDisabled
              )}
            >
              {subtitle}
            </Text>
          )}
          {statusText && <Text className={styles.status}>{statusText}</Text>}
        </div>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={handleChange} />
    </div>
  );
}
