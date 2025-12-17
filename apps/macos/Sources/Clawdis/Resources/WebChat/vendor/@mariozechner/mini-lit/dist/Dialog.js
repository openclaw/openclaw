import { html } from "lit";
import { i18n } from "./i18n.js";
import { fc } from "./mini.js";
// Main Dialog container
export const Dialog = fc(({ isOpen, onClose, children, width = "min(600px, 90vw)", height = "auto", className = "", backdropClassName = "bg-black/50", }) => {
    if (!isOpen)
        return html ``;
    const handleBackdropClick = (e) => {
        if (e.target === e.currentTarget) {
            onClose?.();
        }
    };
    // Add escape key handler
    const handleKeyDown = (e) => {
        if (e.key === "Escape") {
            onClose?.();
        }
    };
    // Add/remove event listener when dialog opens/closes
    if (isOpen) {
        document.addEventListener("keydown", handleKeyDown);
        // Clean up on unmount
        setTimeout(() => {
            if (!isOpen) {
                document.removeEventListener("keydown", handleKeyDown);
            }
        }, 0);
    }
    return html `
         <!-- Backdrop -->
         <div class="fixed inset-0 ${backdropClassName} z-40" @click=${handleBackdropClick}>
            <!-- Modal -->
            <div
               class="fixed z-50 bg-background rounded-lg shadow-xl flex flex-col border border-border ${className}"
               style="top: 50%; left: 50%; transform: translate(-50%, -50%); width: ${width}; height: ${height};"
               @click=${(e) => e.stopPropagation()}
            >
               ${children}

               <!-- Close button - absolutely positioned -->
               <button
                  type="button"
                  @click=${() => onClose?.()}
                  class="absolute top-4 right-4 rounded-sm text-muted-foreground opacity-70 transition-all hover:opacity-100 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background disabled:pointer-events-none cursor-pointer"
                  aria-label="${i18n("Close")}"
               >
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                     <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
               </button>
            </div>
         </div>
      `;
});
// Dialog header component
export const DialogHeader = fc(({ title, description, className = "" }) => {
    return html `
      <div class="pr-8 ${className}">
         <h2 class="text-lg font-semibold text-foreground${description ? " mb-2" : ""}">${title}</h2>
         ${description ? html `<p class="text-sm text-muted-foreground">${description}</p>` : ""}
      </div>
   `;
});
// Dialog content wrapper
export const DialogContent = fc(({ children, className = "" }) => {
    return html ` <div class="p-6 flex flex-col gap-4 ${className}">${children}</div> `;
});
// Dialog footer for action buttons
export const DialogFooter = fc(({ children, className = "" }) => {
    return html ` <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end ${className}">${children}</div> `;
});
//# sourceMappingURL=Dialog.js.map