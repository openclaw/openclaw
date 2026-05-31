//#region src/runtime/types.d.ts
type AcpRuntimePromptMode = "prompt" | "steer";
type AcpRuntimeSessionMode = "persistent" | "oneshot";
type AcpSessionUpdateTag = "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "usage_update" | "available_commands_update" | "current_mode_update" | "config_option_update" | "session_info_update" | "plan" | (string & {});
type AcpRuntimeControl = "session/set_mode" | "session/set_config_option" | "session/status";
type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string; /** Effective runtime working directory for this ACP session, if exposed by adapter/runtime. */
  cwd?: string; /** Backend-local record identifier, if exposed by adapter/runtime (for example acpx record id). */
  acpxRecordId?: string; /** Backend-level ACP session identifier, if exposed by adapter/runtime. */
  backendSessionId?: string; /** Upstream harness session identifier, if exposed by adapter/runtime. */
  agentSessionId?: string;
};
type AcpRuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string; /** Optional runtime model override that must be available during session creation. */
  model?: string; /** Optional runtime thinking/reasoning override that must be available during session creation. */
  thinking?: string;
  cwd?: string;
  env?: Record<string, string>;
};
type AcpRuntimeTurnAttachment = {
  mediaType: string;
  data: string;
};
type AcpRuntimeTurnInput = {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
};
type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  /**
   * Optional backend-advertised option keys for session/set_config_option.
   * Empty/undefined means "backend accepts keys, but did not advertise a strict list".
   */
  configOptionKeys?: string[];
};
type AcpRuntimeStatus = {
  summary?: string; /** Backend-local record identifier, if exposed by adapter/runtime. */
  acpxRecordId?: string; /** Backend-level ACP session identifier, if known at status time. */
  backendSessionId?: string; /** Upstream harness session identifier, if known at status time. */
  agentSessionId?: string;
  details?: Record<string, unknown>;
};
type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};
type AcpRuntimeEvent = {
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
  tag?: AcpSessionUpdateTag;
} | {
  type: "status";
  text: string;
  tag?: AcpSessionUpdateTag;
  used?: number;
  size?: number;
} | {
  type: "tool_call";
  text: string;
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  status?: string;
  title?: string;
} | {
  type: "done";
  stopReason?: string;
} | {
  type: "error";
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};
type AcpRuntimeTurnResultError = {
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};
type AcpRuntimeTurnResult = {
  status: "completed";
  stopReason?: string;
} | {
  status: "cancelled";
  stopReason?: string;
} | {
  status: "failed";
  error: AcpRuntimeTurnResultError;
};
interface AcpRuntimeTurn {
  readonly requestId: string;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: {
    reason?: string;
  }): Promise<void>;
  closeStream(input?: {
    reason?: string;
  }): Promise<void>;
}
interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  /**
   * Preferred turn API. Live events are streamed separately from the terminal
   * result so adapters can report failures without relying on legacy done/error
   * events in the stream.
   */
  startTurn?(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus>;
  setMode?(input: {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setConfigOption?(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  /**
   * Prepare the next ensureSession for this session key to start fresh instead
   * of reopening backend-owned persistent state.
   */
  prepareFreshSession?(input: {
    sessionKey: string;
  }): Promise<void>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
  }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    /**
     * Discard backend-owned persistent session state so the next ensureSession
     * starts fresh instead of reopening the same conversation.
     */
    discardPersistentState?: boolean;
  }): Promise<void>;
}
//#endregion
export { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeControl, AcpRuntimeDoctorReport, AcpRuntimeEnsureInput, AcpRuntimeEvent, AcpRuntimeHandle, AcpRuntimePromptMode, AcpRuntimeSessionMode, AcpRuntimeStatus, AcpRuntimeTurn, AcpRuntimeTurnAttachment, AcpRuntimeTurnInput, AcpRuntimeTurnResult, AcpRuntimeTurnResultError, AcpSessionUpdateTag };