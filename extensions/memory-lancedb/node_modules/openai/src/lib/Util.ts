/**
 * Like `Promise.allSettled()` but throws an error if any promises are rejected.
 */
export const allSettledWithThrow = async <R>(promises: Promise<R>[]): Promise<R[]> => {
  const results = await Promise.allSettled(promises);
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected.length) {
    for (const result of rejected) {
      console.error(result.reason);
    }

    throw new Error(`${rejected.length} promise(s) failed - see the above errors`);
  }

  // Note: TS was complaining about using `.filter().map()` here for some reason
  const values: R[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      values.push(result.value);
    }
  }
  return values;
};
