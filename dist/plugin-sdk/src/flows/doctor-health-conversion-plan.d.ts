export type DoctorHealthConversionKind = "already-detect" | "detect-only" | "repair-backed-detect" | "split-detect-repair" | "runtime-fact" | "terminal-side-effect" | "interactive-maintenance";
export interface DoctorHealthConversionRule {
    readonly contributionId: string;
    readonly conversion: DoctorHealthConversionKind;
    readonly target: readonly string[];
    readonly rule: string;
}
export declare const doctorHealthConversionRules: readonly [{
    readonly contributionId: "doctor:gateway-config";
    readonly conversion: "already-detect";
    readonly target: readonly ["core/doctor/gateway-config"];
    readonly rule: "Keep as a pure config finding; doctor presentation should render the finding instead of calling note().";
}, {
    readonly contributionId: "doctor:auth-profiles";
    readonly conversion: "split-detect-repair";
    readonly target: readonly ["core/doctor/auth-profiles/flat-store", "core/doctor/auth-profiles/oauth-sidecar", "core/doctor/auth-profiles/oauth-ids", "core/doctor/auth-profiles/keychain", "core/doctor/auth-profiles/codex-provider"];
    readonly rule: "Split each legacy profile repair and keychain prompt into scoped findings; repairs update config only through repair().";
}, {
    readonly contributionId: "doctor:claude-cli";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/claude-cli"];
    readonly rule: "Return CLI readiness findings with install/config hints; no config mutation.";
}, {
    readonly contributionId: "doctor:gateway-auth";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/gateway-auth"];
    readonly rule: "Detect missing or externally unresolved Gateway auth; repair may generate token only when repair context explicitly allows it.";
}, {
    readonly contributionId: "doctor:command-owner";
    readonly conversion: "already-detect";
    readonly target: readonly ["core/doctor/command-owner"];
    readonly rule: "Keep as config-only owner finding.";
}, {
    readonly contributionId: "doctor:structured-health-repairs";
    readonly conversion: "terminal-side-effect";
    readonly target: readonly ["doctor-health-repair-runner"];
    readonly rule: "Delete this bridge after converted checks are registered directly; repair orchestration belongs outside the contribution list.";
}, {
    readonly contributionId: "doctor:legacy-state";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/legacy-state"];
    readonly rule: "Detect migration preview as findings; repair runs selected migrations and reports changes/warnings.";
}, {
    readonly contributionId: "doctor:legacy-plugin-manifests";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/legacy-plugin-manifests"];
    readonly rule: "Expose manifest contract drift as findings; repair delegates to manifest contract repair.";
}, {
    readonly contributionId: "doctor:release-configured-plugin-installs";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/configured-plugin-installs"];
    readonly rule: "Detect configured plugins needing release repair; repair may touch meta.lastTouchedVersion and config entries.";
}, {
    readonly contributionId: "doctor:plugin-registry";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/plugin-registry"];
    readonly rule: "Detect stale plugin registry state and let repair return the next config.";
}, {
    readonly contributionId: "doctor:state-integrity";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/state-integrity"];
    readonly rule: "Convert orphan/legacy state notes to path-scoped findings; repair archives only selected findings.";
}, {
    readonly contributionId: "doctor:codex-session-routes";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/codex-session-routes"];
    readonly rule: "Detect stale Codex route pins; repair updates affected session/config route records.";
}, {
    readonly contributionId: "doctor:session-locks";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/session-locks"];
    readonly rule: "Detect stale session locks; repair removes only the locks represented by findings.";
}, {
    readonly contributionId: "doctor:session-transcripts";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/session-transcripts"];
    readonly rule: "Detect transcript integrity issues; repair applies scoped transcript cleanup.";
}, {
    readonly contributionId: "doctor:session-snapshots";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["doctor-run/session-snapshots"];
    readonly rule: "Keep this on the legacy doctor run path until the session snapshot scanner has a structured detector; do not register a clean core lint target before then.";
}, {
    readonly contributionId: "doctor:config-audit-scrub";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/config-audit-scrub"];
    readonly rule: "Detect scrub-needed audit entries; repair rewrites only matching audit records.";
}, {
    readonly contributionId: "doctor:legacy-cron";
    readonly conversion: "split-detect-repair";
    readonly target: readonly ["core/doctor/legacy-cron-store", "core/doctor/legacy-whatsapp-crontab"];
    readonly rule: "Split crontab warning from cron store migration; repair only mutates cron store findings.";
}, {
    readonly contributionId: "doctor:sandbox";
    readonly conversion: "split-detect-repair";
    readonly target: readonly ["core/doctor/sandbox/registry-files", "core/doctor/sandbox/images", "core/doctor/sandbox-scope"];
    readonly rule: "Separate registry/image repairs from read-only sandbox scope warnings.";
}, {
    readonly contributionId: "doctor:gateway-services";
    readonly conversion: "split-detect-repair";
    readonly target: readonly ["core/doctor/gateway-services/extra", "core/doctor/gateway-services/config", "core/doctor/gateway-services/platform-notes"];
    readonly rule: "Model scans as findings; repair service config only when repair policy permits.";
}, {
    readonly contributionId: "doctor:startup-channel-maintenance";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/startup-channel-maintenance"];
    readonly rule: "Detect startup channel maintenance work and run repair through the existing maintenance helper.";
}, {
    readonly contributionId: "doctor:security";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/security"];
    readonly rule: "Return security posture warnings as findings with fix hints.";
}, {
    readonly contributionId: "doctor:browser";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/browser"];
    readonly rule: "Return Chrome/MCP readiness findings without launching or repairing browser state.";
}, {
    readonly contributionId: "doctor:oauth-tls";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/oauth-tls"];
    readonly rule: "Expose OAuth TLS prerequisites as findings; preserve deep-mode detail as finding metadata.";
}, {
    readonly contributionId: "doctor:hooks-model";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/hooks-model"];
    readonly rule: "Detect allowlist/catalog issues for hooks.gmail.model as config findings.";
}, {
    readonly contributionId: "doctor:systemd-linger";
    readonly conversion: "interactive-maintenance";
    readonly target: readonly ["core/doctor/systemd-linger"];
    readonly rule: "Detect missing linger as a Linux-only finding; interactive enablement remains a repair prompt.";
}, {
    readonly contributionId: "doctor:workspace-status";
    readonly conversion: "already-detect";
    readonly target: readonly ["core/doctor/workspace-status"];
    readonly rule: "Keep legacy workspace directory detection as a pure finding.";
}, {
    readonly contributionId: "doctor:skills";
    readonly conversion: "already-detect";
    readonly target: readonly ["core/doctor/skills-readiness"];
    readonly rule: "Keep unavailable skill detection/disable repair in the health registry.";
}, {
    readonly contributionId: "doctor:bootstrap-size";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/bootstrap-size"];
    readonly rule: "Return oversized bootstrap files as path findings.";
}, {
    readonly contributionId: "doctor:shell-completion";
    readonly conversion: "interactive-maintenance";
    readonly target: readonly ["core/doctor/shell-completion"];
    readonly rule: "Detect stale/missing completion setup; repair can delegate to completion installer when interactive.";
}, {
    readonly contributionId: "doctor:gateway-health";
    readonly conversion: "runtime-fact";
    readonly target: readonly ["doctor-runtime/gateway-status", "doctor-runtime/gateway-memory-probe"];
    readonly rule: "Prepare shared Gateway status/memory facts before checks; dependent checks must consume facts instead of probing again.";
}, {
    readonly contributionId: "doctor:whatsapp-responsiveness";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/whatsapp-responsiveness"];
    readonly rule: "Detect WhatsApp degraded responsiveness from prepared Gateway status.";
}, {
    readonly contributionId: "doctor:memory-search";
    readonly conversion: "split-detect-repair";
    readonly target: readonly ["core/doctor/memory-search", "core/doctor/memory-recall", "core/doctor/memory-gateway-probe"];
    readonly rule: "Use prepared memory probe facts; keep recall repair separate from read-only search findings.";
}, {
    readonly contributionId: "doctor:device-pairing";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/device-pairing"];
    readonly rule: "Report pairing readiness from prepared Gateway health facts.";
}, {
    readonly contributionId: "doctor:gateway-daemon";
    readonly conversion: "repair-backed-detect";
    readonly target: readonly ["core/doctor/gateway-daemon"];
    readonly rule: "Detect daemon drift from Gateway facts; repair delegates to daemon flow with scoped findings.";
}, {
    readonly contributionId: "doctor:write-config";
    readonly conversion: "terminal-side-effect";
    readonly target: readonly ["doctor-config-persistence"];
    readonly rule: "Keep config persistence as the final write step after repairs; it is not a health check.";
}, {
    readonly contributionId: "doctor:workspace-suggestions";
    readonly conversion: "detect-only";
    readonly target: readonly ["core/doctor/workspace-suggestions"];
    readonly rule: "Return workspace backup/memory-system suggestions as info findings when suggestions are enabled.";
}, {
    readonly contributionId: "doctor:final-config-validation";
    readonly conversion: "already-detect";
    readonly target: readonly ["core/doctor/final-config-validation"];
    readonly rule: "Keep final schema validation as a registered core check.";
}];
