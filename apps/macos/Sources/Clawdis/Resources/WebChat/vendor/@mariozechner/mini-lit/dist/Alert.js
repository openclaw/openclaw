import { fc, html } from "./mini.js";
// Internal FC components with named args
const _Alert = fc(({ variant = "default", className = "", children }) => {
    const variantClasses = {
        default: "bg-background text-foreground border-border",
        destructive: "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
    };
    const baseClasses = "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground";
    return html ` <div class="${baseClasses} ${variantClasses[variant]} ${className}" role="alert">${children}</div> `;
});
const _AlertTitle = fc(({ className = "", children }) => {
    return html ` <h5 class="mb-1 font-medium leading-none tracking-tight ${className}">${children}</h5> `;
});
const _AlertDescription = fc(({ className = "", children }) => {
    return html ` <div class="text-sm [&_p]:leading-relaxed ${className}">${children}</div> `;
});
export function Alert(propsOrChildren, variant = "default", className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _Alert(propsOrChildren);
    }
    return _Alert({ children: propsOrChildren, variant, className });
}
export function AlertTitle(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _AlertTitle(propsOrChildren);
    }
    return _AlertTitle({ children: propsOrChildren, className });
}
export function AlertDescription(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _AlertDescription(propsOrChildren);
    }
    return _AlertDescription({ children: propsOrChildren, className });
}
//# sourceMappingURL=Alert.js.map