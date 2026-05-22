import { t as formatCliCommand } from "./command-format-BPjMauol.js";
//#region src/cli/config-recovery-hints.ts
function formatInvalidConfigRecoveryHint() {
	return [`Run "${formatCliCommand("openclaw doctor --fix")}" to repair, then retry.`, "If startup is still blocked, inspect the adjacent .bak backup before restoring it manually."].join("\n");
}
//#endregion
export { formatInvalidConfigRecoveryHint as t };
