/** Keep unused routing rows in image-backed text instead of every Worker's heap. */
export function standaloneLookupExpression(record) {
  const rows = Object.entries(record).flatMap(([key, value]) => {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? [] : [[JSON.stringify(key), encoded]];
  });
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  // Directory values can be large; search keys without traversing their payloads.
  let offset = 0;
  const index = rows
    .map(([key, value]) => {
      const start = offset;
      offset += value.length;
      return key + "\t" + start + "," + offset + "\n";
    })
    .join("");
  const data = rows.map(([, value]) => value).join("");
  return `(() => {
    const data = ${JSON.stringify(data)};
    const index = ${JSON.stringify(index)};
    const cache = new Map();
    return (key) => {
      if (typeof key !== "string") return undefined;
      if (cache.has(key)) return cache.get(key);
      const encoded = JSON.stringify(key);
      let lo = 0, hi = index.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const start = index.lastIndexOf("\\n", mid - 1) + 1;
        const tab = index.indexOf("\\t", start);
        const end = index.indexOf("\\n", tab);
        const candidate = index.slice(start, tab);
        if (candidate === encoded) {
          const comma = index.indexOf(",", tab);
          const value = JSON.parse(data.slice(
            Number(index.slice(tab + 1, comma)), Number(index.slice(comma + 1, end))));
          cache.set(key, value);
          return value;
        }
        if (candidate < encoded) lo = end + 1;
        else hi = start;
      }
      return undefined;
    };
  })()`;
}

export function standaloneEmbeddedPathsExpression(paths) {
  const prefix = "/$bunfs/root/runtime/";
  const otherTargets = [...new Set(Object.values(paths))].filter(
    (target) => !target.startsWith(prefix) || paths[target.slice(prefix.length)] !== target,
  );
  return `(() => {
    const lookup = ${standaloneLookupExpression(paths)};
    const targets = new Set(${JSON.stringify(otherTargets)});
    const prefix = ${JSON.stringify(prefix)};
    return (pathname) => targets.has(pathname)
      || (typeof pathname === "string" && pathname.startsWith(prefix) && lookup(pathname.slice(prefix.length)) === pathname)
      ? pathname : lookup(pathname);
  })()`;
}

/** Emit large native tables without one AOT stack temporary per object property.
 * @param {object} value
 */
export function standaloneDataExpression(value) {
  return `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
}
