import { LitElement, type TemplateResult } from "lit";
import { type BaseComponentProps } from "./mini.js";
export declare class Sidebar extends LitElement {
    defaultOpen: boolean;
    breakpoint: "sm" | "md" | "lg" | "xl";
    className: string;
    logo: TemplateResult | string;
    footer: TemplateResult | string;
    content: TemplateResult | string;
    private isOpen;
    protected createRenderRoot(): this;
    connectedCallback(): void;
    private toggleSidebar;
    render(): TemplateResult<1>;
}
export interface SidebarItemProps extends BaseComponentProps {
    href?: string;
    active?: boolean;
    onClick?: () => void;
    children: TemplateResult | string;
}
export declare const SidebarItem: import("./mini.js").Component<SidebarItemProps>;
export interface SidebarSectionProps extends BaseComponentProps {
    title?: string;
}
export declare const SidebarSection: import("./mini.js").Component<SidebarSectionProps>;
//# sourceMappingURL=Sidebar.d.ts.map