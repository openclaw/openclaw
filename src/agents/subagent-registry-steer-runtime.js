let replaceSubagentRunAfterSteerImpl = null;
let finalizeInterruptedSubagentRunImpl = null;
export function configureSubagentRegistrySteerRuntime(params) {
    replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
    finalizeInterruptedSubagentRunImpl = params.finalizeInterruptedSubagentRun ?? null;
}
export function replaceSubagentRunAfterSteer(params) {
    return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}
export async function finalizeInterruptedSubagentRun(params) {
    return (await finalizeInterruptedSubagentRunImpl?.(params)) ?? 0;
}
