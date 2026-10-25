/** Keep unused routing rows in image-backed text instead of every Worker's heap. */
export function standaloneLookupExpression(record) {
  const rows = Object.entries(record).flatMap(([key, value]) => {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? [] : [[JSON.stringify(key), encoded]];
  });
  rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const data = rows.map(([key, value]) => key + "\t" + value + "\n").join("");
  return `(() => {
    const data = ${JSON.stringify(data)};
    const cache = new Map();
    return (key) => {
      if (typeof key !== "string") return undefined;
      if (cache.has(key)) return cache.get(key);
      const encoded = JSON.stringify(key);
      let lo = 0, hi = data.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const start = data.lastIndexOf("\\n", mid - 1) + 1;
        const tab = data.indexOf("\\t", start);
        const end = data.indexOf("\\n", tab);
        const candidate = data.slice(start, tab);
        if (candidate === encoded) {
          const value = JSON.parse(data.slice(tab + 1, end));
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
