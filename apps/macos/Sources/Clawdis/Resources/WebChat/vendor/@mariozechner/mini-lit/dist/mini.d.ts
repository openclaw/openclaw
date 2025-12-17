import { html, nothing, type TemplateResult } from "lit";
import { createRef, type Ref, ref } from "lit/directives/ref.js";
export type ComponentRenderFn<P = any> = (props: P) => TemplateResult;
export type Component<P = any> = (props?: P) => TemplateResult;
export declare function fc<P = any>(renderFn: ComponentRenderFn<P>): Component<P>;
export interface ReactiveState<T extends object> {
    __subscribe: (listener: () => void) => () => void;
}
export declare function createState<T extends object>(initialState: T): T & ReactiveState<T>;
export interface BaseComponentProps {
    className?: string;
    children?: TemplateResult | string | number | typeof nothing;
}
export interface ComponentPropsWithoutChildren {
    className?: string;
}
export { createRef, html, nothing, ref };
export type { Ref, TemplateResult };
//# sourceMappingURL=mini.d.ts.map