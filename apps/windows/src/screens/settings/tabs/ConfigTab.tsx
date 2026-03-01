import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Text,
  Button,
  Spinner,
  makeStyles,
  tokens,
  Textarea,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import { SaveRegular, ArrowClockwiseRegular } from "@fluentui/react-icons";
import { formatError } from "../../../utils/error";

const useStyles = makeStyles({
  toolbar: {
    display: "flex",
    gap: "8px",
    marginBottom: "12px",
    alignItems: "center",
  },
  subtitle: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    marginBottom: "16px",
    display: "block",
  },
  dirty: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
    marginLeft: "auto",
  },
  editor: {
    width: "100%",
    fontFamily: "Cascadia Code, Consolas, monospace",
    fontSize: "13px",
    minHeight: "420px",
  },
  error: {
    marginBottom: "10px",
  },
});

export function ConfigTab() {
  const styles = useStyles();
  const [rawJson, setRawJson] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<unknown>("get_openclaw_json");
      const pretty = JSON.stringify(data, null, 2);
      setRawJson(pretty);
      setOriginal(pretty);
    } catch (e) {
      setError(`Failed to load config: ${formatError(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    setError(null);
    let parsed: unknown;
    try {
      // Validate JSON before sending it to the backend.
      parsed = JSON.parse(rawJson);
    } catch {
      setError("Invalid JSON - please fix the syntax before saving.");
      return;
    }
    setSaving(true);
    try {
      await invoke("save_openclaw_json", { content: parsed });
      setOriginal(rawJson);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (e) {
      setError(`Failed to save: ${formatError(e)}`);
    } finally {
      setSaving(false);
    }
  }

  const isDirty = rawJson !== original;

  return (
    <div>
      <Text className={styles.subtitle}>
        Edit <code>~/.openclaw/openclaw.json</code> directly. Changes are
        validated before saving.
      </Text>

      {error && (
        <MessageBar intent="error" className={styles.error}>
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      {success && (
        <MessageBar intent="success" className={styles.error}>
          <MessageBarBody>Config saved successfully.</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.toolbar}>
        <Button
          icon={<ArrowClockwiseRegular />}
          onClick={loadConfig}
          disabled={loading || saving}
        >
          Reload
        </Button>
        <Button
          icon={saving ? <Spinner size="tiny" /> : <SaveRegular />}
          appearance="primary"
          onClick={saveConfig}
          disabled={!isDirty || loading || saving}
        >
          {saving ? "Saving..." : "Save"}
        </Button>
        {isDirty && <Text className={styles.dirty}>Unsaved changes</Text>}
      </div>

      {loading ? (
        <Spinner size="small" label="Loading config..." />
      ) : (
        <Textarea
          className={styles.editor}
          value={rawJson}
          onChange={(_, d) => setRawJson(d.value)}
          resize="vertical"
        />
      )}
    </div>
  );
}
