import { html, render } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { i18n } from "./i18n.js";
let activeSelect = null;
export function Select(props) {
    const { value, placeholder = i18n("Select an option"), options, onChange, disabled = false, className = "", width = "180px", size = "md", variant = "default", fitContent = false, } = props;
    // Create refs
    const triggerRef = createRef();
    // Initialize state
    const state = {
        isOpen: false,
        focusedIndex: -1,
    };
    // Size classes
    const sizeClasses = {
        sm: "h-8 px-2 text-xs",
        md: "h-9 px-3 text-sm",
        lg: "h-10 px-4 text-base",
    };
    // Variant classes
    const variantClasses = {
        default: "text-foreground border-input bg-transparent hover:bg-accent/50 shadow-xs",
        ghost: "text-foreground border-transparent bg-transparent hover:bg-accent hover:text-accent-foreground",
        outline: "text-foreground border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
    };
    // Flatten options for easier access
    const flatOptions = [];
    const isGrouped = options.length > 0 && "options" in options[0];
    if (isGrouped) {
        options.forEach((group) => {
            flatOptions.push(...group.options.filter((opt) => !opt.disabled));
        });
    }
    else {
        flatOptions.push(...options.filter((opt) => !opt.disabled));
    }
    // Find selected option
    const selectedOption = flatOptions.find((opt) => opt.value === value);
    // Portal container
    let portalContainer = null;
    const ensurePortalContainer = () => {
        if (!portalContainer) {
            portalContainer = document.createElement("div");
            portalContainer.className = "select-portal-container";
            portalContainer.style.cssText = "position: fixed; z-index: 50; pointer-events: none;";
            document.body.appendChild(portalContainer);
        }
        return portalContainer;
    };
    const updatePosition = () => {
        if (!triggerRef.value || !portalContainer)
            return;
        const rect = triggerRef.value.getBoundingClientRect();
        state.triggerRect = rect;
        // Calculate position
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        const dropdownHeight = 300; // Max height
        const showAbove = spaceBelow < dropdownHeight && spaceAbove > spaceBelow;
        portalContainer.style.cssText = `
			position: fixed;
			left: ${rect.left}px;
			${showAbove ? `bottom: ${window.innerHeight - rect.top}px` : `top: ${rect.bottom}px`};
			min-width: ${rect.width}px;
			width: max-content;
			z-index: 50;
			pointer-events: ${state.isOpen ? "auto" : "none"};
		`;
    };
    const open = () => {
        if (disabled || state.isOpen)
            return;
        // Close any other open select
        if (activeSelect && activeSelect !== api) {
            activeSelect.close();
        }
        state.isOpen = true;
        state.focusedIndex = selectedOption ? flatOptions.indexOf(selectedOption) : 0;
        ensurePortalContainer();
        updatePosition();
        renderPortal();
        // Add listeners
        setTimeout(() => {
            document.addEventListener("click", handleOutsideClick);
            document.addEventListener("keydown", handleKeyDown);
            window.addEventListener("scroll", updatePosition, true);
            window.addEventListener("resize", updatePosition);
        }, 0);
        activeSelect = api;
        // Re-render trigger to update aria-expanded
        if (triggerRef.value) {
            triggerRef.value.setAttribute("aria-expanded", "true");
        }
    };
    const close = () => {
        if (!state.isOpen)
            return;
        state.isOpen = false;
        state.focusedIndex = -1;
        // Remove listeners
        document.removeEventListener("click", handleOutsideClick);
        document.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("scroll", updatePosition, true);
        window.removeEventListener("resize", updatePosition);
        // Clear portal
        if (portalContainer) {
            render(html ``, portalContainer);
        }
        if (activeSelect === api) {
            activeSelect = null;
        }
        // Re-render trigger to update aria-expanded
        if (triggerRef.value) {
            triggerRef.value.setAttribute("aria-expanded", "false");
            triggerRef.value.focus();
        }
    };
    const handleOutsideClick = (e) => {
        const target = e.target;
        if (triggerRef.value?.contains(target) || portalContainer?.contains(target)) {
            return;
        }
        close();
    };
    const handleKeyDown = (e) => {
        if (!state.isOpen)
            return;
        switch (e.key) {
            case "Escape":
                e.preventDefault();
                close();
                break;
            case "ArrowDown":
                e.preventDefault();
                state.focusedIndex = Math.min(state.focusedIndex + 1, flatOptions.length - 1);
                renderPortal();
                break;
            case "ArrowUp":
                e.preventDefault();
                state.focusedIndex = Math.max(state.focusedIndex - 1, 0);
                renderPortal();
                break;
            case "Enter":
            case " ":
                e.preventDefault();
                if (state.focusedIndex >= 0 && state.focusedIndex < flatOptions.length) {
                    selectOption(flatOptions[state.focusedIndex].value);
                }
                break;
            case "Home":
                e.preventDefault();
                state.focusedIndex = 0;
                renderPortal();
                break;
            case "End":
                e.preventDefault();
                state.focusedIndex = flatOptions.length - 1;
                renderPortal();
                break;
        }
    };
    const selectOption = (optionValue) => {
        onChange(optionValue);
        close();
    };
    const renderPortal = () => {
        if (!portalContainer || !state.isOpen)
            return;
        const dropdownContent = html `
         <div
            class="border border-border bg-popover text-popover-foreground shadow-md rounded-md overflow-hidden animate-in fade-in-0 zoom-in-95"
            role="listbox"
            style="max-height: 300px; overflow-y: auto;"
         >
            <div class="p-1">
               ${isGrouped
            ? options.map((group, _groupIndex) => html `
                          <div role="group">
                             ${group.label
                ? html `
                                     <div class="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                                        ${group.label}
                                     </div>
                                  `
                : ""}
                             ${group.options.map((option, _optionIndex) => {
                const globalIndex = flatOptions.indexOf(option);
                const isFocused = globalIndex === state.focusedIndex;
                const isSelected = option.value === value;
                return html `
                                   <div
                                      role="option"
                                      aria-selected=${isSelected}
                                      data-disabled=${option.disabled || false}
                                      tabindex="-1"
                                      class="relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none transition-colors
												${isFocused ? "bg-accent text-accent-foreground" : ""}
												${option.disabled ? "pointer-events-none opacity-50" : "hover:bg-accent hover:text-accent-foreground"}
												${isSelected ? "font-medium" : ""}"
                                      @click=${option.disabled ? null : () => selectOption(option.value)}
                                      @mouseenter=${() => {
                    if (!option.disabled) {
                        state.focusedIndex = globalIndex;
                        renderPortal();
                    }
                }}
                                   >
                                      <span class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                                         ${isSelected
                    ? html `
                                                 <svg
                                                    class="h-4 w-4"
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                 >
                                                    <polyline points="20 6 9 17 4 12"></polyline>
                                                 </svg>
                                              `
                    : ""}
                                      </span>
                                      ${option.icon ? html `<span class="flex-shrink-0">${option.icon}</span>` : ""}
                                      <span>${option.label}</span>
                                   </div>
                                `;
            })}
                          </div>
                       `)
            : options.map((option, index) => {
                const isFocused = index === state.focusedIndex;
                const isSelected = option.value === value;
                return html `
                          <div
                             role="option"
                             aria-selected=${isSelected}
                             data-disabled=${option.disabled || false}
                             tabindex="-1"
                             class="relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none transition-colors
										${isFocused ? "bg-accent text-accent-foreground" : ""}
										${option.disabled ? "pointer-events-none opacity-50" : "hover:bg-accent hover:text-accent-foreground"}
										${isSelected ? "font-medium" : ""}"
                             @click=${option.disabled ? null : () => selectOption(option.value)}
                             @mouseenter=${() => {
                    if (!option.disabled) {
                        state.focusedIndex = index;
                        renderPortal();
                    }
                }}
                          >
                             <span class="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
                                ${isSelected
                    ? html `
                                        <svg
                                           class="h-4 w-4"
                                           xmlns="http://www.w3.org/2000/svg"
                                           viewBox="0 0 24 24"
                                           fill="none"
                                           stroke="currentColor"
                                           stroke-width="2"
                                           stroke-linecap="round"
                                           stroke-linejoin="round"
                                        >
                                           <polyline points="20 6 9 17 4 12"></polyline>
                                        </svg>
                                     `
                    : ""}
                             </span>
                             ${option.icon ? html `<span class="flex-shrink-0">${option.icon}</span>` : ""}
                             <span>${option.label}</span>
                          </div>
                       `;
            })}
            </div>
         </div>
      `;
        render(dropdownContent, portalContainer);
    };
    const api = { close };
    const handleTriggerClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.isOpen) {
            close();
        }
        else {
            open();
        }
    };
    // Calculate dynamic width if fitContent is enabled
    const buttonWidth = fitContent ? "auto" : width;
    const minWidth = fitContent ? width || "auto" : undefined;
    // Trigger button
    return html `
      <button
         ${ref(triggerRef)}
         type="button"
         role="combobox"
         aria-expanded=${state.isOpen}
         aria-haspopup="listbox"
         aria-autocomplete="none"
         ?disabled=${disabled}
         @click=${handleTriggerClick}
         class="flex items-center justify-between gap-2 rounded-md border whitespace-nowrap transition-[color,box-shadow] outline-none
				focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
				disabled:cursor-not-allowed disabled:opacity-50
				data-[placeholder]:text-muted-foreground
				${sizeClasses[size]} ${variantClasses[variant]} ${className}"
         style="width: ${buttonWidth}; ${minWidth ? `min-width: ${minWidth};` : ""}"
      >
         <span class="flex items-center gap-2 truncate">
            ${selectedOption?.icon ? html `<span class="flex-shrink-0">${selectedOption.icon}</span>` : ""}
            ${selectedOption ? selectedOption.label : placeholder}
         </span>
         <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="h-4 w-4 opacity-50 flex-shrink-0"
         >
            <path d="m6 9 6 6 6-6"></path>
         </svg>
      </button>
   `;
}
//# sourceMappingURL=Select.js.map