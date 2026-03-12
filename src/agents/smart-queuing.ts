import path from "node:path";
// import { fileLocker } from "../infra/json-files.js"; // Commenting out unused import

// Types for the smart queuing system
export type QueuePriority = "high" | "normal" | "low";
export type OperationStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface QueueItem<T = unknown> {
  id: string;
  operation: () => Promise<T>;
  priority: QueuePriority;
  dependencies?: string[]; // IDs of operations this one depends on
  resources?: string[]; // File resources this operation accesses
  createdAt: number;
  timeout?: number; // Timeout in milliseconds
  maxRetries?: number;
  currentRetries?: number;
}

export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  total: number;
}

/**
 * SmartQueue implements intelligent queuing that analyzes file dependencies
 * and schedules non-conflicting operations in parallel while queuing conflicting ones.
 */
class SmartQueue {
  private static instance: SmartQueue;

  private queue: Map<string, QueueItem> = new Map();
  private runningOperations: Set<string> = new Set();
  private completedOperations: Map<string, unknown> = new Map(); // Changed from 'any' to 'unknown'
  private failedOperations: Map<string, Error> = new Map();
  private cancelledOperations: Set<string> = new Set();

  // Tracks which files are currently being accessed
  private fileAccessTracker: Map<string, Set<string>> = new Map(); // file -> operations accessing it

  // Priority-based execution order
  private priorityOrder: QueuePriority[] = ["high", "normal", "low"];

  private constructor() {
    // Process the queue periodically
    this.startProcessing();
  }

  public static getInstance(): SmartQueue {
    if (!SmartQueue.instance) {
      SmartQueue.instance = new SmartQueue();
    }
    return SmartQueue.instance;
  }

  /**
   * Adds an operation to the queue
   * @param item The queue item to add
   * @returns Promise that resolves when the operation completes
   */
  async enqueue<T>(item: Omit<QueueItem<T>, "id" | "createdAt">): Promise<T> {
    const id = item.operation.name || `op-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const queueItem: QueueItem<T> = {
      ...item,
      id,
      createdAt: Date.now(),
      currentRetries: 0,
    };

    this.queue.set(id, queueItem as QueueItem);

    return new Promise<T>((resolve, reject) => {
      // Poll for completion status
      const checkCompletion = () => {
        if (this.completedOperations.has(id)) {
          resolve(this.completedOperations.get(id) as T);
        } else if (this.failedOperations.has(id)) {
          reject(this.failedOperations.get(id));
        } else if (this.cancelledOperations.has(id)) {
          reject(new Error(`Operation ${id} was cancelled`));
        } else {
          setTimeout(checkCompletion, 100); // Check again in 100ms
        }
      };
      checkCompletion();
    });
  }

  /**
   * Starts processing the queue
   */
  private startProcessing(): void {
    setInterval(() => {
      void this.processQueue(); // Marking the promise as ignored with void
    }, 50); // Process queue every 50ms
  }

  /**
   * Processes items in the queue based on dependencies and resource conflicts
   */
  private async processQueue(): Promise<void> {
    // Get all pending operations
    const pendingOps = Array.from(this.queue.entries())
      .filter(
        ([_, item]) =>
          !this.runningOperations.has(item.id) &&
          !this.completedOperations.has(item.id) &&
          !this.failedOperations.has(item.id) &&
          !this.cancelledOperations.has(item.id) &&
          this.areDependenciesMet(item),
      )
      .map(([_, item]) => item);

    // Sort by priority
    pendingOps.sort((a, b) => {
      const aPriority = this.priorityOrder.indexOf(a.priority);
      const bPriority = this.priorityOrder.indexOf(b.priority);
      return aPriority - bPriority;
    });

    // Try to run operations that don't conflict on resources
    for (const item of pendingOps) {
      if (this.runningOperations.size >= this.getMaxConcurrent()) {
        break; // Reached max concurrent limit
      }

      if (await this.canExecuteWithoutConflicts(item)) {
        void this.runOperation(item); // Marking the promise as ignored with void
      }
    }
  }

  /**
   * Checks if all dependencies for an operation are met
   * @param item The operation to check
   * @returns True if all dependencies are met, false otherwise
   */
  private areDependenciesMet(item: QueueItem): boolean {
    if (!item.dependencies || item.dependencies.length === 0) {
      return true;
    }

    for (const depId of item.dependencies) {
      // Dependency is met if it's completed but not failed or cancelled
      if (
        !this.completedOperations.has(depId) ||
        this.failedOperations.has(depId) ||
        this.cancelledOperations.has(depId)
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Checks if an operation can be executed without resource conflicts
   * @param item The operation to check
   * @returns Promise that resolves to true if operation can be executed
   */
  private async canExecuteWithoutConflicts(item: QueueItem): Promise<boolean> {
    if (!item.resources || item.resources.length === 0) {
      // If no resources specified, we assume it can run
      return true;
    }

    for (const resource of item.resources) {
      // Check if any running operation is accessing the same resource
      for (const [_, item] of this.queue.entries()) {
        if (this.runningOperations.has(item.id)) {
          if (
            item.resources &&
            item.resources.some((r) => this.areResourcesConflicting(r, resource))
          ) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Determines if two resources conflict with each other
   * @param resource1 First resource
   * @param resource2 Second resource
   * @returns True if resources conflict, false otherwise
   */
  private areResourcesConflicting(resource1: string, resource2: string): boolean {
    // Check if the resources are the same file or one is a parent of the other
    const path1 = path.resolve(resource1);
    const path2 = path.resolve(resource2);

    // If paths are equal, they conflict
    if (path1 === path2) {
      return true;
    }

    // Check if one is a subdirectory of the other
    const isSubPath = (parent: string, child: string) => {
      const relative = path.relative(parent, child);
      return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    };

    return isSubPath(path1, path2) || isSubPath(path2, path1);
  }

  /**
   * Runs an operation and manages its lifecycle
   * @param item The operation to run
   */
  private async runOperation(item: QueueItem): Promise<void> {
    if (this.runningOperations.has(item.id)) {
      return; // Already running
    }

    this.runningOperations.add(item.id);

    // Register resource access
    if (item.resources) {
      for (const resource of item.resources) {
        let operations = this.fileAccessTracker.get(resource);
        if (!operations) {
          operations = new Set();
          this.fileAccessTracker.set(resource, operations);
        }
        operations.add(item.id);
      }
    }

    try {
      // Check for timeout
      let timeoutId: NodeJS.Timeout | null = null;
      if (item.timeout) {
        timeoutId = setTimeout(() => {
          this.markAsFailed(item.id, new Error(`Operation ${item.id} timed out`));
        }, item.timeout);
      }

      const result = await item.operation();

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      // Mark as completed
      this.completedOperations.set(item.id, result);
      this.queue.delete(item.id);
    } catch (error) {
      if (item.maxRetries !== undefined && item.currentRetries !== undefined) {
        if (item.currentRetries < item.maxRetries) {
          // Retry the operation
          const updatedItem = { ...item, currentRetries: item.currentRetries + 1 };
          this.queue.set(item.id, updatedItem);
          this.runningOperations.delete(item.id);

          // Unregister resource access
          if (item.resources) {
            for (const resource of item.resources) {
              const operations = this.fileAccessTracker.get(resource);
              if (operations) {
                operations.delete(item.id);
              }
            }
          }

          return; // Exit without marking as failed to allow retry
        }
      }

      this.markAsFailed(item.id, error as Error);
    } finally {
      this.runningOperations.delete(item.id);

      // Unregister resource access
      if (item.resources) {
        for (const resource of item.resources) {
          const operations = this.fileAccessTracker.get(resource);
          if (operations) {
            operations.delete(item.id);
          }
        }
      }
    }
  }

  /**
   * Marks an operation as failed
   * @param id The operation ID
   * @param error The error that occurred
   */
  private markAsFailed(id: string, error: Error): void {
    this.failedOperations.set(id, error);
    this.queue.delete(id);
  }

  /**
   * Cancels an operation
   * @param id The operation ID to cancel
   */
  cancel(id: string): void {
    this.cancelledOperations.add(id);
    this.queue.delete(id);
  }

  /**
   * Gets statistics about the queue
   * @returns Queue statistics
   */
  getStats(): QueueStats {
    return {
      pending: Array.from(this.queue.values()).filter(
        (item) =>
          !this.runningOperations.has(item.id) &&
          !this.completedOperations.has(item.id) &&
          !this.failedOperations.has(item.id) &&
          !this.cancelledOperations.has(item.id),
      ).length,
      running: this.runningOperations.size,
      completed: this.completedOperations.size,
      failed: this.failedOperations.size,
      total:
        this.queue.size +
        this.runningOperations.size +
        this.completedOperations.size +
        this.failedOperations.size,
    };
  }

  /**
   * Gets the maximum number of concurrent operations allowed
   * @returns The maximum concurrent operations
   */
  private getMaxConcurrent(): number {
    // This could be configurable, for now using a reasonable default
    return 4;
  }

  /**
   * Waits for all currently queued operations to complete
   * @returns Promise that resolves when all operations are done
   */
  async waitForCompletion(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkCompletion = () => {
        const stats = this.getStats();
        if (stats.pending === 0 && stats.running === 0) {
          resolve();
        } else {
          setTimeout(checkCompletion, 100);
        }
      };
      checkCompletion();
    });
  }
}

export const smartQueue = SmartQueue.getInstance();

/**
 * Helper function to add an operation to the smart queue
 * @param item The queue item to add
 * @returns Promise that resolves to the operation result
 */
export async function addToSmartQueue<T>(item: Omit<QueueItem<T>, "id" | "createdAt">): Promise<T> {
  return await smartQueue.enqueue(item);
}

/**
 * Helper function to execute an operation that accesses specific files using smart queuing
 * @param operation The operation to execute
 * @param resources The files/resources this operation accesses
 * @param priority The priority of this operation
 * @returns Promise that resolves to the operation result
 */
export async function executeWithFileTracking<T>(
  operation: () => Promise<T>,
  resources: string[],
  priority: QueuePriority = "normal",
): Promise<T> {
  return await addToSmartQueue({
    operation,
    resources,
    priority,
    maxRetries: 2,
  });
}
