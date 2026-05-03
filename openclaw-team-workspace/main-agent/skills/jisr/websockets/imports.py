from __future__ import annotations

import warnings
from collections.abc import Iterable
from typing import Any


__all__ = ["lazy_import"]


def import_name(name: str, source: str, namespace: dict[str, Any]) -> Any:
    """
    Import ``name`` from ``source`` in ``namespace``.

    There are two use cases:

    - ``name`` is an object defined in ``source``;
    - ``name`` is a submodule of ``source``.

    Neither :func:`__import__` nor :func:`~importlib.import_module` does
    exactly this. :func:`__import__` is closer to the intended behavior.

    """
    level = 0
    while source[level] == ".":
        level += 1
        assert level < len(source), "importing from parent isn't supported"
    module = __import__(source[level:], namespace, None, [name], level)
    return getattr(module, name)


def lazy_import(
    namespace: dict[str, Any],
    aliases: dict[str, str] | None = None,
    deprecated_aliases: dict[str, str] | None = None,
) -> None:
    """
    Provide lazy, module-level imports.

    Typical use::

        __getattr__, __dir__ = lazy_import(
            globals(),
            aliases={
                "<name>": "<source module>",
                ...
            },
            deprecated_aliases={
                ...,
            }
        )

    This function defines ``__getattr__`` and ``__dir__`` per :pep:`562`.

    """
    if aliases is None:
        aliases = {}
    if deprecated_aliases is None:
        deprecated_aliases = {}

    namespace_set = set(namespace)
    aliases_set = set(aliases)
    deprecated_aliases_set = set(deprecated_aliases)

    assert not namespace_set & aliases_set, "namespace conflict"
    assert not namespace_set & deprecated_aliases_set, "namespace conflict"
    assert not aliases_set & deprecated_aliases_set, "namespace conflict"

    package = namespace["__name__"]

    def __getattr__(name: str) -> Any:
        assert aliases is not None  # mypy cannot figure this out
        try:
            source = aliases[name]
        except KeyError:
            pass
        else:
            return import_name(name, source, namespace)

        assert deprecated_aliases is not None  # mypy cannot figure this out
        try:
            source = deprecated_aliases[name]
        except KeyError:
            pass
        else:
            warnings.warn(
                f"{package}.{name} is deprecated",
                DeprecationWarning,
                stacklevel=2,
            )
            return import_name(name, source, namespace)

        raise AttributeError(f"module {package!r} has no attribute {name!r}")

    namespace["__getattr__"] = __getattr__

    def __dir__() -> Iterable[str]:
        return sorted(namespace_set | aliases_set | deprecated_aliases_set)

    namespace["__dir__"] = __dir__
