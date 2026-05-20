# OpenClaw Business-Critical Recovery Manifest

Generated: 2026-05-20 America/Detroit

Clean base: `upstream/main 9c5e8eb4950e799efbf5a366e9015cc71ed5f72f`

Recovery branch head at generation: `ad067f29534abc38b290732aafb302b7c35da74d`

This manifest lists the recovered files committed on the clean recovery worktree. It intentionally excludes the original dirty recovery tree except for named Git object evidence.

## Commit Slices

- `33f10cc2af feat(gesahni): restore stock-room plugin` restored `extensions/gesahni/**`, Gesahni Discord plan docs, lockfile wiring, and changelog.
- `ad067f2953 feat(gesahni): restore bridge roles and shopify ops` restored `.openclaw` bridge/role plugins, Shopify ops, command skills, bridge scripts, symlinks, tests, lockfile wiring, and a non-secret operator orchestration doc.

## Bucket Counts

| bucket                      | files |
| --------------------------- | ----: |
| docs_tests_config_wiring    |     2 |
| gesahni_bridge_role_plugins |    37 |
| gesahni_current_plugin      |    15 |
| gesahni_tests_and_scripts   |     7 |
| market_command_skills       |    25 |
| shopify_inventory_ops       |     5 |

## Restored Files

| bucket                      | status | source                                      | path                                                           |
| --------------------------- | ------ | ------------------------------------------- | -------------------------------------------------------------- |
| gesahni_bridge_role_plugins | A      | recovery-authored non-secret role doc       | `.openclaw/agents/gesahni-operator/ORCHESTRATION.md`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/index.test.ts`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/index.ts`                |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/openclaw.plugin.json`    |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/package.json`            |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/src/client.ts`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/src/config.ts`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-builder/src/tools.ts`            |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be + recovery test/order adaptation | `.openclaw/extensions/gesahni-operator/index.test.ts`          |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-operator/index.ts`               |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-operator/openclaw.plugin.json`   |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-operator/package.json`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-operator/src/client.ts`          |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-operator/src/config.ts`          |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be + recovery test/order adaptation | `.openclaw/extensions/gesahni-operator/src/tools.ts`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/index.test.ts`        |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/index.ts`             |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/openclaw.plugin.json` |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/package.json`         |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/src/client.ts`        |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/src/config.ts`        |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-researcher/src/tools.ts`         |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be + oxfmt                          | `.openclaw/extensions/gesahni-reviewer/index.test.ts`          |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-reviewer/index.ts`               |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-reviewer/openclaw.plugin.json`   |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-reviewer/package.json`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-reviewer/src/client.ts`          |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni-reviewer/src/config.ts`          |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be + oxfmt                          | `.openclaw/extensions/gesahni-reviewer/src/tools.ts`           |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni/gesahni.ts`                      |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni/index.ts`                        |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `.openclaw/extensions/gesahni/openclaw.plugin.json`            |
| shopify_inventory_ops       | A      | 4f39f3f4be                                  | `.openclaw/extensions/shopify/index.ts`                        |
| shopify_inventory_ops       | A      | 4f39f3f4be                                  | `.openclaw/extensions/shopify/openclaw.plugin.json`            |
| shopify_inventory_ops       | A      | 4f39f3f4be                                  | `.openclaw/extensions/shopify/shopify.ts`                      |
| docs_tests_config_wiring    | M      | recovery wiring                             | `CHANGELOG.md`                                                 |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `docs/gesahni-discord-v1-plan.md`                              |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `docs/gesahni-discord-v2-alerts-plan.md`                       |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `extensions/gesahni-builder`                                   |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `extensions/gesahni-operator`                                  |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `extensions/gesahni-researcher`                                |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `extensions/gesahni-reviewer`                                  |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/index.test.ts`                             |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/index.ts`                                  |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/openclaw.plugin.json`                      |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/package.json`                              |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/alert-runner.test.ts`                  |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/alert-runner.ts`                       |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/alerts.ts`                             |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/charts.ts`                             |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/config.ts`                             |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/market-data.test.ts`                   |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/market-data.ts`                        |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/src/options.ts`                            |
| gesahni_current_plugin      | A      | 4f39f3f4be                                  | `extensions/gesahni/tsconfig.json`                             |
| docs_tests_config_wiring    | M      | recovery wiring                             | `pnpm-lock.yaml`                                               |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `scripts/gesahni-operator-researcher-live-loop.sh`             |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `scripts/verify-gesahni-bridge.sh`                             |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/alert_create/SKILL.md`                                 |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/alert_delete/SKILL.md`                                 |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/alert_update/SKILL.md`                                 |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/alert-history/SKILL.md`                                |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/alerts/SKILL.md`                                       |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/chain/SKILL.md`                                        |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/earnings-coverage/SKILL.md`                            |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/earnings-reminders/SKILL.md`                           |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/earnings/SKILL.md`                                     |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/gesahni_confirm/SKILL.md`                              |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/option-alerts/SKILL.md`                                |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options_alert_suggestion_apply/SKILL.md`               |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options_alert_suggestions_apply_all/SKILL.md`          |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options_watch_rule_create/SKILL.md`                    |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options_watch_rule_delete/SKILL.md`                    |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options_watch_rule_update/SKILL.md`                    |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options-status/SKILL.md`                               |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/options/SKILL.md`                                      |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/portfolio/SKILL.md`                                    |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/positions/SKILL.md`                                    |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/quote/SKILL.md`                                        |
| shopify_inventory_ops       | A      | 4f39f3f4be                                  | `skills/shopify_ops/SKILL.md`                                  |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/summary/SKILL.md`                                      |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/watchlist_add/SKILL.md`                                |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/watchlist_remove/SKILL.md`                             |
| market_command_skills       | A      | 4f39f3f4be                                  | `skills/watchlist/SKILL.md`                                    |
| gesahni_bridge_role_plugins | A      | 4f39f3f4be                                  | `src/auto-reply/gesahni-bridge.ts`                             |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `test/gesahni-audit.test.ts`                                   |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `test/gesahni-market-routing.test.ts`                          |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `test/gesahni-tool-audit.test.ts`                              |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `test/gesahni-verify-bridge-script.test.ts`                    |
| gesahni_tests_and_scripts   | A      | 4f39f3f4be                                  | `test/gesahni-workspace-plugin.test.ts`                        |
| shopify_inventory_ops       | A      | 4f39f3f4be                                  | `test/shopify-workspace-plugin.test.ts`                        |

## Discord Comparison Decision

The `fbe17a5d00` Discord extraction was compared against current `upstream/main`. Upstream already contains the modern `extensions/discord/**` plugin and later Discord fixes, so the recovery branch does not overwrite upstream Discord.

| classification                            | path                                                                  | decision                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| not_restored_local_only_discord_candidate | `extensions/discord/src/monitor/access-groups.ts`                     | not restored; upstream has shared access-group and command-gating support plus Discord docs     |
| not_restored_local_only_discord_candidate | `extensions/discord/src/monitor/message-handler.dm-preflight.test.ts` | not restored; upstream keeps newer DM preflight implementation and broader Discord tests        |
| not_restored_local_only_discord_candidate | `src/plugin-sdk/discord-send.ts`                                      | not restored; upstream Discord send result helpers live under the extension runtime/API surface |

Discord files inspected from `fbe17a5d00`: 527. Local-only candidates not restored: 3.

## Validation Proof

- `pnpm exec oxfmt --check --threads=1 extensions/gesahni/index.ts extensions/gesahni/index.test.ts extensions/gesahni/src/alert-runner.ts extensions/gesahni/src/alert-runner.test.ts extensions/gesahni/src/alerts.ts extensions/gesahni/src/charts.ts extensions/gesahni/src/config.ts extensions/gesahni/src/market-data.ts extensions/gesahni/src/market-data.test.ts extensions/gesahni/src/options.ts` passed.
- `pnpm test extensions/gesahni/index.test.ts extensions/gesahni/src/alert-runner.test.ts extensions/gesahni/src/market-data.test.ts` passed: 3 files, 29 tests.
- `pnpm test extensions/gesahni-builder/index.test.ts extensions/gesahni-operator/index.test.ts extensions/gesahni-researcher/index.test.ts extensions/gesahni-reviewer/index.test.ts` passed: 4 files, 60 tests.
- `pnpm test test/gesahni-workspace-plugin.test.ts test/shopify-workspace-plugin.test.ts test/gesahni-audit.test.ts test/gesahni-tool-audit.test.ts test/gesahni-market-routing.test.ts test/gesahni-verify-bridge-script.test.ts` passed: unit-fast 1 file/1 test plus tooling 5 files/160 tests.
