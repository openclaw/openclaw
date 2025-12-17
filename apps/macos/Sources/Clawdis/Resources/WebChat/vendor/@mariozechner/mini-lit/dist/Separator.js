import { fc, html } from "./mini.js";
const _Separator = fc(({ orientation = "horizontal", decorative = true, className = "" }) => {
    const orientationClasses = orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]";
    const baseClasses = "shrink-0 bg-border";
    return html `
      <div
         role="${decorative ? "none" : "separator"}"
         aria-orientation="${decorative ? undefined : orientation}"
         class="${baseClasses} ${orientationClasses} ${className}"
      ></div>
   `;
});
export function Separator(propsOrOrientation = "horizontal", className = "") {
    if (typeof propsOrOrientation === "object" && propsOrOrientation !== null) {
        return _Separator(propsOrOrientation);
    }
    return _Separator({ orientation: propsOrOrientation, className });
}
//# sourceMappingURL=Separator.js.map