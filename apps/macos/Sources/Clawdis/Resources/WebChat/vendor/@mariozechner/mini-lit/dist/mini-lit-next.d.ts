import { html, nothing } from 'lit';
import { signal, effect, computed, Signal } from '@preact/signals-core';
export declare abstract class Component<P = {}> {
    private startMarker;
    private endMarker;
    private container;
    private _disposal;
    private _mounted;
    props: P;
    constructor(props: P);
    abstract render(): ReturnType<typeof html>;
    onMount(): void;
    onUnmount(): void;
    onUpdate(): void;
    mount(container: ParentNode, before?: Node | null): this;
    private _render;
    unmount(): void;
}
export declare function createComponent<P = {}>(renderFn: (props: P) => ReturnType<typeof html>): new (props: P) => Component<P>;
export { signal, effect, computed };
export type { Signal };
export { html, nothing };
export declare function component<P>(ComponentClass: new (props: P) => Component<P>, props: P): any;
export declare const appState: {
    user: Signal<{
        name: string;
    } | null>;
    theme: Signal<"light" | "dark">;
};
export declare function mount(ComponentClass: new (props: any) => Component, container: HTMLElement, props?: {}): Component<{}>;
//# sourceMappingURL=mini-lit-next.d.ts.map