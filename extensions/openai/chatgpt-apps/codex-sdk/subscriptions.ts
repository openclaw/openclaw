export type Unsubscribe = () => void;

export class ListenerSet<TArgs extends unknown[]> {
  private readonly listeners = new Set<(...args: TArgs) => void>();

  subscribe(listener: (...args: TArgs) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: TArgs): void {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
