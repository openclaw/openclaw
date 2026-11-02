# Artha Reminders

Bundled plugin that gives each WhatsApp user a `my_reminders` tool for their own
reminders and scheduled tasks. It works only in one-to-one chats. Results come
back to the same chat.

- **Reminder** (`kind=reminder`): sends the saved text back at the scheduled time.
  The scheduled turn runs with no tools.
- **Task** (`kind=task`): runs the saved instruction at the scheduled time as the
  user who created it (never as owner). Only `taskToolsAllow` tools are available,
  so DFS calls use that user's own connection.

Users manage their schedules in chat: "show my reminders" lists them with their
ids, and "delete the Monday one" removes one. Users can reach only their own
schedules.

## Configuration

The plugin is disabled by default. Settings live under
`plugins.entries.artha-reminders` in `openclaw.json`:

| Key                          | Default                       | Meaning                                                   |
| ---------------------------- | ----------------------------- | --------------------------------------------------------- |
| `enabled`                    | `false`                       | Turns the plugin on                                       |
| `config.maxSchedulesPerUser` | `50`                          | Active reminders and tasks per user, combined             |
| `config.minRepeatMinutes`    | `60`                          | Smallest allowed gap between runs of a repeating schedule |
| `config.defaultTimezone`     | `Asia/Kolkata`                | Timezone for `cron` when the user names none              |
| `config.taskToolsAllow`      | `["artha-dfs-production__*"]` | Tools a scheduled task may call                           |

In a NemoClaw sandbox, change a value from the host (this restarts the Gateway):

```bash
nemoclaw artha-assistant config set \
  --key plugins.entries.artha-reminders.config.maxSchedulesPerUser --value 50 \
  --config-accept-new-path --restart
```

Release deployments keep these values: they restore the sandbox's whole
`/sandbox/.openclaw` directory, which also holds the Cron store with users'
schedules. A manual `nemoclaw <sandbox> rebuild` does not guarantee to keep
`config set` values, so re-apply them afterwards.

## Admin: list and remove schedules

Schedules are Cron jobs named `plugin:artha-reminders:...`. From the host:

```bash
S=artha-assistant
# All reminder jobs, with their session (user) and next run.
nemoclaw $S exec --no-tty -- sh -c \
  'openclaw cron list --json | jq -c ".jobs[] | select(.name | startswith(\"plugin:artha-reminders:\")) | {id, sessionTarget, schedule, nextRunAtMs}"'
# Remove one job by id.
nemoclaw $S exec --no-tty -- openclaw cron rm <job-id>
```

## Rollback

Schedules outlive the plugin: disabling it does not stop jobs that already
exist. An OpenClaw build without this plugin also drops the requester identity
that task jobs run as. Before rolling back to such a build, remove every
reminder job **while the current build is still running**, because
`openclaw cron rm` goes through the Gateway:

```bash
S=artha-assistant
B=~/openclaw-dist-backups/reminders-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$B"
# 1. Keep a record so users can be told or their schedules recreated.
nemoclaw $S exec --no-tty -- openclaw cron list --json > "$B/cron-jobs.json"
# 2. Remove every reminder job.
for id in $(jq -r '.jobs[] | select(.name | startswith("plugin:artha-reminders:")) | .id' "$B/cron-jobs.json"); do
  nemoclaw $S exec --no-tty -- openclaw cron rm "$id"
done
# 3. Confirm none remain (prints 0).
nemoclaw $S exec --no-tty -- openclaw cron list --json \
  | jq '[.jobs[] | select(.name | startswith("plugin:artha-reminders:"))] | length'
# 4. Disable the plugin, then roll back the build and restart the Gateway.
nemoclaw $S config set --key plugins.entries.artha-reminders.enabled --value false \
  --config-accept-new-path
```
