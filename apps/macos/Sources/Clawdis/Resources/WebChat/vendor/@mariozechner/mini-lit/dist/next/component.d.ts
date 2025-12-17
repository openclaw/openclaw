/**
 * Base props that all components have
 */
export interface ComponentProps {
    children?: Node | Node[] | string | number | null;
    [key: string]: any;
}
/**
 * Base component class
 */
export declare abstract class Component<P = ComponentProps> {
    props: P;
    private container?;
    private dispose?;
    private cleanups;
    constructor(props: P);
    protected processSlots(): void;
    abstract render(): RenderResult;
    mount(container: HTMLElement): this;
    protected addCleanup(cleanup: (() => void) | undefined): void;
    update(): void;
    protected cleanup(): void;
    unmount(): void;
}
/**
 * Component options including slot declarations
 */
export interface ComponentOptions {
    slots?: string[];
}
/**
 * Valid return types from a component's render function
 */
export type RenderResult = Node | Node[] | string | number | null;
/**
 * Create a functional component
 */
export declare function createComponent<P extends ComponentProps = ComponentProps>(renderFn: (props: P) => RenderResult, options?: ComponentOptions): new (props: P) => Component<P>;
/**
 * Mount a component to a container
 */
export declare function mount(ComponentClass: new (props: any) => Component, container: HTMLElement, props?: {}): Component<ComponentProps>;
//# sourceMappingURL=component.d.ts.map