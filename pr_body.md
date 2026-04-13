## Summary

This PR adds support for custom job IDs in the `openclaw cron add` command, addressing issue #65636.

## Changes

- **CLI**: Added optional `--id` flag to `openclaw cron add` for human-readable job IDs
- **Validation**: Custom IDs must be slug-like strings (lowercase alphanumeric, hyphens, underscores, 2-100 chars)
- **Collision Detection**: Rejects duplicate custom IDs with clear error message
- **Backward Compatibility**: Generates UUID when `--id` is not provided (preserves existing behavior)
- **Type System**: Updated `CronJobCreate` type to include optional `id` field
- **Testing**: Added comprehensive test coverage for custom ID functionality

## Example Usage

Create job with custom ID:
openclaw cron add --id daily-brief --name "Daily Brief" --every 24h --message "Generate daily brief"

Use custom ID in other commands:
openclaw cron edit daily-brief --no-deliver
openclaw cron run daily-brief
openclaw cron runs --id daily-brief

## Testing

All tests pass:
- Custom ID creation
- UUID generation when ID not provided
- Duplicate ID rejection
- Multiple jobs with different custom IDs
- Slug-like ID format validation

Fixes #65636
