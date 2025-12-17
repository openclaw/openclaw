import { LitElement, type TemplateResult } from "lit";
export declare class SplitPanel extends LitElement {
    leftPanel?: TemplateResult | HTMLElement;
    rightPanel?: TemplateResult | HTMLElement;
    topPanel?: TemplateResult | HTMLElement;
    bottomPanel?: TemplateResult | HTMLElement;
    initialSplit: number;
    minSize: number;
    hideRight: boolean;
    hideBottom: boolean;
    mobileBreakpoint: number;
    vertical: boolean;
    private currentSplit;
    private isMobile;
    private containerRef;
    private firstPanelRef;
    private secondPanelRef;
    private dividerRef;
    private isDragging;
    private startPos;
    private startSplit;
    protected createRenderRoot(): HTMLElement | DocumentFragment;
    connectedCallback(): void;
    disconnectedCallback(): void;
    private handleResize;
    private checkMobile;
    private handleMouseDown;
    private handleMouseMove;
    private handleMouseUp;
    private handleTouchStart;
    private handleTouchMove;
    private handleTouchEnd;
    render(): TemplateResult<1>;
}
declare global {
    interface HTMLElementTagNameMap {
        "split-panel": SplitPanel;
    }
}
//# sourceMappingURL=SplitPanel.d.ts.map