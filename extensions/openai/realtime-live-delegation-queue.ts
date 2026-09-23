const INPUT_WAIT_MS = 15_000;
const MAX_PENDING_DELEGATIONS = 32;
const MAX_SESSION_DELEGATIONS = 4_096;

/** Claims public delegation notices until their transcript is available or the call retires. */
export class OpenAILiveDelegationQueue {
  private readonly claimed = new Set<string>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    private readonly options: {
      isActive: () => boolean;
      readInput: () => string;
      dispatch: (id: string, input: string) => void;
      onExpired: (id: string) => void;
      onError: (error: Error) => void;
    },
  ) {}

  enqueue(id: string): void {
    if (this.stopped || !this.options.isActive() || this.claimed.has(id)) {
      return;
    }
    if (
      id.length > 512 ||
      this.claimed.size >= MAX_SESSION_DELEGATIONS ||
      this.pending.size >= MAX_PENDING_DELEGATIONS
    ) {
      this.stop();
      this.options.onError(new Error("GPT-Live delegation notice limit exceeded"));
      return;
    }
    // Claim before any callback can deliver the same notice reentrantly.
    this.claimed.add(id);
    const timeout = setTimeout(() => {
      this.pending.delete(id);
      if (this.stopped || !this.options.isActive()) {
        return;
      }
      try {
        this.options.onExpired(id);
      } catch {
        this.stop();
        this.options.onError(new Error("GPT-Live could not request missing delegation input"));
      }
    }, INPUT_WAIT_MS);
    timeout.unref?.();
    this.pending.set(id, timeout);
    this.resume();
  }

  resume(): void {
    for (const [id, timeout] of this.pending) {
      if (this.stopped || !this.options.isActive()) {
        return;
      }
      const input = this.options.readInput();
      if (!input.trim()) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(timeout);
      // Dispatch owns consumption; a later notice must reread the remaining context.
      this.options.dispatch(id, input);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timeout of this.pending.values()) {
      clearTimeout(timeout);
    }
    this.pending.clear();
    this.claimed.clear();
  }
}
