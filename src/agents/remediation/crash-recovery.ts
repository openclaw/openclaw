/**
 * Automated crash recovery for subagent processes.
 * Attempts a single graceful restart if a subagent process exits unexpectedly.
 */
export class SubagentRecoveryManager {
    private restartAttempts = new Map<string, number>();

    shouldRestart(agentId: string, exitCode: number): boolean {
        if (exitCode === 0) return false;
        
        const attempts = this.restartAttempts.get(agentId) || 0;
        if (attempts < 1) { // Only attempt one automatic restart
            console.warn(`[remediation] Subagent ${agentId} crashed (code ${exitCode}). Attempting automated recovery...`);
            this.restartAttempts.set(agentId, attempts + 1);
            return true;
        }
        
        console.error(`[remediation] Subagent ${agentId} failed repeatedly. Manual intervention required.`);
        return false;
    }
}
