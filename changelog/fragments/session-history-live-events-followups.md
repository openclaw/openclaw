### Fixes

- Gateway/session history: return `404` for unknown session history lookups, unsubscribe session lifecycle listeners during shutdown, add coverage for the new transcript and lifecycle helpers, and tighten session history plus live transcript tests so the Control UI session surfaces stay stable under restart and follow mode.
