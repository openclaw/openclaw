import type { OpenClawConfig } from "../config/config.js";
import type { PluginSlotsConfig } from "../config/types.plugins.js";
import type { PluginKind } from "./types.js";
export type PluginSlotKey = keyof PluginSlotsConfig;
type SlotPluginRecord = {
    id: string;
    kind?: PluginKind;
};
export declare function slotKeyForPluginKind(kind?: PluginKind): PluginSlotKey | null;
export declare function defaultSlotIdForKey(slotKey: PluginSlotKey): string;
export type SlotSelectionResult = {
    config: OpenClawConfig;
    warnings: string[];
    changed: boolean;
};
export declare function applyExclusiveSlotSelection(params: {
    config: OpenClawConfig;
    selectedId: string;
    selectedKind?: PluginKind;
    registry?: {
        plugins: SlotPluginRecord[];
    };
}): SlotSelectionResult;
export {};
