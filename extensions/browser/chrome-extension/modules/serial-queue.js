export function createSerialQueue() {
  let chain = Promise.resolve();
  return (task) => {
    const pending = chain.then(task, task);
    chain = pending.catch(() => undefined);
    return pending;
  };
}
