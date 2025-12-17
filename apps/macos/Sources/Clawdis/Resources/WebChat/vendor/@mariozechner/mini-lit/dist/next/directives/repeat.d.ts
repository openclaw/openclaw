import { type Directive } from "./directive.js";
/**
 * Efficiently render lists with keyed updates
 * Similar to Lit's repeat or Solid's For
 */
export declare function repeat<T>(items: T[] | (() => T[]), keyFn: (item: T, index: number) => any, template: (item: T, index: number) => any): Directive;
//# sourceMappingURL=repeat.d.ts.map