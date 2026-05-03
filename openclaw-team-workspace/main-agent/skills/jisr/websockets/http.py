from __future__ import annotations

import warnings

from .datastructures import Headers, MultipleValuesError  # noqa: F401


with warnings.catch_warnings():
    # Suppress redundant DeprecationWarning raised by websockets.legacy.
    warnings.filterwarnings("ignore", category=DeprecationWarning)
    from .legacy.http import read_request, read_response  # noqa: F401


warnings.warn(  # deprecated in 9.0 - 2021-09-01
    "Headers and MultipleValuesError were moved "
    "from websockets.http to websockets.datastructures"
    "and read_request and read_response were moved "
    "from websockets.http to websockets.legacy.http",
    DeprecationWarning,
)
