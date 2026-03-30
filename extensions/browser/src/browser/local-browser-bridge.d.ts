declare module "local-browser-bridge" {
  export type SupportedBrowser = "safari" | "chrome";
  export type BrowserAttachMode = "direct" | "relay";
  export type ChromeRelayFailureOperation = "attach" | "resumeSession";
  export type ChromeRelayFailureBranch =
    | "click-toolbar-button"
    | "share-tab"
    | "share-original-tab-again"
    | "use-current-shared-tab"
    | "install-extension"
    | "reconnect-extension"
    | "configure-relay-probe"
    | "repair-relay-probe"
    | "unsupported";
  export interface ChromeRelayErrorDetails {
    context: {
      browser: "chrome";
      attachMode: "relay";
      operation: ChromeRelayFailureOperation;
    };
    relay: {
      branch: ChromeRelayFailureBranch;
      retryable: boolean;
      userActionRequired: boolean;
      phase: "diagnostics" | "target-selection" | "session-precondition" | "shared-tab-match";
      sharedTabScope: "current-shared-tab";
      currentSharedTabMatches?: boolean;
      resumable?: boolean;
      resumeRequiresUserGesture?: boolean;
      expiresAt?: string;
      sessionId?: string;
    };
  }
  export interface BrowserAttachUxInterpretation {
    prompt: string | undefined;
    scopeNote: string | undefined;
    readOnly: boolean;
    sharedTabScoped: boolean;
  }
  export function interpretBrowserAttachUxFromError(args: {
    details: ChromeRelayErrorDetails | Pick<ChromeRelayErrorDetails, "relay"> | null | undefined;
    browser?: SupportedBrowser;
    attachMode?: BrowserAttachMode;
    operation?: ChromeRelayFailureOperation;
  }): BrowserAttachUxInterpretation | undefined;
}
