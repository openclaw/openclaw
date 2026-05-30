---
"openclaw": patch
---

cron: make the isolated-agent setup watchdog configurable via
`cron.agentSetupWatchdogMs`.

The setup watchdog (previously a hardcoded 60s) aborts an isolated agent cron
job that does not reach "runner started" in time. When several heavy isolated
jobs start in the same window, concurrent setup contends on the single gateway
event loop and a healthy agent can exceed 60s during setup — producing false
`isolated agent setup timed out before runner start` failures even on idle,
high-spec hosts. The value now defaults to 60000ms and honours an optional
override, clamped to a 1000ms minimum so the safety timer cannot be disabled.
