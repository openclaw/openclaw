import { fc, html } from "./mini.js";
// Internal FC components with named args
const _Card = fc(({ hoverable = false, className = "", children }) => {
    const baseClasses = "bg-card text-card-foreground flex flex-col gap-6 rounded-xl border border-border shadow-xs";
    const hoverClasses = hoverable ? "hover:shadow-md transition-shadow" : "";
    return html ` <div class="${baseClasses} ${hoverClasses} py-6 ${className}">${children}</div> `;
});
const _CardHeader = fc(({ className = "", children }) => {
    return html `
      <div
         class="grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-[ui-card-action]:grid-cols-[1fr_auto] ${className}"
      >
         ${children}
      </div>
   `;
});
const _CardAction = fc(({ className = "", children }) => {
    return html `
      <div class="col-start-2 row-span-2 row-start-1 self-start justify-self-end ${className}">${children}</div>
   `;
});
const _CardTitle = fc(({ className = "", children }) => {
    return html ` <h3 class="leading-none font-semibold ${className}">${children}</h3> `;
});
const _CardDescription = fc(({ className = "", children }) => {
    return html ` <div class="text-muted-foreground text-sm ${className}">${children}</div> `;
});
const _CardContent = fc(({ className = "", children }) => {
    return html ` <div class="px-6 ${className}">${children}</div> `;
});
const _CardFooter = fc(({ className = "", children }) => {
    return html ` <div class="flex items-center px-6 ${className}">${children}</div> `;
});
export function Card(propsOrChildren, hoverable = false, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _Card(propsOrChildren);
    }
    return _Card({ children: propsOrChildren, hoverable, className });
}
export function CardHeader(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _CardHeader(propsOrChildren);
    }
    return _CardHeader({ children: propsOrChildren, className });
}
export function CardAction(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _CardAction(propsOrChildren);
    }
    return _CardAction({ children: propsOrChildren, className });
}
export function CardTitle(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _CardTitle(propsOrChildren);
    }
    return _CardTitle({ children: propsOrChildren, className });
}
export function CardDescription(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _CardDescription(propsOrChildren);
    }
    return _CardDescription({ children: propsOrChildren, className });
}
export function CardContent(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _CardContent(propsOrChildren);
    }
    return _CardContent({ children: propsOrChildren, className });
}
export function CardFooter(propsOrChildren, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _CardFooter(propsOrChildren);
    }
    return _CardFooter({ children: propsOrChildren, className });
}
//# sourceMappingURL=Card.js.map