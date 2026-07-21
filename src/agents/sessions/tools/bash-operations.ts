/**
 * Minimal shell execution interface injected into bash session tools.
 */

/** Identifies which process pipe a chunk arrived on. */
export type BashOutputStream = "stdout" | "stderr";

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      /**
       * stdout and stderr are independent pipes, so each needs its own decode
       * state; tag chunks to keep them apart. Untagged chunks share one lane,
       * preserving behavior for operations that cannot distinguish streams.
       */
      onData: (data: Buffer, stream?: BashOutputStream) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}
