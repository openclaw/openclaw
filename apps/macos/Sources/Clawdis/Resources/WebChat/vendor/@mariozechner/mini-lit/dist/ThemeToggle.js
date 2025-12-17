var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Monitor, Moon, Sun } from "lucide";
import { Button } from "./Button.js";
import { icon } from "./icons.js";
// Apply theme to document
function applyTheme() {
    const theme = localStorage.getItem("theme") || "system";
    const effectiveTheme = theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
    document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
}
// Initialize theme on load
if (typeof window !== "undefined") {
    applyTheme();
    // Listen for system theme changes
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        const theme = localStorage.getItem("theme");
        if (!theme || theme === "system") {
            applyTheme();
        }
    });
}
let ThemeToggle = class ThemeToggle extends LitElement {
    constructor() {
        super(...arguments);
        this.includeSystem = false;
        this.theme = (typeof window !== "undefined" ? localStorage.getItem("theme") : null) || "system";
    }
    setTheme(theme) {
        this.theme = theme;
        if (theme === "system") {
            localStorage.removeItem("theme");
        }
        else {
            localStorage.setItem("theme", theme);
        }
        applyTheme();
    }
    cycleTheme() {
        const themes = this.includeSystem ? ["light", "dark", "system"] : ["light", "dark"];
        // If current theme is system but we're not including it, default to light
        let currentTheme = this.theme;
        if (!this.includeSystem && currentTheme === "system") {
            currentTheme = "light";
        }
        const currentIndex = themes.indexOf(currentTheme);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % themes.length;
        this.setTheme(themes[nextIndex]);
    }
    getIcon() {
        switch (this.theme) {
            case "light":
                return icon(Sun, "md");
            case "dark":
                return icon(Moon, "md");
            case "system":
                return icon(Monitor, "md");
        }
    }
    // Remove shadow DOM for consistent styling
    createRenderRoot() {
        return this;
    }
    render() {
        return html `
         ${Button({
            variant: "ghost",
            size: "icon",
            onClick: () => this.cycleTheme(),
            children: this.getIcon(),
        })}
      `;
    }
};
__decorate([
    property({ type: Boolean })
], ThemeToggle.prototype, "includeSystem", void 0);
__decorate([
    state()
], ThemeToggle.prototype, "theme", void 0);
ThemeToggle = __decorate([
    customElement("theme-toggle")
], ThemeToggle);
export { ThemeToggle };
//# sourceMappingURL=ThemeToggle.js.map