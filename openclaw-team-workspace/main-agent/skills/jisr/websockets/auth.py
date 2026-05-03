from __future__ import annotations

import warnings


with warnings.catch_warnings():
    # Suppress redundant DeprecationWarning raised by websockets.legacy.
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    from .legacy.auth import *
    from .legacy.auth import __all__  # noqa: F401


warnings.warn(  # deprecated in 14.0 - 2024-11-09
    "websockets.auth, an alias for websockets.legacy.auth, is deprecated; "
    "see https://websockets.readthedocs.io/en/stable/howto/upgrade.html "
    "for upgrade instructions",
    DeprecationWarning,
)
