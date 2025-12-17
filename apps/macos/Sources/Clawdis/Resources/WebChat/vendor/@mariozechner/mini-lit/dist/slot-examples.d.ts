import { LitElement } from 'lit';
export declare class ShadowCard extends LitElement {
    render(): import("lit-html").TemplateResult<1>;
}
export declare class LightCardManual extends LitElement {
    createRenderRoot(): this;
    connectedCallback(): void;
    private _processSlots;
    private _slots;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class LightCardData extends LitElement {
    createRenderRoot(): this;
    private _slots;
    connectedCallback(): void;
    private _collectSlots;
    render(): import("lit-html").TemplateResult<1>;
    private _handleSlotClick;
}
export declare class LightCardRender extends LitElement {
    createRenderRoot(): this;
    header?: () => unknown;
    footer?: () => unknown;
    content?: () => unknown;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class LightCardQuery extends LitElement {
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
    private _rearrangeSlots;
}
export declare class MiniCard extends LitElement {
    createRenderRoot(): this;
    hasHeader: boolean;
    hasFooter: boolean;
    connectedCallback(): void;
    firstUpdated(): void;
    private _distributeSlots;
    render(): import("lit-html").TemplateResult<1>;
}
export declare class SlotDemoPage extends LitElement {
    createRenderRoot(): this;
    render(): import("lit-html").TemplateResult<1>;
}
//# sourceMappingURL=slot-examples.d.ts.map