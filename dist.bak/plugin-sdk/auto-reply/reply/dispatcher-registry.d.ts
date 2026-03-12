/**
 * Global registry for tracking active reply dispatchers.
 * Used to ensure gateway restart waits for all replies to complete.
 */
/**
 * Register a reply dispatcher for global tracking.
 * Returns an unregister function to call when the dispatcher is no longer needed.
 */
export declare function registerDispatcher(dispatcher: {
    readonly pending: () => number;
    readonly waitForIdle: () => Promise<void>;
}): {
    id: string;
    unregister: () => void;
};
/**
 * Get the total number of pending replies across all dispatchers.
 */
export declare function getTotalPendingReplies(): number;
/**
 * Clear all registered dispatchers (for testing).
 * WARNING: Only use this in test cleanup!
 */
export declare function clearAllDispatchers(): void;
