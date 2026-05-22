import type { PathSafetyCheck, PinnedSandboxDirectoryEntry, PinnedSandboxEntry } from "./fs-bridge-path-safety.js";
import type { SandboxFsCommandPlan } from "./fs-bridge-shell-command-plans.js";
export declare const SANDBOX_PINNED_MUTATION_PYTHON_CANDIDATES: readonly ["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/bin/python3"];
export declare const SANDBOX_PINNED_MUTATION_PYTHON: string;
export declare function buildPinnedWritePlan(params: {
    check: PathSafetyCheck;
    pinned: PinnedSandboxEntry;
    mkdir: boolean;
}): SandboxFsCommandPlan;
export declare function buildPinnedMkdirpPlan(params: {
    check: PathSafetyCheck;
    pinned: PinnedSandboxDirectoryEntry;
}): SandboxFsCommandPlan;
export declare function buildPinnedRemovePlan(params: {
    check: PathSafetyCheck;
    pinned: PinnedSandboxEntry;
    recursive?: boolean;
    force?: boolean;
}): SandboxFsCommandPlan;
export declare function buildPinnedRenamePlan(params: {
    fromCheck: PathSafetyCheck;
    toCheck: PathSafetyCheck;
    from: PinnedSandboxEntry;
    to: PinnedSandboxEntry;
}): SandboxFsCommandPlan;
