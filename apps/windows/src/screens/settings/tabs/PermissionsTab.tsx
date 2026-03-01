import { useEffect, useState, useCallback, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Button,
  Text,
  tokens,
  makeStyles,
  Dropdown,
  Option,
  Switch,
  Subtitle2,
  Caption1,
  Card,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  MicRegular,
  CameraRegular,
  DesktopRegular,
  LocationArrowRegular,
  AlertUrgentRegular,
  ShieldLockRegular,
  InfoRegular,
} from "@fluentui/react-icons";
import { StatusDot } from "../components/StatusDot";

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    padding: "4px",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  sectionHeader: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "4px",
  },
  desc: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "10px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  iconBox: {
    width: "32px",
    display: "flex",
    justifyContent: "center",
    color: tokens.colorNeutralForeground2,
  },
  info: { display: "flex", flexDirection: "column", gap: "2px", flex: 1 },
  permLabel: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  permDesc: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  trailing: { display: "flex", alignItems: "center", gap: "8px" },
  card: {
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    backgroundColor: tokens.colorNeutralBackground2,
  },
  settingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "20px",
  },
  allowlistContainer: {
    maxHeight: "200px",
    overflowY: "auto",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    marginTop: "8px",
  },
  allowlistEntry: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    "&:last-child": { borderBottom: "none" },
  },
});

interface ExecAgentSettings {
  security: "deny" | "allow" | "allowlist";
  ask: "never" | "new" | "always";
  autoAllowSkills: boolean;
}

interface ExecAllowlistEntry {
  pattern: string;
  createdAt: number;
  lastUsedAt?: number;
  useCount: number;
  description?: string;
}

interface ExecApprovalsFile {
  global: ExecAgentSettings;
  agents: Record<string, ExecAgentSettings>;
  allowlist: ExecAllowlistEntry[];
}

interface ExecApprovalsSnapshot {
  file: ExecApprovalsFile;
  hash: string;
}

function isSecurityValue(
  v: string | undefined
): v is ExecAgentSettings["security"] {
  return v === "deny" || v === "allow" || v === "allowlist";
}

function isAskValue(v: string | undefined): v is ExecAgentSettings["ask"] {
  return v === "never" || v === "new" || v === "always";
}

interface PermStatus {
  microphone: boolean;
  camera: boolean;
  screenCapture: boolean;
  speechRecognition: boolean;
  notifications: boolean;
  accessibility: boolean;
  location: boolean;
  appleScript: boolean;
}

interface PermissionDef {
  key: keyof PermStatus;
  label: string;
  desc: string;
  icon: ReactNode;
  winPage: string;
}

const PERMISSIONS: PermissionDef[] = [
  {
    key: "notifications",
    label: "Notifications",
    desc: "Used to alert you about agent actions and events.",
    icon: <AlertUrgentRegular />,
    winPage: "notifications",
  },
  {
    key: "accessibility",
    label: "Accessibility",
    desc: "Allows the agent to interact with UI elements.",
    icon: <ShieldLockRegular />,
    winPage: "accessibility",
  },
  {
    key: "microphone",
    label: "Microphone",
    desc: "Required for voice commands and audio input.",
    icon: <MicRegular />,
    winPage: "microphone",
  },
  {
    key: "camera",
    label: "Camera",
    desc: "Lets the agent capture photos on request.",
    icon: <CameraRegular />,
    winPage: "camera",
  },
  {
    key: "screenCapture",
    label: "Screen Recording",
    desc: "Required for screenshots and vision-based tasks.",
    icon: <DesktopRegular />,
    winPage: "screen_capture",
  },
  {
    key: "speechRecognition",
    label: "Speech Recognition",
    desc: "Used for transcription and voice wake.",
    icon: <MicRegular />,
    winPage: "speech_recognition",
  },
  {
    key: "location",
    label: "Location",
    desc: "Provides approximate location to the agent.",
    icon: <LocationArrowRegular />,
    winPage: "location",
  },
];

export function PermissionsTab() {
  const styles = useStyles();
  const [status, setStatus] = useState<PermStatus | null>(null);
  const [execSnapshot, setExecSnapshot] =
    useState<ExecApprovalsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, e] = await Promise.all([
        invoke<PermStatus>("get_permissions_status"),
        invoke<ExecApprovalsSnapshot>("system.exec_approvals.get"),
      ]);
      setStatus(s);
      setExecSnapshot(e);
    } catch (error) {
      console.error("Failed to load permissions status", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const saveExecSettings = async (file: ExecApprovalsFile) => {
    setUpdating(true);
    try {
      const next = await invoke<ExecApprovalsSnapshot>(
        "system.exec_approvals.set",
        {
          file,
          baseHash: execSnapshot?.hash,
        }
      );
      setExecSnapshot(next);
    } catch (e) {
      console.error("Failed to save exec settings", e);
    } finally {
      setUpdating(false);
    }
  };

  const updateGlobalSetting = <K extends keyof ExecAgentSettings>(
    key: K,
    value: ExecAgentSettings[K]
  ) => {
    if (!execSnapshot) return;
    const nextFile = {
      ...execSnapshot.file,
      global: { ...execSnapshot.file.global, [key]: value },
    };
    saveExecSettings(nextFile);
  };

  const openPerm = (page: string) =>
    invoke("open_windows_permission", { capability: page }).catch((error) => {
      console.error(`Failed to open permission page: ${page}`, error);
    });

  return (
    <div className={styles.root}>
      {/* Exec Approvals Section */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <Subtitle2>Exec Approvals</Subtitle2>
          <Caption1 className={styles.desc}>
            Control which terminal commands agent can run. Settings here apply
            globally.
          </Caption1>
        </div>

        <Card className={styles.card}>
          <div className={styles.settingRow}>
            <div className={styles.info}>
              <Text weight="semibold">Security Policy</Text>
              <Caption1 className={styles.desc}>
                Overall execution level
              </Caption1>
            </div>
            <Dropdown
              size="small"
              value={execSnapshot?.file.global.security ?? "allowlist"}
              selectedOptions={[
                execSnapshot?.file.global.security ?? "allowlist",
              ]}
              onOptionSelect={(_, data) => {
                if (isSecurityValue(data.optionValue))
                  updateGlobalSetting("security", data.optionValue);
              }}
              disabled={updating}
              listbox={{
                style: { backgroundColor: tokens.colorNeutralBackground2 },
              }}
            >
              <Option value="allow">Allow All</Option>
              <Option value="allowlist">Allowlist Only</Option>
              <Option value="deny">Deny All</Option>
            </Dropdown>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.info}>
              <Text weight="semibold">Require Approval</Text>
              <Caption1 className={styles.desc}>
                When to prompt for confirmation
              </Caption1>
            </div>
            <Dropdown
              size="small"
              value={execSnapshot?.file.global.ask ?? "new"}
              selectedOptions={[execSnapshot?.file.global.ask ?? "new"]}
              onOptionSelect={(_, data) => {
                if (isAskValue(data.optionValue))
                  updateGlobalSetting("ask", data.optionValue);
              }}
              disabled={updating}
              listbox={{
                style: { backgroundColor: tokens.colorNeutralBackground2 },
              }}
            >
              <Option value="never">Never (Auto-approve)</Option>
              <Option value="new">For New Commands</Option>
              <Option value="always">Always Prompt</Option>
            </Dropdown>
          </div>

          <div className={styles.settingRow}>
            <div className={styles.info}>
              <Text weight="semibold">Auto-allow Skill CLIs</Text>
              <Caption1 className={styles.desc}>
                Trusted binaries from installed skills
              </Caption1>
            </div>
            <Switch
              checked={execSnapshot?.file.global.autoAllowSkills ?? true}
              onChange={(_, data) =>
                updateGlobalSetting("autoAllowSkills", data.checked)
              }
              disabled={updating}
            />
          </div>

          {execSnapshot && execSnapshot.file.allowlist.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <Text weight="semibold" size={200}>
                Allowlist Entries
              </Text>
              <div className={styles.allowlistContainer}>
                {execSnapshot.file.allowlist.map((entry, i) => (
                  <div key={i} className={styles.allowlistEntry}>
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <code>{entry.pattern}</code>
                      <Caption1 className={styles.desc}>
                        Used {entry.useCount} times
                      </Caption1>
                    </div>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<InfoRegular />}
                      onClick={() =>
                        alert(
                          `Created: ${new Date(entry.createdAt).toLocaleString()}\nPattern: ${entry.pattern}`
                        )
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Permissions Section */}
      <div className={styles.section}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div className={styles.sectionHeader}>
            <Subtitle2>Permission Status</Subtitle2>
            <Caption1 className={styles.desc}>
              Grant system-level access to hardware and data.
            </Caption1>
          </div>
          <Button
            appearance="subtle"
            icon={loading ? undefined : <ArrowClockwise20Regular />}
            size="small"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? "Checking…" : "Refresh"}
          </Button>
        </div>

        <div>
          {PERMISSIONS.map((perm) => {
            const granted = status?.[perm.key] ?? false;
            return (
              <div key={perm.key} className={styles.row}>
                <div className={styles.iconBox}>{perm.icon}</div>
                <div className={styles.info}>
                  <Text className={styles.permLabel}>{perm.label}</Text>
                  <Text className={styles.permDesc}>{perm.desc}</Text>
                </div>
                <div className={styles.trailing}>
                  <StatusDot state={granted ? "active" : "stale"} />
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() => openPerm(perm.winPage)}
                  >
                    {granted ? "Settings" : "Allow"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
