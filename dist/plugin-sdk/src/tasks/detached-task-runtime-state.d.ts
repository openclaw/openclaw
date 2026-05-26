import type { DetachedTaskLifecycleRuntime, DetachedTaskLifecycleRuntimeRegistration } from "./detached-task-runtime-contract.js";
export type { DetachedTaskLifecycleRuntime, DetachedTaskLifecycleRuntimeRegistration };
export declare function registerDetachedTaskLifecycleRuntime(pluginId: string, runtime: DetachedTaskLifecycleRuntime): void;
export declare function getDetachedTaskLifecycleRuntimeRegistration(): DetachedTaskLifecycleRuntimeRegistration | undefined;
export declare function getRegisteredDetachedTaskLifecycleRuntime(): DetachedTaskLifecycleRuntime | undefined;
export declare function restoreDetachedTaskLifecycleRuntimeRegistration(registration: DetachedTaskLifecycleRuntimeRegistration | undefined): void;
export declare function clearDetachedTaskLifecycleRuntimeRegistration(): void;
