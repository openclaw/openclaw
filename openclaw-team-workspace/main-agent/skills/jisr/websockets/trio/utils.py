import sys

import trio


if sys.version_info[:2] < (3, 11):  # pragma: no cover
    from exceptiongroup import BaseExceptionGroup


__all__ = ["race_events"]


# Based on https://trio.readthedocs.io/en/stable/reference-core.html#custom-supervisors


async def jockey(event: trio.Event, cancel_scope: trio.CancelScope) -> None:
    await event.wait()
    cancel_scope.cancel()


async def race_events(*events: trio.Event) -> None:
    """
    Wait for any of the given events to be set.

    Args:
        *events: The events to wait for.

    """
    if not events:
        raise ValueError("no events provided")

    try:
        async with trio.open_nursery() as nursery:
            for event in events:
                nursery.start_soon(jockey, event, nursery.cancel_scope)
    except BaseExceptionGroup as exc:
        try:
            trio._util.raise_single_exception_from_group(exc)
        except trio._util.MultipleExceptionError:  # pragma: no cover
            raise AssertionError(
                "race_events should be canceled; please file a bug report"
            ) from exc
