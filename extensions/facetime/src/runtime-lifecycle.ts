export async function stopRetainedRuntime<T extends { stop(): Promise<void> }>(
  current: Promise<T> | undefined,
  clearIfCurrent: (stopped: Promise<T>) => void,
): Promise<void> {
  if (!current) {
    return;
  }
  let runtime: T;
  try {
    runtime = await current;
  } catch (error) {
    clearIfCurrent(current);
    throw error;
  }
  await runtime.stop();
  clearIfCurrent(current);
}
