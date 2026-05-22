import { spawn } from "node:child_process";
import type { Component, SelectItem } from "@mariozechner/pi-tui";
type LocalShellDeps = {
    chatLog: {
        addSystem: (line: string) => void;
    };
    tui: {
        requestRender: () => void;
    };
    openOverlay: (component: Component) => void;
    closeOverlay: () => void;
    createSelector?: (items: SelectItem[], maxVisible: number) => Component & {
        onSelect?: (item: SelectItem) => void;
        onCancel?: () => void;
    };
    spawnCommand?: typeof spawn;
    getCwd?: () => string;
    env?: NodeJS.ProcessEnv;
    maxOutputChars?: number;
};
export declare function createLocalShellRunner(deps: LocalShellDeps): {
    runLocalShellLine: (line: string) => Promise<void>;
};
export {};
