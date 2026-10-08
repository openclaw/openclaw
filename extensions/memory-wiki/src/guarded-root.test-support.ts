import path from "node:path";
import type { root } from "openclaw/plugin-sdk/security-runtime";
import { vi } from "vitest";

type GuardedRoot = Awaited<ReturnType<typeof root>>;

export type RootMoveHooks = {
  beforeMove?: (from: string, to: string) => void;
  afterMove?: (from: string, to: string) => void | Promise<void>;
};

export function observeRootMoves(vault: GuardedRoot, hooks: RootMoveHooks): GuardedRoot {
  const move = vault.move.bind(vault);
  vi.spyOn(vault, "move").mockImplementation(async (from, to, options) => {
    const source = path.resolve(vault.rootReal, from);
    const destination = path.resolve(vault.rootReal, to);
    hooks.beforeMove?.(source, destination);
    // Faults occur after real guarded publication and before the importer can record it.
    await move(from, to, options);
    await hooks.afterMove?.(source, destination);
  });
  return vault;
}
