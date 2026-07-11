// Slack tests cover bulk action id behavior.
import { describe, expect, it } from "vitest";
import {
  buildOpenClawBulkActionsBlock,
  isOpenClawBulkActionId,
  isOpenClawBulkActionsBlock,
  OPENCLAW_SLACK_BULK_ACTION_IDS,
  SLACK_BULK_ACTIONS_BLOCK_ID_PREFIX,
  SLACK_BULK_DESELECT_ALL_ACTION_ID,
  SLACK_BULK_SELECT_ALL_ACTION_ID,
} from "./bulk-action-ids.js";

describe("OpenClaw bulk action contract", () => {
  it("defines a closed OpenClaw-owned action-id set", () => {
    expect([...OPENCLAW_SLACK_BULK_ACTION_IDS]).toEqual([
      SLACK_BULK_SELECT_ALL_ACTION_ID,
      SLACK_BULK_DESELECT_ALL_ACTION_ID,
    ]);
  });

  it.each([
    { actionId: SLACK_BULK_SELECT_ALL_ACTION_ID, expected: true },
    { actionId: SLACK_BULK_DESELECT_ALL_ACTION_ID, expected: true },
    { actionId: "select_all", expected: false },
    { actionId: "deselect_all", expected: false },
    { actionId: "deploy_all_services", expected: false },
    { actionId: "install_all_deps", expected: false },
    { actionId: "archive_all", expected: false },
    { actionId: "openclaw_cmdarg_0", expected: false },
  ])("classifies $actionId as OpenClaw bulk=$expected", ({ actionId, expected }) => {
    expect(isOpenClawBulkActionId(actionId)).toBe(expected);
  });

  it("builds a producer-owned bulk actions block", () => {
    const block = buildOpenClawBulkActionsBlock();
    expect(block.block_id).toBe(`${SLACK_BULK_ACTIONS_BLOCK_ID_PREFIX}actions`);
    expect(block.elements.map((element) => element.action_id)).toEqual([
      SLACK_BULK_SELECT_ALL_ACTION_ID,
      SLACK_BULK_DESELECT_ALL_ACTION_ID,
    ]);
    expect(isOpenClawBulkActionsBlock(block)).toBe(true);
  });

  it("rejects generic rows even when action IDs end with _all", () => {
    expect(
      isOpenClawBulkActionsBlock({
        type: "actions",
        block_id: "custom_bulk_row",
        elements: [{ action_id: "archive_all" }, { action_id: "restore_all" }],
      }),
    ).toBe(false);
  });

  it("rejects rows with the marker but non-OpenClaw action IDs", () => {
    expect(
      isOpenClawBulkActionsBlock({
        type: "actions",
        block_id: `${SLACK_BULK_ACTIONS_BLOCK_ID_PREFIX}actions`,
        elements: [{ action_id: "select_all" }, { action_id: "deselect_all" }],
      }),
    ).toBe(false);
  });
});
