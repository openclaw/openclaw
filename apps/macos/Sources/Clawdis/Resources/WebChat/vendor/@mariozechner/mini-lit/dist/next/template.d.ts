export declare function setDebug(value: boolean): void;
export declare function registerComponent(name: string, component: any): void;
export declare function registerComponents(components: Record<string, any>): void;
export declare function html(statics: TemplateStringsArray, ...values: any[]): any;
export declare const templateRuntime: {
    insert(parent: Element, accessor: any, marker?: Node | null): (() => void) | undefined;
    createComponent(Comp: any, props: any): ChildNode | ChildNode[];
    addEventListener(node: Element, name: string, handler: any): (() => void) | undefined;
    setAttribute(node: Element, name: string, value: any): (() => void) | undefined;
    setProperty(node: any, name: string, value: any): (() => void) | undefined;
    setRef(node: Element, callback: any): void;
    isSignal(value: any): boolean;
    startCleanupTracking(): void;
    getTrackedCleanups(): Array<(() => void) | undefined>;
};
//# sourceMappingURL=template.d.ts.map