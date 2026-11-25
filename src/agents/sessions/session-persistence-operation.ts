/** Share preparation and error handling between the sync SDK adapter and awaited worker IO. */
export type SessionPersistenceStep = { sync(): void; async(): Promise<void> };

export function* sessionPersistenceStep<T>(
  sync: () => T,
  asynchronous?: () => Promise<T>,
): Generator<SessionPersistenceStep, T, void> {
  let result!: T;
  yield {
    sync: () => {
      result = sync();
    },
    async: async () => {
      result = asynchronous ? await asynchronous() : sync();
    },
  };
  return result;
}

export function runSessionPersistenceSync<T>(steps: Generator<SessionPersistenceStep, T, void>): T {
  let step = steps.next();
  while (!step.done) {
    try {
      step.value.sync();
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next();
  }
  return step.value;
}

export async function runSessionPersistenceAsync<T>(
  steps: Generator<SessionPersistenceStep, T, void>,
): Promise<T> {
  let step = steps.next();
  while (!step.done) {
    try {
      await step.value.async();
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next();
  }
  return step.value;
}
