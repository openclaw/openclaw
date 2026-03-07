from __future__ import annotations


class WebhookAuthError(Exception):
    pass


class KillSwitchEnabledError(Exception):
    pass


class ReadOnlyError(Exception):
    pass
