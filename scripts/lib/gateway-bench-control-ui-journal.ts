/** Keep capture off the request loop while coalescing writes during filesystem backpressure. */
export function createControlUiJournalWriter(
  append: (text: string) => Promise<void>,
  failed: (error: unknown) => void,
) {
  let queued: string[] = [];
  let writing = false;
  let settled = Promise.resolve();
  return (line: string): Promise<void> => {
    queued.push(line);
    if (!writing) {
      writing = true;
      settled = (async () => {
        try {
          while (queued.length) {
            const batch = queued.join("");
            queued = [];
            await append(batch);
          }
        } catch (error) {
          queued = [];
          failed(error);
        } finally {
          writing = false;
        }
      })();
    }
    return settled;
  };
}
