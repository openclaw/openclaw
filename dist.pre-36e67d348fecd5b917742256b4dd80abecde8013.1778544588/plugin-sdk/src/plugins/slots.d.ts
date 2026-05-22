import type { OpenClawConfig } from "../config/types.js";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import type { PluginKind } from "./plugin-kind.types.js";
export type PluginSlotKey = keyof PluginSlotsConfig;
type SlotPluginRecord = {
    id: string;
    kind?: PluginKind | PluginKind[];
};
/** Normalize a kind field to an array for uniform iteration. */
export declare function normalizeKinds(kind?: PluginKind | PluginKind[]): PluginKind[];
/** Check whether a plugin's kind field includes a specific kind. */
export declare function hasKind(kind: PluginKind | PluginKind[] | undefined, target: PluginKind): boolean;
/** Order-insensitive equality check for two kind values (string or array). */
export declare function kindsEqual(a: PluginKind | PluginKind[] | undefined, b: PluginKind | PluginKind[] | undefined): boolean;
/** Return all slot keys that a plugin's kind field maps to. */
export declare function slotKeysForPluginKind(kind?: PluginKind | PluginKind[]): PluginSlotKey[];
export declare function defaultSlotIdForKey(slotKey: PluginSlotKey): string;
export type SlotSelectionResult = {
    config: OpenClawConfig;
    warnings: string[];
    changed: boolean;
};
export declare function applyExclusiveSlotSelection(params: {
    config: OpenClawConfig;
    selectedId: string;
    selectedKind?: PluginKind | PluginKind[];
    registry?: {
        plugins: SlotPluginRecord[];
    };
}): SlotSelectionResult;
export {};
