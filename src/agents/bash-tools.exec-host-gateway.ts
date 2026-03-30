import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
	addAllowlistEntry,
	buildEnforcedShellCommand,
	type ExecAsk,
	type ExecSecurity,
	evaluateShellAllowlist,
	recordAllowlistUse,
	requiresExecApproval,
	resolveAllowAlwaysPatterns,
	resolveApprovalAuditCandidatePath,
} from "../infra/exec-approvals.js";
import {
	describeInterpreterInlineEval,
	detectInterpreterInlineEvalArgv,
} from "../infra/exec-inline-eval.js";
import { detectCommandObfuscation } from "../infra/exec-obfuscation-detect.js";
import type { SafeBinProfile } from "../infra/exec-safe-bin-policy.js";
import { logInfo } from "../logger.js";
import { markBackgrounded, tail } from "./bash-process-registry.js";
import {
	buildExecApprovalRequesterContext,
	buildExecApprovalTurnSourceContext,
	registerExecApprovalRequestForHostOrThrow,
} from "./bash-tools.exec-approval-request.js";
import {
	buildDefaultExecApprovalRequestArgs,
	buildExecApprovalFollowupTarget,
	buildExecApprovalPendingToolResult,
	createAndRegisterDefaultExecApprovalRequest,
	createExecApprovalDecisionState,
	resolveApprovalDecisionOrUndefined,
	resolveExecHostApprovalContext,
	sendExecApprovalFollowupResult,
} from "./bash-tools.exec-host-shared.js";
import {
	createApprovalSlug,
	DEFAULT_NOTIFY_TAIL_CHARS,
	normalizeNotifyOutput,
	runExecProcess,
} from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";

export type ProcessGatewayAllowlistParams = {
	command: string;
	workdir: string;
	env: Record<string, string>;
	requestedEnv?: Record<string, string>;
	pty: boolean;
	timeoutSec?: number;
	defaultTimeoutSec: number;
	security: ExecSecurity;
	ask: ExecAsk;
	safeBins: Set<string>;
	safeBinProfiles: Readonly<Record<string, SafeBinProfile>>;
	strictInlineEval?: boolean;
	agentId?: string;
	sessionKey?: string;
	turnSourceChannel?: string;
	turnSourceTo?: string;
	turnSourceAccountId?: string;
	turnSourceThreadId?: string | number;
	scopeKey?: string;
	warnings: string[];
	notifySessionKey?: string;
	approvalRunningNoticeMs: number;
	maxOutput: number;
	pendingMaxOutput: number;
	trustedSafeBinDirs?: ReadonlySet<string>;
};

export type ProcessGatewayAllowlistResult = {
	execCommandOverride?: string;
	pendingResult?: AgentToolResult<ExecToolDetails>;
};

export async function processGatewayAllowlist(
	params: ProcessGatewayAllowlistParams,
): Promise<ProcessGatewayAllowlistResult> {
	const { approvals, hostSecurity, hostAsk, askFallback } =
		resolveExecHostApprovalContext({
			agentId: params.agentId,
			security: params.security,
			ask: params.ask,
			host: "gateway",
		});
	const allowlistEval = evaluateShellAllowlist({
		command: params.command,
		allowlist: approvals.allowlist,
		safeBins: params.safeBins,
		safeBinProfiles: params.safeBinProfiles,
		cwd: params.workdir,
		env: params.env,
		platform: process.platform,
		trustedSafeBinDirs: params.trustedSafeBinDirs,
	});
	const allowlistMatches = allowlistEval.allowlistMatches;
	const analysisOk = allowlistEval.analysisOk;
	const allowlistSatisfied =
		hostSecurity === "allowlist" && analysisOk
			? allowlistEval.allowlistSatisfied
			: false;
	const inlineEvalHit =
		params.strictInlineEval === true
			? (allowlistEval.segments
					.map((segment) =>
						detectInterpreterInlineEvalArgv(
							segment.resolution?.effectiveArgv ?? segment.argv,
						),
					)
					.find((entry) => entry !== null) ?? null)
			: null;
	if (inlineEvalHit) {
		params.warnings.push(
			`Warning: strict inline-eval mode requires explicit approval for ${describeInterpreterInlineEval(
				inlineEvalHit,
			)}.`,
		);
	}
	let enforcedCommand: string | undefined;
	if (hostSecurity === "allowlist" && analysisOk && allowlistSatisfied) {
		const enforced = buildEnforcedShellCommand({
			command: params.command,
			segments: allowlistEval.segments,
			platform: process.platform,
		});
		if (!enforced.ok || !enforced.command) {
			throw new Error(
				`exec denied: allowlist execution plan unavailable (${enforced.reason})`,
			);
		}
		enforcedCommand = enforced.command;
	}
	const obfuscation = detectCommandObfuscation(params.command);
	if (obfuscation.detected) {
		logInfo(
			`exec: obfuscation detected (gateway): ${obfuscation.reasons.join(", ")}`,
		);
		params.warnings.push(
			`⚠️ Obfuscated command detected: ${obfuscation.reasons.join("; ")}`,
		);
	}
	const recordMatchedAllowlistUse = (resolvedPath?: string) => {
		if (allowlistMatches.length === 0) {
			return;
		}
		const seen = new Set<string>();
		for (const match of allowlistMatches) {
			if (seen.has(match.pattern)) {
				continue;
			}
			seen.add(match.pattern);
			recordAllowlistUse(
				approvals.file,
				params.agentId,
				match,
				params.command,
				resolvedPath,
			);
		}
	};
	const hasHeredocSegment = allowlistEval.segments.some((segment) =>
		segment.argv.some((token) => token.startsWith("<<")),
	);
	const requiresHeredocApproval =
		hostSecurity === "allowlist" &&
		analysisOk &&
		allowlistSatisfied &&
		hasHeredocSegment;
	const requiresInlineEvalApproval = inlineEvalHit !== null;
	const requiresAsk =
		requiresExecApproval({
			ask: hostAsk,
			security: hostSecurity,
			analysisOk,
			allowlistSatisfied,
		}) ||
		requiresHeredocApproval ||
		requiresInlineEvalApproval ||
		obfuscation.detected;
	if (requiresHeredocApproval) {
		params.warnings.push(
			"Warning: heredoc execution requires explicit approval in allowlist mode.",
		);
	}

	if (requiresAsk) {
		const requestArgs = buildDefaultExecApprovalRequestArgs({
			warnings: params.warnings,
			approvalRunningNoticeMs: params.approvalRunningNoticeMs,
			createApprovalSlug,
			turnSourceChannel: params.turnSourceChannel,
			turnSourceAccountId: params.turnSourceAccountId,
		});
		const registerGatewayApproval = async (approvalId: string) =>
			await registerExecApprovalRequestForHostOrThrow({
				approvalId,
				command: params.command,
				env: params.requestedEnv,
				workdir: params.workdir,
				host: "gateway",
				security: hostSecurity,
				ask: hostAsk,
				...buildExecApprovalRequesterContext({
					agentId: params.agentId,
					sessionKey: params.sessionKey,
				}),
				resolvedPath: resolveApprovalAuditCandidatePath(
					allowlistEval.segments[0]?.resolution ?? null,
					params.workdir,
				),
				...buildExecApprovalTurnSourceContext(params),
			});
		const {
			approvalId,
			approvalSlug,
			warningText,
			expiresAtMs,
			preResolvedDecision,
			initiatingSurface,
			sentApproverDms,
			unavailableReason,
		} = await createAndRegisterDefaultExecApprovalRequest({
			...requestArgs,
			register: registerGatewayApproval,
		});
		const resolvedPath = resolveApprovalAuditCandidatePath(
			allowlistEval.segments[0]?.resolution ?? null,
			params.workdir,
		);
		const effectiveTimeout =
			typeof params.timeoutSec === "number"
				? params.timeoutSec
				: params.defaultTimeoutSec;
		const followupTarget = buildExecApprovalFollowupTarget({
			approvalId,
			sessionKey: params.notifySessionKey,
			turnSourceChannel: params.turnSourceChannel,
			turnSourceTo: params.turnSourceTo,
			turnSourceAccountId: params.turnSourceAccountId,
			turnSourceThreadId: params.turnSourceThreadId,
		});

		void (async () => {
			const decision = await resolveApprovalDecisionOrUndefined({
				approvalId,
				preResolvedDecision,
				onFailure: () =>
					void sendExecApprovalFollowupResult(
						followupTarget,
						`Exec denied (gateway id=${approvalId}, approval-request-failed): ${params.command}`,
					),
			});
			if (decision === undefined) {
				return;
			}

			const {
				baseDecision,
				approvedByAsk: initialApprovedByAsk,
				deniedReason: initialDeniedReason,
			} = createExecApprovalDecisionState({
				decision,
				askFallback,
				obfuscationDetected: obfuscation.detected,
			});
			let approvedByAsk = initialApprovedByAsk;
			let deniedReason = initialDeniedReason;

			if (baseDecision.timedOut && askFallback === "allowlist") {
				if (!analysisOk || !allowlistSatisfied) {
					deniedReason = "approval-timeout (allowlist-miss)";
				} else {
					approvedByAsk = true;
				}
			} else if (decision === "allow-once") {
				approvedByAsk = true;
			} else if (decision === "allow-always") {
				approvedByAsk = true;
				if (hostSecurity === "allowlist" && !requiresInlineEvalApproval) {
					const patterns = resolveAllowAlwaysPatterns({
						segments: allowlistEval.segments,
						cwd: params.workdir,
						env: params.env,
						platform: process.platform,
					});
					for (const pattern of patterns) {
						if (pattern) {
							addAllowlistEntry(approvals.file, params.agentId, pattern);
						}
					}
				}
			}

			if (
				hostSecurity === "allowlist" &&
				(!analysisOk || !allowlistSatisfied) &&
				!approvedByAsk
			) {
				deniedReason = deniedReason ?? "allowlist-miss";
			}

			if (deniedReason) {
				await sendExecApprovalFollowupResult(
					followupTarget,
					`Exec denied (gateway id=${approvalId}, ${deniedReason}): ${params.command}`,
				);
				return;
			}

			recordMatchedAllowlistUse(resolvedPath ?? undefined);

			let run: Awaited<ReturnType<typeof runExecProcess>> | null = null;
			try {
				run = await runExecProcess({
					command: params.command,
					execCommand: enforcedCommand,
					workdir: params.workdir,
					env: params.env,
					sandbox: undefined,
					containerWorkdir: null,
					usePty: params.pty,
					warnings: params.warnings,
					maxOutput: params.maxOutput,
					pendingMaxOutput: params.pendingMaxOutput,
					notifyOnExit: false,
					notifyOnExitEmptySuccess: false,
					scopeKey: params.scopeKey,
					sessionKey: params.notifySessionKey,
					timeoutSec: effectiveTimeout,
				});
			} catch {
				await sendExecApprovalFollowupResult(
					followupTarget,
					`Exec denied (gateway id=${approvalId}, spawn-failed): ${params.command}`,
				);
				return;
			}

			markBackgrounded(run.session);

			const outcome = await run.promise;
			const output = normalizeNotifyOutput(
				tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
			);
			const exitLabel = outcome.timedOut
				? "timeout"
				: `code ${outcome.exitCode ?? "?"}`;
			const summary = output
				? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
				: `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
			await sendExecApprovalFollowupResult(followupTarget, summary);
		})();

		return {
			pendingResult: buildExecApprovalPendingToolResult({
				host: "gateway",
				command: params.command,
				cwd: params.workdir,
				warningText,
				approvalId,
				approvalSlug,
				expiresAtMs,
				initiatingSurface,
				sentApproverDms,
				unavailableReason,
			}),
		};
	}

	if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied)) {
		throw new Error("exec denied: allowlist miss");
	}

	recordMatchedAllowlistUse(
		resolveApprovalAuditCandidatePath(
			allowlistEval.segments[0]?.resolution ?? null,
			params.workdir,
		),
	);

	return { execCommandOverride: enforcedCommand };
}
