import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import type { RealtimeVoiceAgentConsultToolPolicy } from "openclaw/plugin-sdk/realtime-voice";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import type { VoiceCallRealtimeElevationConfig } from "../config.js";
import type { CallRecord } from "../types.js";

const PIN_MAX_DIGITS = 12;
const DTMF_ELEVATION_INTER_DIGIT_TIMEOUT_MS = 3_000;

export type DtmfElevationOutcome =
  | { kind: "elevated"; toolPolicy: RealtimeVoiceAgentConsultToolPolicy }
  | { kind: "rejected" | "locked-out"; attempt: number; maxAttempts: number };

/** Keypad PIN state for one telephony binding; closing it drops any elevation. */
export type DtmfElevationCall = {
  /** True between the prefix key and submission, while PIN digits are being entered. */
  readonly collecting: boolean;
  /** Elevated consult policy, once granted. */
  readonly toolPolicy: RealtimeVoiceAgentConsultToolPolicy | undefined;
  acceptDigit(digit: string): void;
  close(): void;
};

/**
 * Owns keypad PIN elevation for realtime calls. Failed attempts and lockouts are
 * in memory and keyed by the hashed caller number, so a Gateway restart clears them.
 * Failures count per caller across calls (within `lockoutMs`), so hanging up and
 * redialing does not reset the attempt budget.
 */
export class DtmfElevationGate {
  private readonly lockedUntilByCaller = new Map<string, number>();
  private readonly failuresByCaller = new Map<string, { count: number; firstAt: number }>();

  private recordFailure(callerKey: string, now: number): number {
    const existing = this.failuresByCaller.get(callerKey);
    const fresh = !existing || now - existing.firstAt >= this.params.config.lockoutMs;
    const next = fresh ? { count: 1, firstAt: now } : { ...existing, count: existing.count + 1 };
    this.failuresByCaller.set(callerKey, next);
    return next.count;
  }

  constructor(
    private readonly params: {
      pin: string;
      config: Pick<
        VoiceCallRealtimeElevationConfig,
        "prefix" | "elevatedToolPolicy" | "maxAttempts" | "lockoutMs"
      >;
      allowFrom: string[];
    },
  ) {}

  /** Undefined unless this is an inbound call from an allowlisted number. */
  openCall(
    call: Pick<CallRecord, "direction" | "from">,
    onOutcome: (outcome: DtmfElevationOutcome) => void,
  ): DtmfElevationCall | undefined {
    const caller = normalizePhoneNumber(call.from);
    if (call.direction !== "inbound" || !isAllowlistedCaller(caller, this.params.allowFrom)) {
      return undefined;
    }
    const { pin, config } = this.params;
    const callerKey = redactIdentifier(caller);
    // undefined while idle; a string while collecting digits after the prefix.
    let entered: string | undefined;
    let elevated: RealtimeVoiceAgentConsultToolPolicy | undefined;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stopCollecting = () => {
      clearTimeout(timer);
      timer = undefined;
      const value = entered;
      entered = undefined;
      return value;
    };
    const submit = () => {
      const value = stopCollecting() ?? "";
      const now = Date.now();
      const lockedUntil = this.lockedUntilByCaller.get(callerKey);
      const locked = lockedUntil !== undefined && lockedUntil > now;
      if (lockedUntil !== undefined && !locked) {
        this.lockedUntilByCaller.delete(callerKey);
      }
      // A locked-out caller never reaches the comparison, so retries during lockout reveal nothing.
      if (!locked && safeEqualSecret(value, pin)) {
        this.failuresByCaller.delete(callerKey);
        elevated = config.elevatedToolPolicy;
        onOutcome({ kind: "elevated", toolPolicy: elevated });
        return;
      }
      const attempts = locked ? config.maxAttempts : this.recordFailure(callerKey, now);
      if (attempts < config.maxAttempts) {
        onOutcome({ kind: "rejected", attempt: attempts, maxAttempts: config.maxAttempts });
        return;
      }
      closed = true;
      if (!locked) {
        this.lockedUntilByCaller.set(callerKey, now + config.lockoutMs);
        this.failuresByCaller.delete(callerKey);
      }
      onOutcome({ kind: "locked-out", attempt: attempts, maxAttempts: config.maxAttempts });
    };
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (entered) {
          submit();
        } else {
          // Prefix alone, then silence: return to idle without spending an attempt.
          stopCollecting();
        }
      }, DTMF_ELEVATION_INTER_DIGIT_TIMEOUT_MS);
      timer.unref?.();
    };

    return {
      get collecting() {
        return entered !== undefined;
      },
      get toolPolicy() {
        return elevated;
      },
      acceptDigit(digit) {
        if (closed || elevated) {
          return;
        }
        if (entered === undefined) {
          if (digit === config.prefix) {
            entered = "";
            armTimer();
          }
          return;
        }
        if (digit === "#") {
          submit();
          return;
        }
        if (digit === "*") {
          // Star restarts entry.
          entered = "";
          armTimer();
          return;
        }
        if (!/^[0-9]$/.test(digit)) {
          return;
        }
        entered += digit;
        // Submitting at the maximum, not the configured length, keeps the PIN length private.
        if (entered.length >= PIN_MAX_DIGITS) {
          submit();
          return;
        }
        armTimer();
      },
      close() {
        closed = true;
        stopCollecting();
      },
    };
  }
}

const ELEVATION_GRANTED_NOTICE =
  "Internal OpenClaw notice, not caller speech: the caller entered a valid keypad PIN. This call is now elevated until hangup. Briefly tell the caller the call is elevated.";
const ELEVATION_REJECTED_NOTICE =
  "Internal OpenClaw notice, not caller speech: the keypad PIN was not accepted. Briefly tell the caller the code was not accepted.";

/** Reports one call's keypad outcomes: logs without digits, tells the model, hangs up on lockout. */
export function createRealtimeElevationReporter(params: {
  callId: string;
  caller: string | undefined;
  isCurrent: () => boolean;
  sendNotice: (notice: string) => void;
  hangUp: () => Promise<{ success: boolean; error?: string }>;
}): (outcome: DtmfElevationOutcome) => void {
  const { callId } = params;
  return (outcome) => {
    if (!params.isCurrent()) {
      return;
    }
    if (outcome.kind === "elevated") {
      console.log(
        `[voice-call] Realtime keypad elevation granted callId=${callId} toolPolicy=${outcome.toolPolicy}`,
      );
      params.sendNotice(ELEVATION_GRANTED_NOTICE);
      return;
    }
    console.warn(
      `[voice-call] Realtime keypad elevation rejected callId=${callId} attempt=${outcome.attempt}/${outcome.maxAttempts}`,
    );
    if (outcome.kind === "rejected") {
      params.sendNotice(ELEVATION_REJECTED_NOTICE);
      return;
    }
    console.warn(
      `[voice-call] Realtime keypad elevation locked out caller=${redactIdentifier(params.caller)}; hanging up callId=${callId}`,
    );
    void params.hangUp().then(
      (result) => {
        if (!result.success) {
          console.warn(
            `[voice-call] Failed to hang up locked-out realtime call callId=${callId}: ${result.error ?? "unknown error"}`,
          );
        }
      },
      (error: unknown) => {
        console.warn(
          `[voice-call] Failed to hang up locked-out realtime call callId=${callId}: ${formatErrorMessage(error)}`,
        );
      },
    );
  };
}
