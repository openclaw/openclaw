import type { OpenClawPluginApi } from "./types.js";
type FunctionPropertyNames<T> = Extract<{
    [K in keyof T]-?: Exclude<T[K], undefined> extends (...args: unknown[]) => unknown ? K : never;
}[keyof T], string>;
export type PluginApiMethodName = FunctionPropertyNames<OpenClawPluginApi>;
export type PluginApiLifecyclePolicy = {
    phase: "registration" | "runtime";
    lateCallable: boolean;
};
export declare function getPluginApiMethodLifecyclePolicy(methodName: string): PluginApiLifecyclePolicy | undefined;
export declare function isLateCallablePluginApiMethod(methodName: string): methodName is PluginApiMethodName;
export {};
