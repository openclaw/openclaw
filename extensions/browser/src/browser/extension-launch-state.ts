import type { BrowserExtensionRequest } from "openclaw/plugin-sdk/browser-extension-host";

/** Validated launch declaration; identity is retained on the launched process. */
export type ExtensionDeclaration = BrowserExtensionRequest & {
  version: string;
  workerPath: string;
  /** Opaque runtime identity, compared by reference only; launch does not inspect server state. */
  ownerState: object;
};

export const extensionDeclarations = new Map<string, ExtensionDeclaration>();
