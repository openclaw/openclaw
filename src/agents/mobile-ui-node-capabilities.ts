import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { NodeListNode } from "../shared/node-list-types.js";

export const MOBILE_UI_OBSERVE_COMMAND = "mobile.ui.observe";
export const MOBILE_UI_ACT_COMMAND = "mobile.ui.act";
export const MOBILE_UI_CAPABILITY = "mobileUI";

/** Listing support is independent of whether the paired Android device is online. */
export function supportsMobileUiNode(node: NodeListNode): boolean {
  return (
    (normalizeOptionalLowercaseString(node.platform) ?? "").startsWith("android") &&
    (node.caps ?? []).some(
      (capability) => normalizeOptionalLowercaseString(capability) === "mobileui",
    ) &&
    (node.commands ?? []).includes(MOBILE_UI_OBSERVE_COMMAND) &&
    (node.commands ?? []).includes(MOBILE_UI_ACT_COMMAND)
  );
}
