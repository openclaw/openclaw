import type { CodexNativeController } from "./controller.js";

let activeController: CodexNativeController | null = null;

export function setActiveCodexController(controller: CodexNativeController): void {
  activeController = controller;
}

export function clearActiveCodexController(controller?: CodexNativeController): void {
  if (!controller || activeController === controller) {
    activeController = null;
  }
}

export function getActiveCodexController(): CodexNativeController | null {
  return activeController;
}
