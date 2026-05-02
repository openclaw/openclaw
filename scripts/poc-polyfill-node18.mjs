// Polyfill Array.prototype.toSorted for Node 18 (added in Node 20)
// Must be loaded via --import before tsx/esm so it's in place when
// bundled-channel-catalog-read.ts evaluates at module load time.
if (!Array.prototype.toSorted) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, "toSorted", {
    value: function (fn) {
      return [...this].sort(fn);
    },
    writable: true,
    configurable: true,
  });
}
