import { i18n } from "./i18n.js";
import { fc, html } from "./mini.js";
const _Textarea = fc(({ id = "", value = "", placeholder = "", label = "", error = "", disabled = false, required = false, name = "", rows = 4, cols, maxLength, resize = "vertical", onInput, onChange, className = "", }) => {
    const resizeClasses = {
        none: "resize-none",
        both: "resize",
        horizontal: "resize-x",
        vertical: "resize-y",
    };
    const baseClasses = "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
    const stateClasses = error ? "border-destructive" : "";
    return html `
         <div class="flex flex-col gap-1.5 ${className}">
            ${label
        ? html `
                    <label class="text-sm font-medium text-foreground">
                       ${label} ${required ? html `<span class="text-destructive">${i18n("*")}</span>` : ""}
                    </label>
                 `
        : ""}
            <textarea
               id="${id}"
               class="${baseClasses} ${resizeClasses[resize]} ${stateClasses}"
               .value=${value || ""}
               placeholder="${placeholder}"
               ?disabled=${disabled}
               ?required=${required}
               ?aria-invalid=${!!error}
               name="${name}"
               rows="${rows}"
               cols="${cols ?? ""}"
               maxlength="${maxLength ?? ""}"
               @input=${onInput}
               @change=${onChange}
            ></textarea>
            ${error ? html `<span class="text-sm text-destructive">${error}</span>` : ""}
         </div>
      `;
});
export function Textarea(propsOrValue = "", placeholder = "", onInput, rows = 4, className = "") {
    // Check if it's a props object (has any TextareaProps properties)
    if (typeof propsOrValue === "object" && propsOrValue !== null && !Array.isArray(propsOrValue)) {
        // Check if it looks like a props object by checking for common properties
        const obj = propsOrValue;
        if ("value" in obj ||
            "placeholder" in obj ||
            "label" in obj ||
            "rows" in obj ||
            "onInput" in obj ||
            "onChange" in obj ||
            "disabled" in obj ||
            "required" in obj ||
            "error" in obj ||
            "className" in obj ||
            "id" in obj ||
            "name" in obj ||
            "maxLength" in obj ||
            "resize" in obj ||
            "cols" in obj) {
            return _Textarea(propsOrValue);
        }
    }
    // Convert to string if it's not already
    const valueStr = typeof propsOrValue === "string" ? propsOrValue : "";
    return _Textarea({ value: valueStr, placeholder, onInput, rows, className });
}
//# sourceMappingURL=Textarea.js.map