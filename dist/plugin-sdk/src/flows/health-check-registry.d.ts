import type { HealthCheck } from "./health-checks.js";
export declare class HealthCheckRegistrationError extends Error {
    readonly checkId: string;
    readonly code = "OC_DOCTOR_DUPLICATE_CHECK";
    constructor(checkId: string);
}
export declare function registerHealthCheck(check: HealthCheck): void;
export declare function listHealthChecks(): readonly HealthCheck[];
export declare function getHealthCheck(id: string): HealthCheck | undefined;
export declare function clearHealthChecksForTest(): void;
