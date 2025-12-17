var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Menu, X } from "lucide";
import { Button } from "./Button.js";
import { icon } from "./icons.js";
import { fc } from "./mini.js";
let Sidebar = class Sidebar extends LitElement {
    constructor() {
        super(...arguments);
        this.defaultOpen = false;
        this.breakpoint = "md";
        this.className = "";
        this.logo = "";
        this.footer = "";
        this.content = "";
        this.isOpen = false;
        this.toggleSidebar = () => {
            this.isOpen = !this.isOpen;
        };
    }
    createRenderRoot() {
        return this; // Use light DOM for global styles
    }
    connectedCallback() {
        super.connectedCallback();
        this.isOpen = this.defaultOpen;
    }
    render() {
        // Responsive classes based on breakpoint
        const hideOnDesktop = {
            sm: "sm:hidden",
            md: "md:hidden",
            lg: "lg:hidden",
            xl: "xl:hidden",
        }[this.breakpoint];
        const showDesktopSidebar = {
            sm: "sm:translate-x-0",
            md: "md:translate-x-0",
            lg: "lg:translate-x-0",
            xl: "xl:translate-x-0",
        }[this.breakpoint];
        // On mobile, use isOpen state. On desktop, always show.
        const mobileTransform = this.isOpen ? "translate-x-0" : "-translate-x-full";
        return html `
         <!-- Mobile menu button (only visible on mobile when sidebar is closed) -->
         <div
            class="${hideOnDesktop} fixed top-4 left-4 z-50 ${this.isOpen ? "opacity-0 pointer-events-none" : "opacity-100"}"
         >
            ${Button({
            variant: "outline",
            size: "icon",
            onClick: this.toggleSidebar,
            children: icon(Menu, "sm"),
        })}
         </div>

         <!-- Overlay for mobile -->
         <div
            class="fixed inset-0 bg-black/50 z-40 ${hideOnDesktop} ${this.isOpen ? "" : "hidden"}"
            @click=${this.toggleSidebar}
         ></div>

         <!-- Sidebar -->
         <aside
            class="fixed top-0 left-0 z-40 h-full w-64 bg-card border-r border-border transition-transform duration-300
               ${mobileTransform}
               ${showDesktopSidebar}
               ${this.className}"
         >
            <div class="flex flex-col h-full">
               <!-- Close button for mobile -->
               <div class="${hideOnDesktop} absolute top-4 right-4">
                  ${Button({
            variant: "ghost",
            size: "icon",
            onClick: this.toggleSidebar,
            children: icon(X, "sm"),
        })}
               </div>

               <!-- Logo/Header -->
               ${this.logo ? html ` <div class="p-4">${this.logo}</div> ` : ""}

               <!-- Scrollable content -->
               <div class="flex-1 overflow-y-auto p-4 space-y-4">${this.content}</div>

               <!-- Footer -->
               ${this.footer ? html ` <div class="p-4">${this.footer}</div> ` : ""}
            </div>
         </aside>
      `;
    }
};
__decorate([
    property({ type: Boolean, attribute: "default-open" })
], Sidebar.prototype, "defaultOpen", void 0);
__decorate([
    property({ type: String })
], Sidebar.prototype, "breakpoint", void 0);
__decorate([
    property({ type: String, attribute: "class-name" })
], Sidebar.prototype, "className", void 0);
__decorate([
    property({ type: Object })
], Sidebar.prototype, "logo", void 0);
__decorate([
    property({ type: Object })
], Sidebar.prototype, "footer", void 0);
__decorate([
    property({ type: Object })
], Sidebar.prototype, "content", void 0);
__decorate([
    state()
], Sidebar.prototype, "isOpen", void 0);
Sidebar = __decorate([
    customElement("mini-sidebar")
], Sidebar);
export { Sidebar };
export const SidebarItem = fc(({ href, active = false, onClick, children, className = "" }) => {
    const baseClasses = "block px-2 py-1 text-sm rounded transition-colors";
    const activeClasses = active ? "bg-muted text-foreground font-medium" : "hover:bg-muted text-foreground";
    if (href) {
        return html `
         <a href="${href}" class="${baseClasses} ${activeClasses} ${className}" @click=${onClick}> ${children} </a>
      `;
    }
    return html `
      <button class="${baseClasses} ${activeClasses} ${className} w-full text-left" @click=${onClick}>
         ${children}
      </button>
   `;
});
export const SidebarSection = fc(({ title, children, className = "" }) => {
    if (!title) {
        // No title means top-level items, no wrapper needed
        return html ` <div class="space-y-1 ${className}">${children}</div> `;
    }
    return html `
      <div class="space-y-2 ${className}">
         <h4 class="font-medium text-sm px-2">${title}</h4>
         <nav class="space-y-1 pl-4">${children}</nav>
      </div>
   `;
});
//# sourceMappingURL=Sidebar.js.map