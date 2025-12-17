import { LitElement } from 'lit';
import { MiniButton, MiniCheckbox } from './index.next.js';
export declare class MyApp extends LitElement {
    private accepted;
    private loading;
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
    private handleSubmit;
}
export declare class MyCustomButton extends LitElement {
    private count;
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class MyStyledApp extends LitElement {
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
}
export declare function generateDocs(Component: typeof MiniButton | typeof MiniCheckbox): {
    name: string;
    description: any;
    control: any;
    options: any;
    type: "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function";
    default: any;
}[];
export declare function renderToString(Component: typeof MiniButton, props: any): any;
export declare class MyGlobalStyledApp extends LitElement {
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=usage-example.next.d.ts.map