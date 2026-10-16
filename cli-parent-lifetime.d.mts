export const CLI_PARENT_BOUND_PRELOAD: string;
export function getCliParentPid(): number | undefined;
export function requestCliParentTermination(signal?: () => void): void;
export function watchCliRespawnParent(): void;
