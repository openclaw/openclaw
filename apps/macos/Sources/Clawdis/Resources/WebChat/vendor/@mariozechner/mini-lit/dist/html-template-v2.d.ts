export declare function registerComponent(name: string, component: any): void;
export declare function registerComponents(components: Record<string, any>): void;
export declare function html(statics: TemplateStringsArray, ...values: any[]): any;
export declare abstract class Component<P = Record<string, any>> {
    props: P;
    private container?;
    private dispose?;
    constructor(props: P);
    abstract render(): any;
    mount(container: HTMLElement): this;
    update(): void;
    unmount(): void;
}
export declare function createComponent<P = Record<string, any>>(renderFn: (props: P) => any): new (props: P) => Component<P>;
export declare function mount(ComponentClass: new (props: any) => Component, container: HTMLElement, props?: {}): Component<Record<string, any>>;
export { computed, effect, signal } from "@preact/signals-core";
//# sourceMappingURL=html-template-v2.d.ts.map