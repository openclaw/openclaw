import type { OpenClawConfig } from "../config/types.js";
import type { ContextEngine } from "./types.js";
/**
 * Runtime context passed to context engine factories during resolution.
 * Provides config and path information so plugins can initialize engines
 * without fragile workarounds.
 */
export type ContextEngineFactoryContext = {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
};
/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 *
 * The factory receives a {@link ContextEngineFactoryContext} with runtime
 * environment context (config, paths). Existing no-arg factories remain
 * backward compatible because TypeScript permits assigning functions with
 * fewer parameters to wider signatures.
 */
export type ContextEngineFactory = (ctx: ContextEngineFactoryContext) => ContextEngine | Promise<ContextEngine>;
export type ContextEngineRegistrationResult = {
    ok: true;
} | {
    ok: false;
    existingOwner: string;
};
type RegisterContextEngineForOwnerOptions = {
    allowSameOwnerRefresh?: boolean;
};
/**
 * Register a context engine implementation under an explicit trusted owner.
 */
export declare function registerContextEngineForOwner(id: string, factory: ContextEngineFactory, owner: string, opts?: RegisterContextEngineForOwnerOptions): ContextEngineRegistrationResult;
/**
 * Public SDK entry point for third-party registrations.
 *
 * This path is intentionally unprivileged: it cannot claim core-owned ids and
 * it cannot safely refresh an existing registration because the caller's
 * identity is not authenticated.
 */
export declare function registerContextEngine(id: string, factory: ContextEngineFactory): ContextEngineRegistrationResult;
/**
 * Return the factory for a registered engine, or undefined.
 */
export declare function getContextEngineFactory(id: string): ContextEngineFactory | undefined;
/**
 * List all registered engine ids.
 */
export declare function listContextEngineIds(): string[];
export declare function clearContextEnginesForOwner(owner: string): void;
/**
 * Options for {@link resolveContextEngine}.
 */
export type ResolveContextEngineOptions = {
    agentDir?: string;
    workspaceDir?: string;
};
/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * When `config` is provided it is forwarded to the factory as part of a
 * {@link ContextEngineFactoryContext}. Additional runtime paths can be
 * supplied via `options`. Existing no-arg factories continue to work
 * because JavaScript permits extra arguments at call sites.
 *
 * Non-default engines that fail (unregistered, factory throw, or contract
 * violation) are logged and silently replaced by the default engine.
 * Throws only when the default engine itself cannot be resolved.
 */
export declare function resolveContextEngine(config?: OpenClawConfig, options?: ResolveContextEngineOptions): Promise<ContextEngine>;
export {};
