export function mockBunVersion(version: string | undefined): Disposable {
  const versions = process.versions;
  const original = Object.getOwnPropertyDescriptor(versions, "bun");
  Object.defineProperty(versions, "bun", { value: version, configurable: true });
  return {
    [Symbol.dispose]() {
      if (original) {
        Object.defineProperty(versions, "bun", original);
      } else {
        Reflect.deleteProperty(versions, "bun");
      }
    },
  };
}
