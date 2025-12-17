import { fc, html } from "./mini.js";
export const Button = fc(({ variant = "default", size = "md", disabled = false, type = "button", loading = false, onClick, title, className = "", children, }) => {
    const sizeClasses = {
        sm: "h-8 rounded-md px-3 text-xs",
        md: "h-9 rounded-md px-4 text-sm",
        lg: "h-10 rounded-md px-8 text-sm",
        icon: "size-8 rounded-md",
    };
    const variantClasses = {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        outline: "border border-input bg-background text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
    };
    const baseClasses = "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium transition-all cursor-pointer disabled:cursor-not-allowed disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive";
    const gapClass = size === "icon" ? "" : "gap-2";
    const paddingAdjustClass = size === "icon" ? "" : "has-[>svg]:px-2.5";
    const variantClass = variantClasses[variant] || variantClasses.default;
    const handleClick = (e) => {
        if (disabled || loading) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        onClick?.(e);
    };
    return html `
         <button
            type="${type}"
            class="${baseClasses} ${sizeClasses[size]} ${variantClass} ${gapClass} ${paddingAdjustClass} ${className}"
            ?disabled=${disabled || loading}
            @click=${handleClick}
            title="${title || ""}"
         >
            ${loading
        ? html `
                    <svg class="animate-spin" fill="none" viewBox="0 0 24 24">
                       <circle
                          class="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          stroke-width="4"
                       ></circle>
                       <path
                          class="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                       ></path>
                    </svg>
                 `
        : ""}
            ${children}
         </button>
      `;
});
//# sourceMappingURL=Button.js.map