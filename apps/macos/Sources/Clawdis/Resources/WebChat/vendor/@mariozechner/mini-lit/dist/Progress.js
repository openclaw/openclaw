import { fc, html } from "./mini.js";
const _Progress = fc(({ value = 0, max = 100, indicatorClassName = "", className = "" }) => {
    const percentage = Math.min(Math.max(0, (value / max) * 100), 100);
    const baseClasses = "relative h-2 w-full overflow-hidden rounded-full bg-secondary";
    const indicatorClasses = "h-full w-full flex-1 bg-primary transition-all";
    return html `
      <div
         role="progressbar"
         aria-valuemin="0"
         aria-valuemax="${max}"
         aria-valuenow="${value}"
         class="${baseClasses} ${className}"
      >
         <div
            class="${indicatorClasses} ${indicatorClassName}"
            style="transform: translateX(-${100 - percentage}%)"
         ></div>
      </div>
   `;
});
export function Progress(propsOrValue = 0, max = 100, className = "") {
    if (typeof propsOrValue === "object" && propsOrValue !== null) {
        return _Progress(propsOrValue);
    }
    return _Progress({ value: propsOrValue, max, className });
}
//# sourceMappingURL=Progress.js.map