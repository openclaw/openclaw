---
name: apple-reminders
description: Manage Apple Reminders via the `memo` CLI on macOS (create, complete, and delete reminders). Use when a user asks Clawdis to add a reminder, mark reminders as done, or manage their reminder list.
homepage: https://github.com/antoniorodr/memo
metadata: {"clawdis":{"emoji":"⏰","os":["darwin"],"requires":{"bins":["memo"]},"install":[{"id":"brew","kind":"brew","formula":"antoniorodr/memo/memo","bins":["memo"],"label":"Install memo via Homebrew"}]}}
---

# Apple Reminders CLI

Use `memo rem` to manage Apple Reminders directly from the terminal. Create, complete, and delete reminders with simple commands.

Setup
- Install (Homebrew): `brew tap antoniorodr/memo && brew install antoniorodr/memo/memo`
- Manual (pip): `pip install .` (after cloning the repo)
- macOS-only; if prompted, grant Automation access to Reminders.app.

View Reminders
- List all reminders: `memo rem`

Create Reminders
- Add a new reminder: `memo rem -a`
  - Opens interactive prompt to create a reminder.
- Quick add: `memo rem -a "Buy groceries"`

Complete Reminders
- Mark reminder as done: `memo rem -c`
  - Interactive selection of reminder to complete.

Delete Reminders
- Delete a reminder: `memo rem -d`
  - Interactive selection of reminder to delete.

Examples
- Add a quick reminder: `memo rem -a "Call dentist tomorrow"`
- List all reminders: `memo rem`
- Complete a reminder: `memo rem -c` (then select from list)
- Delete a reminder: `memo rem -d` (then select from list)

Notes
- macOS-only.
- Requires Apple Reminders.app to be accessible.
- For automation, grant permissions in System Settings > Privacy & Security > Automation.
- The `memo` CLI shares the same installation for both Notes and Reminders functionality.
