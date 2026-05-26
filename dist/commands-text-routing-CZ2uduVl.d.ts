import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as CommandDetection, s as CommandNormalizeOptions, t as ChatCommandDefinition, u as ShouldHandleTextCommandsParams } from "./commands-registry.types-B-WfTzT-.js";

//#region src/auto-reply/commands-registry-normalize.d.ts
declare function normalizeCommandBody(raw: string, options?: CommandNormalizeOptions): string;
declare function getCommandDetection(_cfg?: OpenClawConfig): CommandDetection;
declare function maybeResolveTextAlias(raw: string, cfg?: OpenClawConfig): string | null;
declare function resolveTextCommand(raw: string, cfg?: OpenClawConfig): {
  command: ChatCommandDefinition;
  args?: string;
} | null;
//#endregion
//#region src/auto-reply/commands-text-routing.d.ts
declare function isNativeCommandSurface(surface?: string): boolean;
declare function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean;
//#endregion
export { normalizeCommandBody as a, maybeResolveTextAlias as i, shouldHandleTextCommands as n, resolveTextCommand as o, getCommandDetection as r, isNativeCommandSurface as t };