import { i18n } from "./i18n.js";
import { fc, html } from "./mini.js";
const _Label = fc(({ htmlFor = "", required = false, className = "", children }) => {
    const baseClasses = "inline-block text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 mb-2";
    return html `
      <label for="${htmlFor}" class="${baseClasses} ${className}">
         ${children} ${required ? html `<span class="text-destructive ml-1">${i18n("*")}</span>` : ""}
      </label>
   `;
});
export function Label(propsOrChildren, htmlFor = "", required = false, className = "") {
    if (typeof propsOrChildren === "object" && propsOrChildren !== null && "children" in propsOrChildren) {
        return _Label(propsOrChildren);
    }
    return _Label({ children: propsOrChildren, htmlFor, required, className });
}
//# sourceMappingURL=Label.js.map