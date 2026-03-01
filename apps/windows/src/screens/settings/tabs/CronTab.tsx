import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Input,
  Label,
  makeStyles,
  mergeClasses,
  MessageBar,
  MessageBarBody,
  Option,
  OptionOnSelectData,
  SelectionEvents,
  Spinner,
  Switch,
  Text,
  Textarea,
  tokens,
} from "@fluentui/react-components";
import {
  AddRegular,
  ArrowClockwiseRegular,
  DeleteRegular,
  EditRegular,
  PlayRegular,
} from "@fluentui/react-icons";
import { formatError } from "../../../utils/error";

type CronSessionTarget = "main" | "isolated";
type CronWakeMode = "now" | "next-heartbeat";
type CronScheduleKind = "cron" | "every" | "at";
type CronPayloadKind = "systemEvent" | "agentTurn";
type CronDeliveryMode = "announce" | "none";

interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: string;
  prompt: string;
  channelId?: string;
  lastRun?: number;
  nextRun?: number;
  agentId?: string;
  sessionKey?: string;
  sessionTarget?: string;
  wakeMode?: string;
  deleteAfterRun?: boolean;
  scheduleData?: unknown;
  payloadData?: unknown;
  deliveryData?: unknown;
  lastStatus?: string;
  lastError?: string;
  lastDurationMs?: number;
}

interface CronSchedulerStatus {
  enabled: boolean;
  storePath?: string;
  nextWakeAtMs?: number;
  jobs?: number;
}

interface CronRunEntry {
  id: string;
  ts: number;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  durationMs?: number;
  runAtMs?: number;
  nextRunAtMs?: number;
}

interface ChannelInfo {
  id: string;
  name: string;
}

interface GatewayEventFrame {
  type?: string;
  event?: string;
  payload?: {
    jobId?: string;
    action?: string;
  };
}

interface TranscriptLine {
  id: string;
  role: string;
  content: string;
}

interface CronFormState {
  id?: string;
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  deleteAfterRun: boolean;
  scheduleKind: CronScheduleKind;
  cronExpr: string;
  cronTz: string;
  everyText: string;
  atLocal: string;
  payloadKind: CronPayloadKind;
  systemEventText: string;
  agentMessage: string;
  thinking: string;
  timeoutSeconds: string;
  deliveryMode: CronDeliveryMode;
  channelId: string;
  to: string;
  bestEffortDeliver: boolean;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flattenMessageContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenMessageContent(item))
      .filter((item) => item.length > 0)
      .join(" ")
      .trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct = ["text", "content", "message", "value"]
      .map((key) => record[key])
      .map((candidate) => flattenMessageContent(candidate))
      .find((candidate) => candidate.length > 0);
    if (direct) return direct;
  }
  return "";
}

function transcriptLinesFromPayload(payload: unknown): TranscriptLine[] {
  const root = asRecord(payload);
  const messages = Array.isArray(root?.messages)
    ? root?.messages
    : Array.isArray(payload)
      ? payload
      : [];
  return messages
    .map((item, index) => {
      const record = asRecord(item);
      const role =
        readString(record, "role") || readString(record, "type") || "message";
      const content =
        flattenMessageContent(record?.content) ||
        flattenMessageContent(record?.message) ||
        flattenMessageContent(record);
      return {
        id: `${role}-${index}`,
        role,
        content: content || safeStringify(record ?? item),
      };
    })
    .filter((line) => line.content.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  key: string
): string {
  if (!record) return "";
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readNumber(
  record: Record<string, unknown> | null,
  key: string
): number | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDateTimeInput(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function defaultAtLocal(): string {
  const now = new Date();
  now.setMinutes(now.getMinutes() + 5, 0, 0);
  return toLocalDateTimeInput(now);
}

function isoToLocalDateTimeInput(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return toLocalDateTimeInput(date);
}

function localDateTimeToIso(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseDurationMs(text: string): number | null {
  const raw = text.trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60000
          : unit === "h"
            ? 3600000
            : 86400000;
  return Math.floor(amount * factor);
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 86400000 === 0) return `${ms / 86400000}d`;
  if (ms % 3600000 === 0) return `${ms / 3600000}h`;
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function fmtTime(ms?: number): string {
  if (!ms || ms <= 0) return "-";
  return new Date(ms).toLocaleString();
}

function relativeDue(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const delta = ms - Date.now();
  if (delta <= 0) return "due";
  if (delta < 60000) return "in <1m";
  const mins = Math.round(delta / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function createEmptyForm(): CronFormState {
  return {
    name: "",
    description: "",
    agentId: "",
    enabled: true,
    sessionTarget: "main",
    wakeMode: "now",
    deleteAfterRun: false,
    scheduleKind: "cron",
    cronExpr: "0 9 * * *",
    cronTz: "",
    everyText: "1h",
    atLocal: defaultAtLocal(),
    payloadKind: "systemEvent",
    systemEventText: "",
    agentMessage: "",
    thinking: "",
    timeoutSeconds: "",
    deliveryMode: "announce",
    channelId: "last",
    to: "",
    bestEffortDeliver: false,
  };
}
function formFromJob(job: CronJob): CronFormState {
  const schedule = asRecord(job.scheduleData);
  const payload = asRecord(job.payloadData);
  const delivery = asRecord(job.deliveryData);
  const scheduleKind = (readString(schedule, "kind") ||
    "cron") as CronScheduleKind;
  const sessionTarget = job.sessionTarget === "isolated" ? "isolated" : "main";

  return {
    id: job.id,
    name: job.name || "",
    description: job.description || "",
    agentId: job.agentId || "",
    enabled: job.enabled,
    sessionTarget,
    wakeMode: job.wakeMode === "next-heartbeat" ? "next-heartbeat" : "now",
    deleteAfterRun: Boolean(job.deleteAfterRun),
    scheduleKind:
      scheduleKind === "at" ||
      scheduleKind === "every" ||
      scheduleKind === "cron"
        ? scheduleKind
        : "cron",
    cronExpr: readString(schedule, "expr") || "0 9 * * *",
    cronTz: readString(schedule, "tz"),
    everyText: readNumber(schedule, "everyMs")
      ? formatDurationMs(readNumber(schedule, "everyMs") || 3600000)
      : "1h",
    atLocal:
      isoToLocalDateTimeInput(readString(schedule, "at")) || defaultAtLocal(),
    payloadKind:
      sessionTarget === "isolated"
        ? "agentTurn"
        : readString(payload, "kind") === "agentTurn"
          ? "agentTurn"
          : "systemEvent",
    systemEventText:
      readString(payload, "text") ||
      (sessionTarget === "main" ? job.prompt : ""),
    agentMessage:
      readString(payload, "message") ||
      (sessionTarget === "isolated" ? job.prompt : ""),
    thinking: readString(payload, "thinking"),
    timeoutSeconds: String(readNumber(payload, "timeoutSeconds") || ""),
    deliveryMode:
      readString(delivery, "mode") === "announce" ? "announce" : "none",
    channelId: readString(delivery, "channel") || job.channelId || "last",
    to: readString(delivery, "to"),
    bestEffortDeliver: Boolean(delivery?.bestEffort),
  };
}

function buildSavePayload(form: CronFormState): Record<string, unknown> {
  const name = form.name.trim();
  if (!name) throw new Error("Name is required.");

  let schedule: Record<string, unknown>;
  if (form.scheduleKind === "cron") {
    const expr = form.cronExpr.trim();
    if (!expr) throw new Error("Cron expression is required.");
    schedule = { kind: "cron", expr };
    const tz = form.cronTz.trim();
    if (tz) schedule.tz = tz;
  } else if (form.scheduleKind === "every") {
    const everyMs = parseDurationMs(form.everyText);
    if (!everyMs) {
      throw new Error(
        "Every duration is invalid. Use values like 10m, 1h, or 1d."
      );
    }
    schedule = { kind: "every", everyMs };
  } else {
    const at = localDateTimeToIso(form.atLocal);
    if (!at) throw new Error("A valid date/time is required for at schedule.");
    schedule = { kind: "at", at };
  }

  let payload: Record<string, unknown>;
  if (form.sessionTarget === "isolated") {
    const message = form.agentMessage.trim();
    if (!message)
      throw new Error("Agent message is required for isolated jobs.");
    payload = { kind: "agentTurn", message };
    const thinking = form.thinking.trim();
    if (thinking) payload.thinking = thinking;
    const timeout = Number(form.timeoutSeconds);
    if (Number.isFinite(timeout) && timeout > 0)
      payload.timeoutSeconds = Math.floor(timeout);
  } else {
    const text = form.systemEventText.trim();
    if (!text) throw new Error("System event text is required.");
    payload = { kind: "systemEvent", text };
  }

  const root: Record<string, unknown> = {
    name,
    description: form.description.trim() || null,
    agentId: form.agentId.trim() || null,
    enabled: form.enabled,
    schedule,
    sessionTarget: form.sessionTarget,
    wakeMode: form.wakeMode,
    payload,
    deleteAfterRun: form.scheduleKind === "at" ? form.deleteAfterRun : false,
  };

  if (form.sessionTarget === "isolated") {
    const delivery: Record<string, unknown> = { mode: form.deliveryMode };
    if (form.deliveryMode === "announce") {
      delivery.channel = form.channelId.trim() || "last";
      const to = form.to.trim();
      if (to) delivery.to = to;
      if (form.bestEffortDeliver) delivery.bestEffort = true;
    }
    root.delivery = delivery;
  } else {
    root.delivery = null;
  }

  if (form.id) root.id = form.id;
  return root;
}

const useStyles = makeStyles({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    height: "100%",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "12px",
  },
  headerActions: { display: "flex", gap: "8px", alignItems: "center" },
  root: {
    display: "flex",
    flex: 1,
    minHeight: "420px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "10px",
    overflow: "hidden",
  },
  listPane: {
    width: "280px",
    minWidth: "260px",
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  listScroll: {
    overflowY: "auto",
    padding: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "6px",
  },
  listEmpty: {
    color: tokens.colorNeutralForeground3,
    fontStyle: "italic",
    padding: "12px",
  },
  jobRow: {
    width: "100%",
    justifyContent: "flex-start",
    textAlign: "left",
    padding: "8px 10px",
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: "6px",
  },
  jobRowSelected: {
    backgroundColor: tokens.colorBrandBackground2,
  },
  jobNameRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  chipRow: {
    display: "flex",
    gap: "6px",
    flexWrap: "wrap",
  },
  mono: {
    fontFamily: "Consolas, 'Courier New', monospace",
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  jobPrompt: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  detailPane: {
    flex: 1,
    overflowY: "auto",
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  detailEmpty: {
    color: tokens.colorNeutralForeground3,
    paddingTop: "6px",
  },
  detailHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "10px",
    flexWrap: "wrap",
  },
  detailActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  section: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "8px",
    padding: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    backgroundColor: tokens.colorNeutralBackground1,
  },
  kvRow: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  kvLabel: {
    width: "120px",
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    flexShrink: 0,
  },
  runRow: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  transcriptRow: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  transcriptRole: {
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  dialogField: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginBottom: "10px",
  },
  smallHelp: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase100,
  },
});

function runStatusColor(
  status?: string
): "danger" | "important" | "informative" | "subtle" | "success" | "warning" {
  const key = (status || "").toLowerCase();
  if (key === "ok" || key === "success") return "success";
  if (key === "error" || key === "failed") return "danger";
  if (key === "skipped") return "warning";
  return "subtle";
}

export function CronTab() {
  const styles = useStyles();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [status, setStatus] = useState<CronSchedulerStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<CronRunEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState<CronFormState>(() => createEmptyForm());
  const [error, setError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [transcriptRaw, setTranscriptRaw] = useState<string>("");

  const selectedIdRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const runsTimerRef = useRef<number | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedId) ?? null,
    [jobs, selectedId]
  );

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [jobList, chanList, cronStatus] = await Promise.all([
        invoke<CronJob[]>("get_cron_jobs"),
        invoke<ChannelInfo[]>("get_channels"),
        invoke<CronSchedulerStatus>("get_cron_status"),
      ]);
      setJobs(jobList);
      setChannels(chanList);
      setStatus(cronStatus);
      setSelectedId((previous) => {
        if (previous && jobList.some((job) => job.id === previous))
          return previous;
        return jobList[0]?.id ?? null;
      });
    } catch (e) {
      setJobs([]);
      setRuns([]);
      setStatus(null);
      setSelectedId(null);
      setError(formatError(e, "Failed to load cron jobs."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (jobId: string) => {
    setRunsLoading(true);
    try {
      const result = await invoke<CronRunEntry[]>("get_cron_runs", {
        payload: { id: jobId, limit: 200 },
      });
      setRuns(result);
    } catch (e) {
      setRuns([]);
      setError(formatError(e, "Failed to load cron run history."));
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const scheduleRefresh = useCallback(
    (delayMs = 250) => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void load();
      }, delayMs);
    },
    [load]
  );

  const scheduleRunsRefresh = useCallback(
    (jobId: string, delayMs = 200) => {
      if (runsTimerRef.current !== null) {
        window.clearTimeout(runsTimerRef.current);
      }
      runsTimerRef.current = window.setTimeout(() => {
        runsTimerRef.current = null;
        void loadRuns(jobId);
      }, delayMs);
    },
    [loadRuns]
  );

  const loadTranscript = useCallback(async (job: CronJob) => {
    setTranscriptLoading(true);
    setTranscriptError(null);
    try {
      const payload = await invoke<unknown>("get_cron_transcript", {
        payload: {
          id: job.id,
          sessionKey:
            (job.sessionKey && job.sessionKey.trim()) ||
            (job.sessionTarget === "isolated" ? `cron:${job.id}` : job.id),
          limit: 200,
        },
      });
      const lines = transcriptLinesFromPayload(payload);
      setTranscriptLines(lines);
      setTranscriptRaw(safeStringify(payload));
    } catch (e) {
      setTranscriptLines([]);
      setTranscriptRaw("");
      setTranscriptError(formatError(e, "Failed to load transcript."));
    } finally {
      setTranscriptLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    void loadRuns(selectedId);
  }, [selectedId, loadRuns]);

  useEffect(() => {
    const poll = window.setInterval(() => {
      void load();
    }, 30_000);
    let dispose: (() => void) | null = null;
    void listen<GatewayEventFrame>("gateway_event", ({ payload }) => {
      const eventName = payload?.event ?? "";
      const frameType = payload?.type ?? "";

      if (eventName === "cron") {
        scheduleRefresh(250);
        const selected = selectedIdRef.current;
        const jobId = payload?.payload?.jobId;
        const action = payload?.payload?.action ?? "";
        if (selected && jobId === selected && action === "finished") {
          scheduleRunsRefresh(selected, 200);
        }
        return;
      }

      if (frameType === "seqGap" || frameType === "seq_gap") {
        scheduleRefresh(250);
      }
    })
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => {});

    return () => {
      window.clearInterval(poll);
      dispose?.();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
      if (runsTimerRef.current !== null) {
        window.clearTimeout(runsTimerRef.current);
      }
    };
  }, [load, scheduleRefresh, scheduleRunsRefresh]);

  const saveJob = async () => {
    setEditorError(null);
    setSaving(true);
    try {
      const payload = buildSavePayload(form);
      await invoke("save_cron_job", { payload });
      setInfo(form.id ? "Cron job updated." : "Cron job created.");
      setEditOpen(false);
      setForm(createEmptyForm());
      await load();
      if (form.id) setSelectedId(form.id);
    } catch (e) {
      setEditorError(formatError(e, "Failed to save cron job."));
    } finally {
      setSaving(false);
    }
  };

  const deleteJob = async (id: string) => {
    setDeleteId(null);
    setError(null);
    try {
      await invoke("delete_cron_job", { id });
      setInfo("Cron job deleted.");
      await load();
    } catch (e) {
      setError(formatError(e, "Failed to delete cron job."));
    }
  };

  const toggleEnabled = async (job: CronJob, enabled: boolean) => {
    setError(null);
    try {
      await invoke("set_cron_job_enabled", {
        payload: { id: job.id, enabled },
      });
      setInfo(enabled ? "Job enabled." : "Job disabled.");
      await load();
    } catch (e) {
      setError(formatError(e, "Failed to update job state."));
    }
  };

  const runNow = async (job: CronJob) => {
    setError(null);
    try {
      await invoke("run_cron_job", { payload: { id: job.id, force: true } });
      setInfo("Run requested.");
      await load();
      if (selectedId === job.id) await loadRuns(job.id);
    } catch (e) {
      setError(formatError(e, "Failed to run cron job."));
    }
  };

  const onScheduleKindSelect = (
    _: SelectionEvents,
    data: OptionOnSelectData
  ) => {
    const next = (data.optionValue || "cron") as CronScheduleKind;
    setForm((previous) => ({ ...previous, scheduleKind: next }));
  };

  const onSessionTargetSelect = (
    _: SelectionEvents,
    data: OptionOnSelectData
  ) => {
    const next = (data.optionValue || "main") as CronSessionTarget;
    setForm((previous) => ({
      ...previous,
      sessionTarget: next,
      payloadKind: next === "isolated" ? "agentTurn" : previous.payloadKind,
    }));
  };
  const onWakeModeSelect = (_: SelectionEvents, data: OptionOnSelectData) => {
    const next = (data.optionValue || "now") as CronWakeMode;
    setForm((previous) => ({ ...previous, wakeMode: next }));
  };

  const onDeliveryModeSelect = (
    _: SelectionEvents,
    data: OptionOnSelectData
  ) => {
    const next = (data.optionValue || "announce") as CronDeliveryMode;
    setForm((previous) => ({ ...previous, deliveryMode: next }));
  };

  const onChannelSelect = (_: SelectionEvents, data: OptionOnSelectData) => {
    setForm((previous) => ({
      ...previous,
      channelId: data.optionValue || "last",
    }));
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <Text style={{ fontWeight: tokens.fontWeightSemibold }}>
            Cron Jobs
          </Text>
          <Text
            style={{
              display: "block",
              fontSize: tokens.fontSizeBase200,
              color: tokens.colorNeutralForeground3,
            }}
          >
            Manage gateway cron jobs, force runs, and inspect run history.
          </Text>
        </div>
        <div className={styles.headerActions}>
          <Button
            appearance="secondary"
            icon={loading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
            onClick={() => void load()}
            disabled={loading}
          >
            Refresh
          </Button>
          <Button
            appearance="primary"
            icon={<AddRegular />}
            onClick={() => {
              setForm(createEmptyForm());
              setEditorError(null);
              setEditOpen(true);
            }}
          >
            New Job
          </Button>
        </div>
      </div>

      {status?.enabled === false && (
        <MessageBar intent="warning">
          <MessageBarBody>
            Cron scheduler is disabled. Jobs are saved but will not run until
            `cron.enabled` is true and gateway restarts.
            {status.storePath ? ` Store: ${status.storePath}` : ""}
            {status.nextWakeAtMs
              ? ` Next wake: ${fmtTime(status.nextWakeAtMs)}`
              : ""}
          </MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {info && (
        <MessageBar intent="success">
          <MessageBarBody>{info}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.root}>
        <aside className={styles.listPane}>
          <div className={styles.listScroll}>
            {jobs.length === 0 && !loading ? (
              <Text className={styles.listEmpty}>No cron jobs configured.</Text>
            ) : (
              jobs.map((job) => (
                <Button
                  key={job.id}
                  appearance="transparent"
                  className={mergeClasses(
                    styles.jobRow,
                    selectedId === job.id ? styles.jobRowSelected : undefined
                  )}
                  onClick={() => setSelectedId(job.id)}
                >
                  <div className={styles.jobNameRow}>
                    <Text
                      style={{
                        fontWeight: tokens.fontWeightSemibold,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: 1,
                      }}
                    >
                      {job.name || "Untitled"}
                    </Text>
                    <Badge
                      color={job.enabled ? "success" : "subtle"}
                      appearance="filled"
                      size="small"
                    >
                      {job.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </div>
                  <Text className={styles.mono}>{job.schedule}</Text>
                  <Text className={styles.jobPrompt} title={job.prompt || ""}>
                    {job.prompt || "No payload text"}
                  </Text>
                  <div className={styles.chipRow}>
                    {job.sessionTarget ? (
                      <Badge appearance="outline" size="small" color="subtle">
                        {job.sessionTarget}
                      </Badge>
                    ) : null}
                    {job.wakeMode ? (
                      <Badge appearance="outline" size="small" color="subtle">
                        {job.wakeMode}
                      </Badge>
                    ) : null}
                    {job.agentId ? (
                      <Badge appearance="outline" size="small" color="subtle">
                        agent {job.agentId}
                      </Badge>
                    ) : null}
                    {job.lastStatus ? (
                      <Badge
                        appearance="outline"
                        size="small"
                        color={runStatusColor(job.lastStatus)}
                      >
                        {job.lastStatus}
                      </Badge>
                    ) : null}
                  </div>
                  <Text className={styles.mono}>
                    Next: {relativeDue(job.nextRun) || "-"}
                  </Text>
                </Button>
              ))
            )}
          </div>
        </aside>

        <main className={styles.detailPane}>
          {selectedJob ? (
            <>
              <div className={styles.detailHeader}>
                <div>
                  <Text
                    style={{
                      display: "block",
                      fontWeight: tokens.fontWeightSemibold,
                      fontSize: tokens.fontSizeBase400,
                    }}
                  >
                    {selectedJob.name || "Untitled"}
                  </Text>
                  <Text className={styles.mono}>{selectedJob.id}</Text>
                </div>
                <div className={styles.detailActions}>
                  <Switch
                    checked={selectedJob.enabled}
                    label="Enabled"
                    onChange={(_, data) =>
                      void toggleEnabled(selectedJob, Boolean(data.checked))
                    }
                  />
                  <Button
                    appearance="primary"
                    icon={<PlayRegular />}
                    onClick={() => void runNow(selectedJob)}
                  >
                    Run
                  </Button>
                  {selectedJob.sessionTarget === "isolated" && (
                    <Button
                      appearance="secondary"
                      onClick={() => {
                        setTranscriptOpen(true);
                        void loadTranscript(selectedJob);
                      }}
                    >
                      Transcript
                    </Button>
                  )}
                  <Button
                    appearance="secondary"
                    icon={<EditRegular />}
                    onClick={() => {
                      setForm(formFromJob(selectedJob));
                      setEditorError(null);
                      setEditOpen(true);
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    appearance="secondary"
                    icon={<DeleteRegular />}
                    onClick={() => setDeleteId(selectedJob.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>

              <div className={styles.section}>
                <Text style={{ fontWeight: tokens.fontWeightSemibold }}>
                  Details
                </Text>
                {selectedJob.description ? (
                  <div className={styles.kvRow}>
                    <Text className={styles.kvLabel}>Description</Text>
                    <Text>{selectedJob.description}</Text>
                  </div>
                ) : null}
                {selectedJob.agentId ? (
                  <div className={styles.kvRow}>
                    <Text className={styles.kvLabel}>Agent</Text>
                    <Text>{selectedJob.agentId}</Text>
                  </div>
                ) : null}
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Schedule</Text>
                  <Text>{selectedJob.schedule}</Text>
                </div>
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Session</Text>
                  <Text>{selectedJob.sessionTarget || "-"}</Text>
                </div>
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Wake</Text>
                  <Text>{selectedJob.wakeMode || "-"}</Text>
                </div>
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Delivery channel</Text>
                  <Text>{selectedJob.channelId || "-"}</Text>
                </div>
                {selectedJob.deleteAfterRun ? (
                  <div className={styles.kvRow}>
                    <Text className={styles.kvLabel}>Auto-delete</Text>
                    <Text>after successful run</Text>
                  </div>
                ) : null}
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Next run</Text>
                  <Text>
                    {fmtTime(selectedJob.nextRun)}
                    {selectedJob.nextRun
                      ? ` (${relativeDue(selectedJob.nextRun)})`
                      : ""}
                  </Text>
                </div>
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Last run</Text>
                  <Text>{fmtTime(selectedJob.lastRun)}</Text>
                </div>
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Last duration</Text>
                  <Text>
                    {selectedJob.lastDurationMs
                      ? `${selectedJob.lastDurationMs}ms`
                      : "-"}
                  </Text>
                </div>
                <div className={styles.kvRow}>
                  <Text className={styles.kvLabel}>Last status</Text>
                  <Text>{selectedJob.lastStatus || "-"}</Text>
                </div>
                {selectedJob.lastError && (
                  <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
                    {selectedJob.lastError}
                  </Text>
                )}
              </div>
              <div className={styles.section}>
                <Text style={{ fontWeight: tokens.fontWeightSemibold }}>
                  Payload
                </Text>
                <Text>{selectedJob.prompt || "No payload text"}</Text>
              </div>

              <div className={styles.section}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <Text style={{ fontWeight: tokens.fontWeightSemibold }}>
                    Run History
                  </Text>
                  <Button
                    appearance="secondary"
                    size="small"
                    icon={
                      runsLoading ? (
                        <Spinner size="tiny" />
                      ) : (
                        <ArrowClockwiseRegular />
                      )
                    }
                    onClick={() => void loadRuns(selectedJob.id)}
                    disabled={runsLoading}
                  >
                    Refresh
                  </Button>
                </div>

                {runs.length === 0 && !runsLoading ? (
                  <Text className={styles.smallHelp}>
                    No run log entries yet.
                  </Text>
                ) : (
                  runs.map((entry) => (
                    <div key={entry.id} className={styles.runRow}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        <Badge
                          color={runStatusColor(entry.status)}
                          appearance="filled"
                          size="small"
                        >
                          {entry.status || "unknown"}
                        </Badge>
                        {entry.action ? (
                          <Badge
                            color="subtle"
                            appearance="outline"
                            size="small"
                          >
                            {entry.action}
                          </Badge>
                        ) : null}
                        <Text className={styles.mono}>{fmtTime(entry.ts)}</Text>
                        {entry.durationMs ? (
                          <Text className={styles.mono}>
                            {entry.durationMs}ms
                          </Text>
                        ) : null}
                      </div>
                      {entry.runAtMs ? (
                        <Text className={styles.mono}>
                          Run at: {fmtTime(entry.runAtMs)}
                        </Text>
                      ) : null}
                      {entry.nextRunAtMs ? (
                        <Text className={styles.mono}>
                          Next: {fmtTime(entry.nextRunAtMs)}
                        </Text>
                      ) : null}
                      {entry.summary ? <Text>{entry.summary}</Text> : null}
                      {entry.error ? (
                        <Text
                          style={{ color: tokens.colorPaletteRedForeground1 }}
                        >
                          {entry.error}
                        </Text>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <Text className={styles.detailEmpty}>
              Select a cron job to inspect details and run history.
            </Text>
          )}
        </main>
      </div>

      <Dialog
        open={editOpen}
        onOpenChange={(_, data) => {
          setEditOpen(data.open);
          if (!data.open) setEditorError(null);
        }}
      >
        <DialogSurface
          style={{ backgroundColor: tokens.colorNeutralBackground2 }}
        >
          <DialogTitle>
            {form.id ? "Edit Cron Job" : "New Cron Job"}
          </DialogTitle>
          <DialogBody>
            <DialogContent>
              <div className={styles.dialogField}>
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(_, data) =>
                    setForm((f) => ({ ...f, name: data.value }))
                  }
                />
              </div>

              <div className={styles.dialogField}>
                <Label>Description</Label>
                <Input
                  value={form.description}
                  onChange={(_, data) =>
                    setForm((f) => ({ ...f, description: data.value }))
                  }
                />
              </div>

              <div className={styles.dialogField}>
                <Label>Agent ID</Label>
                <Input
                  value={form.agentId}
                  onChange={(_, data) =>
                    setForm((f) => ({ ...f, agentId: data.value }))
                  }
                />
              </div>

              <div className={styles.dialogField}>
                <Label>Session Target</Label>
                <Dropdown
                  selectedOptions={[form.sessionTarget]}
                  onOptionSelect={onSessionTargetSelect}
                  listbox={{
                    style: { backgroundColor: tokens.colorNeutralBackground2 },
                  }}
                >
                  <Option value="main">main</Option>
                  <Option value="isolated">isolated</Option>
                </Dropdown>
              </div>

              <div className={styles.dialogField}>
                <Label>Wake Mode</Label>
                <Dropdown
                  selectedOptions={[form.wakeMode]}
                  onOptionSelect={onWakeModeSelect}
                  listbox={{
                    style: { backgroundColor: tokens.colorNeutralBackground2 },
                  }}
                >
                  <Option value="now">now</Option>
                  <Option value="next-heartbeat">next-heartbeat</Option>
                </Dropdown>
              </div>

              <div className={styles.dialogField}>
                <Label>Schedule Kind</Label>
                <Dropdown
                  selectedOptions={[form.scheduleKind]}
                  onOptionSelect={onScheduleKindSelect}
                  listbox={{
                    style: { backgroundColor: tokens.colorNeutralBackground2 },
                  }}
                >
                  <Option value="cron">cron</Option>
                  <Option value="every">every</Option>
                  <Option value="at">at</Option>
                </Dropdown>
              </div>
              {form.scheduleKind === "cron" && (
                <>
                  <div className={styles.dialogField}>
                    <Label>Cron Expression</Label>
                    <Input
                      value={form.cronExpr}
                      onChange={(_, data) =>
                        setForm((f) => ({ ...f, cronExpr: data.value }))
                      }
                    />
                  </div>
                  <div className={styles.dialogField}>
                    <Label>Timezone (optional)</Label>
                    <Input
                      value={form.cronTz}
                      onChange={(_, data) =>
                        setForm((f) => ({ ...f, cronTz: data.value }))
                      }
                    />
                  </div>
                </>
              )}

              {form.scheduleKind === "every" && (
                <div className={styles.dialogField}>
                  <Label>Every</Label>
                  <Input
                    value={form.everyText}
                    onChange={(_, data) =>
                      setForm((f) => ({ ...f, everyText: data.value }))
                    }
                  />
                </div>
              )}

              {form.scheduleKind === "at" && (
                <>
                  <div className={styles.dialogField}>
                    <Label>At</Label>
                    <Input
                      type="datetime-local"
                      value={form.atLocal}
                      onChange={(_, data) =>
                        setForm((f) => ({ ...f, atLocal: data.value }))
                      }
                    />
                  </div>
                  <Switch
                    label="Delete after successful run"
                    checked={form.deleteAfterRun}
                    onChange={(_, data) =>
                      setForm((f) => ({
                        ...f,
                        deleteAfterRun: Boolean(data.checked),
                      }))
                    }
                  />
                </>
              )}

              {form.sessionTarget === "main" ? (
                <div className={styles.dialogField}>
                  <Label>System Event Text</Label>
                  <Textarea
                    rows={4}
                    value={form.systemEventText}
                    onChange={(_, data) =>
                      setForm((f) => ({ ...f, systemEventText: data.value }))
                    }
                  />
                </div>
              ) : (
                <>
                  <div className={styles.dialogField}>
                    <Label>Agent Message</Label>
                    <Textarea
                      rows={4}
                      value={form.agentMessage}
                      onChange={(_, data) =>
                        setForm((f) => ({ ...f, agentMessage: data.value }))
                      }
                    />
                  </div>
                  <div className={styles.dialogField}>
                    <Label>Thinking (optional)</Label>
                    <Input
                      value={form.thinking}
                      onChange={(_, data) =>
                        setForm((f) => ({ ...f, thinking: data.value }))
                      }
                    />
                  </div>
                  <div className={styles.dialogField}>
                    <Label>Timeout Seconds (optional)</Label>
                    <Input
                      value={form.timeoutSeconds}
                      onChange={(_, data) =>
                        setForm((f) => ({ ...f, timeoutSeconds: data.value }))
                      }
                    />
                  </div>

                  <div className={styles.dialogField}>
                    <Label>Delivery</Label>
                    <Dropdown
                      selectedOptions={[form.deliveryMode]}
                      onOptionSelect={onDeliveryModeSelect}
                      listbox={{
                        style: {
                          backgroundColor: tokens.colorNeutralBackground2,
                        },
                      }}
                    >
                      <Option value="announce">announce</Option>
                      <Option value="none">none</Option>
                    </Dropdown>
                  </div>

                  {form.deliveryMode === "announce" && (
                    <>
                      <div className={styles.dialogField}>
                        <Label>Channel</Label>
                        <Dropdown
                          selectedOptions={[form.channelId]}
                          onOptionSelect={onChannelSelect}
                          listbox={{
                            style: {
                              backgroundColor: tokens.colorNeutralBackground2,
                            },
                          }}
                        >
                          <Option value="last">last</Option>
                          {channels.map((channel) => (
                            <Option key={channel.id} value={channel.id}>
                              {channel.name}
                            </Option>
                          ))}
                        </Dropdown>
                      </div>

                      <div className={styles.dialogField}>
                        <Label>To (optional)</Label>
                        <Input
                          value={form.to}
                          onChange={(_, data) =>
                            setForm((f) => ({ ...f, to: data.value }))
                          }
                        />
                      </div>

                      <Switch
                        label="Best effort delivery"
                        checked={form.bestEffortDeliver}
                        onChange={(_, data) =>
                          setForm((f) => ({
                            ...f,
                            bestEffortDeliver: Boolean(data.checked),
                          }))
                        }
                      />
                    </>
                  )}
                </>
              )}

              <Switch
                label="Enabled"
                checked={form.enabled}
                onChange={(_, data) =>
                  setForm((f) => ({ ...f, enabled: Boolean(data.checked) }))
                }
              />

              {editorError && (
                <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {editorError}
                </Text>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setEditOpen(false)}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={() => void saveJob()}
                disabled={saving}
              >
                {saving ? <Spinner size="tiny" /> : "Save"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={deleteId !== null}
        onOpenChange={(_, data) => !data.open && setDeleteId(null)}
      >
        <DialogSurface
          style={{ backgroundColor: tokens.colorNeutralBackground2 }}
        >
          <DialogTitle>Delete cron job?</DialogTitle>
          <DialogBody>
            <DialogContent>This action cannot be undone.</DialogContent>
            <DialogActions>
              <Button onClick={() => setDeleteId(null)}>Cancel</Button>
              <Button
                appearance="primary"
                onClick={() => deleteId && void deleteJob(deleteId)}
              >
                Delete
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={transcriptOpen}
        onOpenChange={(_, data) => {
          setTranscriptOpen(data.open);
          if (!data.open) {
            setTranscriptError(null);
          }
        }}
      >
        <DialogSurface
          style={{ backgroundColor: tokens.colorNeutralBackground2 }}
        >
          <DialogTitle>Cron Transcript</DialogTitle>
          <DialogBody>
            <DialogContent>
              {transcriptError ? (
                <Text style={{ color: tokens.colorPaletteRedForeground1 }}>
                  {transcriptError}
                </Text>
              ) : null}
              {transcriptLoading ? (
                <Spinner label="Loading transcript..." />
              ) : transcriptLines.length === 0 ? (
                <Text className={styles.smallHelp}>
                  No transcript messages found for this cron session.
                </Text>
              ) : (
                <div style={{ maxHeight: "320px", overflowY: "auto" }}>
                  {transcriptLines.map((line) => (
                    <div key={line.id} className={styles.transcriptRow}>
                      <Text className={styles.transcriptRole}>{line.role}</Text>
                      <Text>{line.content}</Text>
                    </div>
                  ))}
                </div>
              )}
              {transcriptRaw && (
                <Textarea
                  readOnly
                  value={transcriptRaw}
                  rows={8}
                  style={{ marginTop: "10px" }}
                />
              )}
            </DialogContent>
            <DialogActions>
              <Button
                appearance="secondary"
                onClick={() => selectedJob && void loadTranscript(selectedJob)}
                disabled={transcriptLoading || !selectedJob}
              >
                Refresh
              </Button>
              <Button onClick={() => setTranscriptOpen(false)}>Close</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
}
