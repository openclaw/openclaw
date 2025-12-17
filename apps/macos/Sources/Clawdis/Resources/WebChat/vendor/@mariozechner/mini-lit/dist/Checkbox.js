import { createRef, fc, html, ref } from "./mini.js";
const _Checkbox = fc(({ checked = false, indeterminate = false, disabled = false, label = "", name = "", value = "", id = "", onChange, className = "", }) => {
    const inputRef = createRef();
    // Generate a unique ID if label is provided but ID is not
    const checkboxId = id || (label ? `checkbox-${Math.random().toString(36).substr(2, 9)}` : "");
    const handleChange = (e) => {
        const target = e.target;
        onChange?.(target.checked);
    };
    const baseClasses = "peer h-4 w-4 shrink-0 rounded-sm border border-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
    const checkedClasses = "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground";
    // Set indeterminate state after render
    if (inputRef.value) {
        inputRef.value.indeterminate = indeterminate;
    }
    return html `
         <div class="flex space-x-2 items-start ${className}">
            <input
               ${ref(inputRef)}
               type="checkbox"
               id="${checkboxId}"
               class="${baseClasses} ${checkedClasses}"
               .checked=${checked}
               ?disabled=${disabled}
               name="${name}"
               value="${value}"
               data-state="${checked ? "checked" : "unchecked"}"
               @change=${handleChange}
            />
            ${label
        ? html `
                    <label
                       for="${checkboxId}"
                       class="text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer select-none"
                    >
                       ${label}
                    </label>
                 `
        : ""}
         </div>
      `;
});
export function Checkbox(propsOrChecked = false, onChange, label = "", disabled = false, className = "") {
    if (typeof propsOrChecked === "object" && propsOrChecked !== null) {
        return _Checkbox(propsOrChecked);
    }
    return _Checkbox({ checked: propsOrChecked, onChange, label, disabled, className });
}
//# sourceMappingURL=Checkbox.js.map