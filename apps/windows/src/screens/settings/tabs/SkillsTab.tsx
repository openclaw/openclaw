import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Button,
  Dropdown,
  Input,
  Option,
  Spinner,
  Text,
  tokens,
  makeStyles,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogActions,
  DialogContent,
  Badge,
  Switch,
} from "@fluentui/react-components";
import { ArrowClockwise20Regular, LinkRegular } from "@fluentui/react-icons";
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
  headerRight: { display: "flex", gap: "8px", alignItems: "center" },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
    padding: "12px 0",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  emoji: {
    fontSize: "22px",
    width: "32px",
    flexShrink: 0,
    textAlign: "center",
    paddingTop: "2px",
  },
  body: { display: "flex", flexDirection: "column", gap: "6px", flex: 1 },
  nameRow: { display: "flex", alignItems: "center", gap: "8px" },
  name: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  desc: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  metaRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap",
  },
  sourceBadge: {
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    padding: "1px 8px",
    borderRadius: "100px",
    backgroundColor: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground3,
  },
  missingText: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  configCheck: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: tokens.fontSizeBase100,
  },
  checkOk: { color: tokens.colorPaletteGreenForeground1 },
  checkFail: { color: tokens.colorNeutralForeground3 },
  envActions: { display: "flex", gap: "6px", flexWrap: "wrap" },
  trailing: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    alignItems: "flex-end",
    flexShrink: 0,
  },
  installBtns: { display: "flex", gap: "6px" },
  statusBanner: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    fontStyle: "italic",
  },
  errorBanner: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorPaletteRedForeground1,
  },
  empty: { color: tokens.colorNeutralForeground3, padding: "12px 0" },
});

type FilterType = "all" | "ready" | "needsSetup" | "disabled";
const FILTERS: { value: FilterType; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "needsSetup", label: "Needs Setup" },
  { value: "disabled", label: "Disabled" },
];

interface ConfigCheck {
  path: string;
  value?: unknown;
  satisfied: boolean;
}
interface InstallOption {
  id: string;
  kind: string;
  label: string;
  bins?: string[];
}
interface SkillMissing {
  bins: string[];
  env: string[];
  config: string[];
}

interface Skill {
  skillKey: string;
  name: string;
  description: string;
  source: string;
  emoji?: string;
  homepage?: string;
  primaryEnv?: string;
  disabled: boolean;
  eligible: boolean;
  missing: SkillMissing;
  configChecks?: ConfigCheck[];
  install?: InstallOption[];
}

type InstallTarget = "gateway" | "local";

interface FullConfig {
  gatewayMode?: string;
}

function sourceLabel(source: string): string {
  switch (source) {
    case "openclaw-bundled":
      return "Bundled";
    case "openclaw-managed":
      return "Managed";
    case "openclaw-workspace":
      return "Workspace";
    case "openclaw-extra":
      return "Extra";
    case "openclaw-plugin":
      return "Plugin";
    default:
      return source;
  }
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface EnvDialogProps {
  open: boolean;
  onClose: () => void;
  skillName: string;
  envKey: string;
  isPrimary: boolean;
  onSave: (value: string) => void;
}

function EnvDialog({
  open: isOpen,
  onClose,
  skillName,
  envKey,
  isPrimary,
  onSave,
}: EnvDialogProps) {
  const [value, setValue] = useState("");
  return (
    <Dialog open={isOpen} onOpenChange={(_, s) => !s.open && onClose()}>
      <DialogSurface
        style={{ backgroundColor: tokens.colorNeutralBackground2 }}
      >
        <DialogBody>
          <DialogTitle>
            {isPrimary ? "Set API Key" : "Set Environment Variable"}
          </DialogTitle>
          <DialogContent>
            <Text
              style={{
                fontSize: tokens.fontSizeBase200,
                color: tokens.colorNeutralForeground3,
              }}
            >
              Skill: {skillName}
            </Text>
            <Input
              type="password"
              placeholder={envKey}
              value={value}
              onChange={(_, d) => setValue(d.value)}
              style={{
                marginTop: "10px",
                width: "100%",
                fontFamily: "monospace",
              }}
            />
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={!value.trim()}
              onClick={() => {
                onSave(value);
                onClose();
              }}
            >
              Save
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function SkillsTab() {
  const styles = useStyles();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<FilterType>("all");
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envDialog, setEnvDialog] = useState<{
    skillKey: string;
    skillName: string;
    envKey: string;
    isPrimary: boolean;
  } | null>(null);
  const [gatewayMode, setGatewayMode] = useState("local");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<Skill[]>("get_skills");
      setSkills(data.sort((a, b) => a.name.localeCompare(b.name)));
      // Gateway mode controls install button label (local vs gateway).
      const cfg = await invoke<FullConfig>("get_full_config").catch(
        (): FullConfig => ({})
      );
      setGatewayMode(cfg.gatewayMode ?? "local");
    } catch (e) {
      setError(formatError(e, "Failed to load skills"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const withBusy = async (key: string, fn: () => Promise<void>) => {
    setBusyKeys((prev) => new Set(prev).add(key));
    try {
      await fn();
    } finally {
      setBusyKeys((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  };

  const toggleEnabled = (sk: Skill, enabled: boolean) =>
    withBusy(sk.skillKey, async () => {
      try {
        await invoke("set_skill_enabled", {
          payload: { skillKey: sk.skillKey, enabled },
        });
        setStatus(enabled ? "Skill enabled" : "Skill disabled");
        await refresh();
      } catch (e) {
        setStatus(`Failed to update skill: ${formatError(e)}`);
      }
    });

  const installSkill = (sk: Skill, optionId: string, target: InstallTarget) =>
    withBusy(sk.skillKey, async () => {
      try {
        const result = await invoke<{ message?: string }>("install_skill", {
          payload: {
            skillKey: sk.skillKey,
            skillName: sk.name,
            installId: optionId,
            target,
            timeoutMs: 300000,
          },
        });
        setStatus(result.message ?? "Install request sent");
        await refresh();
      } catch (e) {
        setStatus(`Failed to install skill: ${formatError(e)}`);
      }
    });

  const saveEnv = async (
    skillKey: string,
    envKey: string,
    value: string,
    isPrimary: boolean
  ) =>
    withBusy(skillKey, async () => {
      try {
        await invoke("set_skill_env", {
          payload: { skillKey, envKey, value, isPrimary },
        });
        setStatus(isPrimary ? "Saved API key" : `Saved ${envKey}`);
        await refresh();
      } catch (e) {
        setStatus(`Failed to save environment: ${formatError(e)}`);
      }
    });

  const filtered = skills.filter((sk) => {
    switch (filter) {
      case "ready":
        return !sk.disabled && sk.eligible;
      case "needsSetup":
        return !sk.disabled && !sk.eligible;
      case "disabled":
        return sk.disabled;
      default:
        return true;
    }
  });

  const isRemote = gatewayMode !== "local";

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
            Skills
          </Text>
          <Text
            style={{
              fontSize: tokens.fontSizeBase200,
              color: tokens.colorNeutralForeground3,
            }}
          >
            Skills are enabled when requirements are met (binaries, env,
            config).
          </Text>
        </div>
        <div className={styles.headerRight}>
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
          <Dropdown
            value={FILTERS.find((f) => f.value === filter)?.label ?? "All"}
            selectedOptions={[filter]}
            onOptionSelect={(_, d) => setFilter(d.optionValue as FilterType)}
            listbox={{
              style: { backgroundColor: tokens.colorNeutralBackground2 },
            }}
          >
            {FILTERS.map((f) => (
              <Option key={f.value} value={f.value}>
                {f.label}
              </Option>
            ))}
          </Dropdown>
        </div>
      </div>

      {error && <Text className={styles.errorBanner}>{error}</Text>}
      {status && !error && (
        <Text className={styles.statusBanner}>{status}</Text>
      )}

      {skills.length === 0 && !loading && (
        <Text className={styles.empty}>No skills reported yet.</Text>
      )}
      {skills.length > 0 && filtered.length === 0 && (
        <Text className={styles.empty}>No skills match this filter.</Text>
      )}

      {filtered.map((sk) => {
        const isBusy = busyKeys.has(sk.skillKey);
        const missingBins = sk.missing?.bins ?? [];
        const missingEnv = sk.missing?.env ?? [];
        const missingConfig = sk.missing?.config ?? [];
        const installOpts =
          sk.install?.filter(
            (o) =>
              !missingBins.length ||
              !o.bins?.length ||
              o.bins.some((b) => missingBins.includes(b))
          ) ?? [];
        const requirementsMet =
          !missingBins.length && !missingEnv.length && !missingConfig.length;

        return (
          <div key={sk.skillKey} className={styles.row}>
            <div className={styles.emoji}>{sk.emoji ?? "*"}</div>
            <div className={styles.body}>
              <div className={styles.nameRow}>
                <Text className={styles.name}>{sk.name}</Text>
              </div>
              <Text className={styles.desc}>{sk.description}</Text>

              <div className={styles.metaRow}>
                <Badge className={styles.sourceBadge}>
                  {sourceLabel(sk.source)}
                </Badge>
                {sk.homepage && (
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<LinkRegular />}
                    onClick={() => openUrl(sk.homepage!)}
                  >
                    Website
                  </Button>
                )}
              </div>

              {!sk.disabled && !requirementsMet && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  }}
                >
                  {missingBins.length > 0 && installOpts.length === 0 && (
                    <Text className={styles.missingText}>
                      Missing binaries: {missingBins.join(", ")}
                    </Text>
                  )}
                  {missingEnv.length > 0 && (
                    <Text className={styles.missingText}>
                      Missing env: {missingEnv.join(", ")}
                    </Text>
                  )}
                  {missingConfig.length > 0 && (
                    <Text className={styles.missingText}>
                      Requires config: {missingConfig.join(", ")}
                    </Text>
                  )}
                </div>
              )}
              {sk.disabled && (
                <Text className={styles.missingText}>Disabled in config</Text>
              )}

              {sk.configChecks && sk.configChecks.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "2px",
                  }}
                >
                  {sk.configChecks.map((chk, i) => (
                    <div key={i} className={styles.configCheck}>
                      <Text
                        className={
                          chk.satisfied ? styles.checkOk : styles.checkFail
                        }
                      >
                        {chk.satisfied ? "OK" : "X"}
                      </Text>
                      <Text style={{ fontFamily: "monospace" }}>
                        {chk.path}
                      </Text>
                      {chk.value !== undefined && chk.value !== null && (
                        <Text style={{ color: tokens.colorNeutralForeground3 }}>
                          {formatConfigValue(chk.value)}
                        </Text>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {missingEnv.length > 0 && (
                <div className={styles.envActions}>
                  {missingEnv.map((envKey) => {
                    const isPrimary = envKey === sk.primaryEnv;
                    return (
                      <Button
                        key={envKey}
                        size="small"
                        appearance="outline"
                        disabled={isBusy}
                        onClick={() =>
                          setEnvDialog({
                            skillKey: sk.skillKey,
                            skillName: sk.name,
                            envKey,
                            isPrimary,
                          })
                        }
                      >
                        {isPrimary ? "Set API Key" : `Set ${envKey}`}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={styles.trailing}>
              {installOpts.length > 0 ? (
                installOpts.map((opt) => (
                  <div key={opt.id} className={styles.installBtns}>
                    {isRemote && (
                      <Button
                        size="small"
                        appearance="primary"
                        disabled={isBusy}
                        onClick={() => installSkill(sk, opt.id, "gateway")}
                      >
                        Install on Gateway
                      </Button>
                    )}
                    <Button
                      size="small"
                      appearance={isRemote ? "secondary" : "primary"}
                      disabled={isBusy}
                      title={
                        isRemote
                          ? "Switches to Local mode to install on this Windows."
                          : undefined
                      }
                      onClick={() => installSkill(sk, opt.id, "local")}
                    >
                      Install on This Windows
                    </Button>
                  </div>
                ))
              ) : (
                <Switch
                  checked={!sk.disabled}
                  disabled={isBusy || !requirementsMet}
                  onChange={(_, data) => toggleEnabled(sk, data.checked)}
                  aria-label={`Enable ${sk.name}`}
                />
              )}
              {isBusy && <Spinner size="tiny" />}
            </div>
          </div>
        );
      })}

      {envDialog && (
        <EnvDialog
          open={!!envDialog}
          onClose={() => setEnvDialog(null)}
          skillName={envDialog.skillName}
          envKey={envDialog.envKey}
          isPrimary={envDialog.isPrimary}
          onSave={(value) =>
            saveEnv(
              envDialog.skillKey,
              envDialog.envKey,
              value,
              envDialog.isPrimary
            )
          }
        />
      )}
    </div>
  );
}
