type RelayBranch = "click-toolbar-button" | "use-current-shared-tab";

type AttachUxCopy = {
  prompt: string;
  scopeNote: string;
};

function getRelayAttachUxCopy(branch: RelayBranch): AttachUxCopy {
  if (branch === "use-current-shared-tab") {
    return {
      prompt: "Click the OpenClaw Browser Relay toolbar button on the Chrome tab you want to share, then retry on that current shared tab.",
      scopeNote: "Chrome relay is read-only in v1 and only exposes the tab currently shared through the toolbar button.",
    };
  }
  return {
    prompt: "Click the OpenClaw Browser Relay toolbar button on the Chrome tab you want to share, then retry.",
    scopeNote: "Chrome relay is read-only in v1 and only exposes the tab currently shared through the toolbar button.",
  };
}

function appendRelayUx(base: string, branch: RelayBranch): string {
  const ux = getRelayAttachUxCopy(branch);
  return `${base} ${ux.prompt} ${ux.scopeNote}`;
}

export function formatChromeRelayAttachRequiredError(profileName: string): string {
  return appendRelayUx(
    `tab not found (no attached Chrome tabs for profile "${profileName}").`,
    "click-toolbar-button",
  );
}

export function formatChromeRelayStaleTargetError(): string {
  return appendRelayUx(
    "tab not found (the requested Chrome relay target is no longer the currently shared tab).",
    "use-current-shared-tab",
  );
}
