import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";
type ServiceEnvCommand = {
    environment?: Record<string, string | undefined>;
    environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
} | null;
export declare function hasInlineEnvironmentSource(source: GatewayServiceEnvironmentValueSource | undefined): boolean;
export declare function isEnvironmentFileOnlySource(source: GatewayServiceEnvironmentValueSource | undefined): boolean;
export declare function hasEnvironmentFileSource(source: GatewayServiceEnvironmentValueSource | undefined): boolean;
export declare function formatManagedServiceEnvKeys(managedEnvironment: Record<string, string | undefined>, options?: {
    omitKeys?: Iterable<string>;
}): string | undefined;
export declare function readManagedServiceEnvKeysFromEnvironment(environment: Record<string, string | undefined> | undefined): Set<string>;
export declare function writeManagedServiceEnvKeysToEnvironment(environment: Record<string, string | undefined>, value: string | undefined): void;
export declare function collectInlineManagedServiceEnvKeys(command: ServiceEnvCommand, expectedManagedKeys?: Iterable<string>): string[];
export {};
