import { fc, html } from "./mini.js";
const _Switch = fc(({ checked = false, disabled = false, label = "", name = "", id = "", onChange, className = "" }) => {
    // Generate a unique ID if label is provided but ID is not
    const switchId = id || (label ? `switch-${Math.random().toString(36).substr(2, 9)}` : "");
    const handleClick = () => {
        if (!disabled) {
            onChange?.(!checked);
        }
    };
    const baseClasses = "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50";
    const checkedClasses = "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input";
    const thumbClasses = "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0";
    return html `
         <div class="flex items-center space-x-2 ${className}">
            <button
               type="button"
               role="switch"
               id="${switchId}"
               aria-checked="${checked}"
               data-state="${checked ? "checked" : "unchecked"}"
               ?disabled=${disabled}
               class="${baseClasses} ${checkedClasses}"
               @click=${handleClick}
            >
               <span data-state="${checked ? "checked" : "unchecked"}" class="${thumbClasses}"></span>
            </button>
            ${label
        ? html `
                    <label
                       for="${switchId}"
                       class="text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer select-none"
                       @click=${handleClick}
                    >
                       ${label}
                    </label>
                 `
        : ""}
            ${name ? html ` <input type="hidden" name="${name}" .value=${checked ? "on" : "off"} /> ` : ""}
         </div>
      `;
});
export function Switch(propsOrChecked = false, onChange, label = "", disabled = false, className = "") {
    if (typeof propsOrChecked === "object" && propsOrChecked !== null) {
        return _Switch(propsOrChecked);
    }
    return _Switch({ checked: propsOrChecked, onChange, label, disabled, className });
}
//# sourceMappingURL=Switch.js.map