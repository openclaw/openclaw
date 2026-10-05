import type { Page, Request } from "playwright-core";

type BrowserDocumentNavigationRequestKind = "top-level" | "subframe";

/** Classify requests that can navigate the selected page or one of its frames. */
export function classifyBrowserDocumentNavigationRequest(
  page: Page,
  request: Request,
): BrowserDocumentNavigationRequestKind | null {
  let kind: BrowserDocumentNavigationRequestKind;
  let frameResolutionFailed = false;
  try {
    kind = request.frame() === page.mainFrame() ? "top-level" : "subframe";
  } catch {
    // Preserve the navigate-owner fail-closed contract during renderer churn:
    // an unresolved document request may be the selected main frame.
    kind = "top-level";
    frameResolutionFailed = true;
  }

  try {
    if (request.isNavigationRequest()) {
      return kind;
    }
  } catch {
    // Fall through to the resource-type check.
  }

  try {
    if (request.resourceType() === "document") {
      return kind;
    }
  } catch {
    // Fall through to the unresolved-frame result below.
  }
  // Match the previous two-step classifier: known non-doc requests fall
  // through, while an unresolved frame remains guarded as a subframe.
  return frameResolutionFailed ? "subframe" : null;
}
