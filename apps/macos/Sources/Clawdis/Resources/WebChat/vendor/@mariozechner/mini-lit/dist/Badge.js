import { fc, html } from "./mini.js";
// Internal FC component with named args
const _Badge = fc(({ variant = "default", className = "", children }) => {
    const variantClasses = {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "border-input text-foreground",
    };
    const baseClasses = "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden";
    return html ` <span class="${baseClasses} ${variantClasses[variant]} ${className}"> ${children} </span> `;
});
export function Badge(propsOrChildren, variant = "default", className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _Badge(propsOrChildren);
    }
    return _Badge({ children: propsOrChildren, variant, className });
}
//# sourceMappingURL=Badge.js.map