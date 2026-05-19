import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

type SessionWriteLockRunner = <T>(run: () => Promise<T> | T) => Promise<T>;

type SessionTranscriptWriteContext = {
  sessionFile: string;
  withSessionWriteLock: SessionWriteLockRunner;
};

const activeSessionTranscriptWriteContext = new AsyncLocalStorage<SessionTranscriptWriteContext>();

function resolveActiveSessionTranscriptWriteContext(
  sessionFile: string,
): SessionTranscriptWriteContext | undefined {
  const context = activeSessionTranscriptWriteContext.getStore();
  return context && path.resolve(sessionFile) === context.sessionFile ? context : undefined;
}

export function runWithSessionTranscriptWriteContext<T>(
  params: {
    sessionFile: string;
    withSessionWriteLock: SessionWriteLockRunner;
  },
  run: () => Promise<T> | T,
): Promise<T> | T {
  return activeSessionTranscriptWriteContext.run(
    {
      sessionFile: path.resolve(params.sessionFile),
      withSessionWriteLock: params.withSessionWriteLock,
    },
    run,
  );
}

export async function withActiveSessionTranscriptWriteLock<T>(
  sessionFile: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const context = resolveActiveSessionTranscriptWriteContext(sessionFile);
  if (!context) {
    return await run();
  }
  return await context.withSessionWriteLock(run);
}

export function resolveActiveSessionTranscriptWriteLockRunner(
  sessionFile: string,
): SessionWriteLockRunner | undefined {
  return resolveActiveSessionTranscriptWriteContext(sessionFile)?.withSessionWriteLock;
}
