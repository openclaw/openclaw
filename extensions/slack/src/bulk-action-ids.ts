// Slack plugin module implements bulk action id behavior.
/**
 * Bulk-select Slack controls (for example `select_all` / `deselect_all`) use action IDs
 * ending with this suffix. The suffix is intentionally `_all` without a trailing
 * underscore so IDs like `deploy_all_services` are not treated as bulk rows.
 */
export const SLACK_BULK_ACTION_ID_SUFFIX = "_all";

export function isSlackBulkActionId(actionId: string): boolean {
  return actionId.endsWith(SLACK_BULK_ACTION_ID_SUFFIX);
}
