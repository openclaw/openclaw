import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  makeStyles,
  tokens,
  Tooltip,
} from "@fluentui/react-components";
import { SettingsRegular } from "@fluentui/react-icons";

const useStyles = makeStyles({
  settingsBtn: {
    minWidth: "auto",
    height: "28px",
    padding: "0 8px",
    color: tokens.colorNeutralForeground2,
    "&:hover": {
      color: tokens.colorNeutralForeground1,
      backgroundColor: tokens.colorNeutralBackground1Hover,
    },
  },
});

export function SettingsButton() {
  const styles = useStyles();

  const openSettings = async () => {
    try {
      await invoke("open_settings");
    } catch (e) {
      console.error("Failed to open settings", e);
    }
  };

  return (
    <Tooltip content="Settings" relationship="label">
      <Button
        appearance="subtle"
        className={styles.settingsBtn}
        icon={<SettingsRegular />}
        onClick={openSettings}
        aria-label="Open Settings"
      />
    </Tooltip>
  );
}
