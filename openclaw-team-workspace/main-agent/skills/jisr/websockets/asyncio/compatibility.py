from __future__ import annotations

import sys


__all__ = ["TimeoutError", "aiter", "anext", "asyncio_timeout", "asyncio_timeout_at"]


if sys.version_info[:2] >= (3, 11):
    TimeoutError = TimeoutError
    aiter = aiter
    anext = anext
    from asyncio import (
        timeout as asyncio_timeout,  # noqa: F401
        timeout_at as asyncio_timeout_at,  # noqa: F401
    )

else:  # Python < 3.11
    from asyncio import TimeoutError

    def aiter(async_iterable):
        return type(async_iterable).__aiter__(async_iterable)

    async def anext(async_iterator):
        return await type(async_iterator).__anext__(async_iterator)

    from .async_timeout import (
        timeout as asyncio_timeout,  # noqa: F401
        timeout_at as asyncio_timeout_at,  # noqa: F401
    )
