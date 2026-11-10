function primitiveOptions(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) {
    return undefined;
  }
  const entries = [];
  for (const key of keys.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
    const descriptor = descriptors[key];
    if (
      !("value" in descriptor) ||
      (descriptor.value !== null &&
        !["undefined", "boolean", "number", "string"].includes(typeof descriptor.value))
    ) {
      return undefined;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

/**
 * @typedef {(source: string, options: import("acorn").Options) => object} StandaloneParser
 */

/**
 * Transforms inspect ASTs without mutating them; retain only the latest successful parse.
 * @template {[source: string, options?: object]} Args
 * @template Tree
 * @param {(...args: Args) => Tree} parse
 * @returns {(...args: Args) => Tree}
 */
export function createStandaloneParser(parse) {
  let cached;
  return (source, options) => {
    const entries = typeof source === "string" ? primitiveOptions(options) : undefined;
    if (
      entries &&
      cached?.source === source &&
      cached.options.length === entries.length &&
      entries.every(
        ([key, value], index) =>
          key === cached.options[index][0] && Object.is(value, cached.options[index][1]),
      )
    ) {
      return cached.ast;
    }
    const ast = parse(source, options);
    cached = entries ? { source, options: entries, ast } : undefined;
    return ast;
  };
}
