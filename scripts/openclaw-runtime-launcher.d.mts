export type RuntimePointer = {
  current: string;
  origin: string;
  previous?: string;
  /** Gateway starts left before the launcher returns to previous. */
  trial?: number;
  /** The slot the launcher left after its trial ran out. */
  failed?: string;
  /** Gateway update run that the flip carried; the Gateway that settles the slot finishes it. */
  run?: string;
};
export const RUNTIME_POINTER_FILE: "slots.json";
export function readRuntimePointer(dir: string): RuntimePointer | null;
export function writeRuntimePointer(dir: string, pointer: RuntimePointer): void;
export function runtimeEntry(root: string): string;
export function selectRuntimeRoot(dir: string, options: { start: boolean }): string;
