import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../../auto-reply/reply/session-event-handoff.js";
import { invokeNodeClaudeCliRun } from "../../gateway/node-agent-cli-runtime.js";
import { getProcessSupervisor as getProcessSupervisorImpl } from "../../process/supervisor/index.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import { defaultCliWatchdogClock } from "./execute-plugin-watchdog.js";
import { writeCliSystemPromptFile } from "./helpers.js";

export const executeDeps = {
  watchdogClock: defaultCliWatchdogClock,
  getProcessSupervisor: getProcessSupervisorImpl,
  captureSessionEventTarget: captureSessionEventTargetForHost,
  enqueueSessionEvent: enqueueSessionEventForHost,
  writeCliSystemPromptFile,
  invokeNodeClaudeCliRun,
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
};

export type CliExecuteDeps = typeof executeDeps;
