import type { AppMode, UsageVariant } from "./types";

export class AppState {
  private static instance: AppState;

  private _mode: AppMode = "use";
  private _variant: UsageVariant = "native";
  private listeners: Set<() => void> = new Set();

  private constructor() {
    this.loadFromStorage();
    this.loadFromUrl();
  }

  static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState();
    }
    return AppState.instance;
  }

  get mode(): AppMode {
    return this._mode;
  }

  get variant(): UsageVariant {
    return this._variant;
  }

  setMode(mode: AppMode): void {
    if (this._mode !== mode) {
      this._mode = mode;
      this.saveToStorage();
      this.notify();
    }
  }

  setVariant(variant: UsageVariant): void {
    if (this._variant !== variant) {
      this._variant = variant;
      this.saveToStorage();
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach(listener => listener());
  }

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem("openclaw:app-state");
      if (stored) {
        const data = JSON.parse(stored);
        if (data.mode === "use" || data.mode === "control") {
          this._mode = data.mode;
        }
        if (["native", "mission", "star", "blank"].includes(data.variant)) {
          this._variant = data.variant;
        }
      }
    } catch {
      // Ignore storage errors
    }
  }

  private loadFromUrl(): void {
    try {
      const url = new URL(window.location.href);
      const mode = url.searchParams.get("mode");
      const variant = url.searchParams.get("variant");
      const agentView = url.searchParams.get("agentView");

      if (mode === "use" || mode === "control") {
        this._mode = mode;
      }
      if (variant === "native" || variant === "mission" || variant === "star" || variant === "blank") {
        this._variant = variant;
      }
      if (agentView === "1") {
        this._mode = "control";
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem("openclaw:app-state", JSON.stringify({
        mode: this._mode,
        variant: this._variant,
      }));
    } catch {
      // Ignore storage errors
    }
  }
}
