import type { Component, TUI } from "@mariozechner/pi-tui";
type OverlayHost = Pick<TUI, "showOverlay" | "hideOverlay" | "hasOverlay" | "setFocus">;
export declare function createOverlayHandlers(host: OverlayHost, fallbackFocus: Component): {
    openOverlay: (component: Component) => void;
    closeOverlay: () => void;
};
export {};
