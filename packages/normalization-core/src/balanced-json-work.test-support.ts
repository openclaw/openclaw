/** Counts native work only during a synchronous extraction, restoring every global on failure. */
export function measureJsonWork<T>(run: () => T) {
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the original receiver.
  const get = Map.prototype.get;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the original receiver.
  const remove = Map.prototype.delete;
  const push = Array.prototype.push;
  const parse = JSON.parse;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the original receiver.
  const slice = String.prototype.slice;
  let visits = 0;
  let retirements = 0;
  let pushes = 0;
  let parsedUnits = 0;
  let copiedUnits = 0;
  // eslint-disable-next-line no-extend-native -- Count every identity lookup, including surviving links.
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    visits++;
    return Reflect.apply(get, this, [key]);
  };
  // eslint-disable-next-line no-extend-native -- Count actual retired identities, not only attempted deletions.
  Map.prototype.delete = function (this: Map<unknown, unknown>, key: unknown) {
    const removed = Reflect.apply(remove, this, [key]);
    retirements += Number(removed);
    return removed;
  };
  // eslint-disable-next-line no-extend-native -- Count container edges without recording spy calls.
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    pushes += items.length;
    return Reflect.apply(push, this, items);
  };
  JSON.parse = (text, reviver) => {
    parsedUnits += text.length;
    return parse(text, reviver);
  };
  // eslint-disable-next-line no-extend-native -- Count copied source rather than elapsed time.
  String.prototype.slice = function (this: string, start, end) {
    const result = Reflect.apply(slice, this, [start, end]);
    copiedUnits += result.length;
    return result;
  };
  let result: T;
  try {
    result = run();
  } finally {
    // eslint-disable-next-line no-extend-native -- Restore all synchronous counters on success or failure.
    Map.prototype.get = get;
    // eslint-disable-next-line no-extend-native -- Restore the original identity operation.
    Map.prototype.delete = remove;
    // eslint-disable-next-line no-extend-native -- Restore the original array operation.
    Array.prototype.push = push;
    JSON.parse = parse;
    // eslint-disable-next-line no-extend-native -- Restore the original string operation.
    String.prototype.slice = slice;
  }
  return { result, visits, retirements, pushes, parsedUnits, copiedUnits };
}
