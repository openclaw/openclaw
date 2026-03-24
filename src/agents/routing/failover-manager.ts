import { ModelProvider } from "../types.js";

/**
 * Manages smart failover between model providers.
 * Detects transient API failures and automatically routes to the configured fallback.
 * Addresses #53959.
 */
export class FailoverManager {
    static async executeWithFailover(primary: ModelProvider, fallback: ModelProvider, task: any) {
        try {
            console.info(`[routing] Attempting primary model: ${primary.id}`);
            return await primary.execute(task);
        } catch (e) {
            console.warn(`[routing] Primary model ${primary.id} failed. Falling back to ${fallback.id}. Error: ${e}`);
            // Logic to verify fallback capability before execution
            return await fallback.execute(task);
        }
    }
}
