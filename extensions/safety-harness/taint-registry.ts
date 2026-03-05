const taintMap = new WeakMap<object, { type: string; taintedAt: number }>();

export class TaintRegistry {
  taint(data: object, sourceType: string): void {
    taintMap.set(data, { type: sourceType, taintedAt: Date.now() });
  }

  isTainted(data: unknown): boolean {
    if (typeof data !== "object" || data === null) return false;
    return taintMap.has(data);
  }

  hasTaintedValue(obj: unknown): boolean {
    if (typeof obj !== "object" || obj === null) return false;
    if (taintMap.has(obj)) return true;
    if (Array.isArray(obj)) return obj.some((item) => this.hasTaintedValue(item));
    for (const value of Object.values(obj)) {
      if (typeof value === "object" && value !== null) {
        if (taintMap.has(value) || this.hasTaintedValue(value)) return true;
      }
    }
    return false;
  }
}
