import { AsyncLocalStorage } from "node:async_hooks";

const authority = new AsyncLocalStorage<() => void>();

export function captureMemoryMutationAuthority(): (() => void) | undefined {
  return authority.getStore();
}

export async function withMemoryMutationAuthority<T>(
  assertCurrent: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const parent = authority.getStore();
  let open = true;
  const assertActive = () => {
    if (!open) {
      throw new Error("Memory mutation authority is closed");
    }
    parent?.();
    assertCurrent();
  };
  assertActive();
  try {
    return await authority.run(assertActive, run);
  } finally {
    open = false;
  }
}
