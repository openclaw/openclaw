import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Text, tokens, makeStyles } from "@fluentui/react-components";
import { BugRegular, BroomRegular } from "@fluentui/react-icons";
import { formatError } from "../../../utils/error";

const useStyles = makeStyles({
  root: { display: "flex", flexDirection: "column", gap: "16px" },
  section: {
    padding: "16px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground3,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  title: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
  },
  btnRow: { display: "flex", gap: "8px", flexWrap: "wrap" },
});

export function DebugTab() {
  const styles = useStyles();
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const resetCache = async () => {
    if (clearing) return;
    setClearing(true);
    setCacheStatus(null);
    try {
      await invoke("clear_artifact_cache");
      localStorage.clear();
      sessionStorage.clear();
      setCacheStatus("Artifact cache cleared.");
    } catch (err) {
      setCacheStatus(`Failed to clear cache: ${formatError(err)}`);
    } finally {
      setClearing(false);
    }
  };

  const triggerCrash = () => {
    // Trigger an uncaught UI error for crash-reporting pipelines.
    setTimeout(() => {
      throw new Error("Simulated frontend crash from DebugTab");
    }, 0);
  };

  return (
    <div className={styles.root}>
      <Text>
        Development utilities and diagnostics. These are hidden by default.
      </Text>

      <div className={styles.section}>
        <Text className={styles.title}>Actions</Text>
        <div className={styles.btnRow}>
          <Button
            icon={<BroomRegular />}
            onClick={resetCache}
            disabled={clearing}
          >
            {clearing ? "Clearing..." : "Clear Artifact Cache"}
          </Button>
          <Button
            icon={<BugRegular />}
            appearance="outline"
            onClick={triggerCrash}
          >
            Simulate UI Crash
          </Button>
        </div>
        {cacheStatus && <Text>{cacheStatus}</Text>}
      </div>

      <div className={styles.section}>
        <Text className={styles.title}>State</Text>
        <Text
          style={{ fontFamily: "monospace", fontSize: tokens.fontSizeBase200 }}
        >
          OS: {window.navigator.platform}
          <br />
          UA: {window.navigator.userAgent}
        </Text>
      </div>
    </div>
  );
}
