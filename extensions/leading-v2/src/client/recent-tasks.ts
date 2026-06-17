/**
 * Per-user memory of the most recent task created in a given module, kept
 * server-side so the agent can poll status without ever being handed the raw
 * backend id (an internal identifier that must not surface in the chat). Each
 * module namespaces its own store; the status tool defaults to the latest
 * remembered task for the user.
 */
export class RecentTaskStore<T> {
  private readonly byUser = new Map<string, T>();

  /** Record the task just created for this user (overwrites any prior one). */
  remember(userId: string, task: T): void {
    this.byUser.set(userId, task);
  }

  /** The most recent task for this user, or undefined if none was created. */
  latest(userId: string): T | undefined {
    return this.byUser.get(userId);
  }
}
