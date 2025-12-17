import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { createElement } from "lucide";
const sizeClasses = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
    xl: "w-8 h-8",
};
// Helper to create icon with size class
export function icon(lucideIcon, size = "md", className) {
    return html `${unsafeHTML(iconDOM(lucideIcon, size, className).outerHTML)}`;
}
export function iconDOM(lucideIcon, size = "md", className) {
    const element = createElement(lucideIcon, {
        class: sizeClasses[size] + (className ? " " + className : ""),
    });
    return element;
}
//# sourceMappingURL=icons.js.map