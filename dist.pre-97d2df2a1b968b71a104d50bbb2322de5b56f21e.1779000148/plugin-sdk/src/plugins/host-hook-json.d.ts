export type PluginJsonPrimitive = string | number | boolean | null;
export type PluginJsonValue = PluginJsonPrimitive | PluginJsonValue[] | {
    [key: string]: PluginJsonValue;
};
export type PluginJsonValueLimits = {
    maxDepth: number;
    maxNodes: number;
    maxObjectKeys: number;
    maxStringLength: number;
    maxSerializedBytes: number;
};
export declare const PLUGIN_JSON_VALUE_LIMITS: PluginJsonValueLimits;
export declare function isPluginJsonValue(value: unknown): value is PluginJsonValue;
