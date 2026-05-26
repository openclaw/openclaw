import { type SystemdUnavailableKind } from "./systemd-unavailable.js";
type SystemdUnavailableHintOptions = {
    wsl?: boolean;
    kind?: SystemdUnavailableKind | null;
    container?: boolean;
};
export declare function isSystemdUnavailableDetail(detail?: string): boolean;
export declare function renderSystemdUnavailableHints(options?: SystemdUnavailableHintOptions): string[];
export {};
