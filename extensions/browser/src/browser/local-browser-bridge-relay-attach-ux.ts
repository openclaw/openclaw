import { interpretBrowserAttachUxFromError } from "local-browser-bridge";
import type { ResolvedBrowserProfile } from "./config.js";

type RelayBranch = "click-toolbar-button" | "use-current-shared-tab";

export function isLocalBrowserBridgeRelayProfile(profile: ResolvedBrowserProfile): boolean {
  return (
    profile.relayAttachUx?.provider === "local-browser-bridge" &&
    profile.relayAttachUx.mode === "relay" &&
    profile.relayAttachUx.sharedTabScope === "current-shared-tab"
  );
}

function appendRelayUx(base: string, branch: RelayBranch): string {
  const ux = interpretBrowserAttachUxFromError({
    details: {
      context: {
        browser: "chrome",
        attachMode: "relay",
        operation: "attach",
      },
      relay: {
        branch,
        retryable: true,
        userActionRequired: true,
        phase: "target-selection",
        sharedTabScope: "current-shared-tab",
        currentSharedTabMatches: branch === "use-current-shared-tab",
      },
    },
  });
  const details = [ux?.prompt, ux?.scopeNote].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return details.length > 0 ? `${base} ${details.join(" ")}` : base;
}

export function formatLocalBrowserBridgeRelayAttachRequiredError(profileName: string): string {
  return appendRelayUx(
    `tab not found (no attached Chrome tabs for profile "${profileName}").`,
    "click-toolbar-button",
  );
}

export function formatLocalBrowserBridgeRelayStaleTargetError(): string {
  return appendRelayUx(
    "tab not found (the requested Chrome relay target is no longer the currently shared tab).",
    "use-current-shared-tab",
  );
}
