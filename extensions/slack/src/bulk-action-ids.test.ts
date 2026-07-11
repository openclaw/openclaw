// Slack tests cover bulk action id behavior.
import { describe, expect, it } from "vitest";
import { isSlackBulkActionId } from "./bulk-action-ids.js";

describe("isSlackBulkActionId", () => {
  it.each([
    { actionId: "select_all", expected: true },
    { actionId: "deselect_all", expected: true },
    { actionId: "openclaw:select_all", expected: true },
    { actionId: "deploy_all_services", expected: false },
    { actionId: "install_all_deps", expected: false },
    { actionId: "recall_app", expected: false },
    { actionId: "approve_selected", expected: false },
    { actionId: "openclaw_cmdarg_0", expected: false },
  ])("classifies $actionId as bulk=$expected", ({ actionId, expected }) => {
    expect(isSlackBulkActionId(actionId)).toBe(expected);
  });
});
