from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping, MutableMapping
from typing import Any, Protocol


__all__ = [
    "Headers",
    "HeadersLike",
    "MultipleValuesError",
]


class MultipleValuesError(LookupError):
    """
    Exception raised when :class:`Headers` has multiple values for a key.

    """

    def __str__(self) -> str:
        # Implement the same logic as KeyError_str in Objects/exceptions.c.
        if len(self.args) == 1:
            return repr(self.args[0])
        return super().__str__()


class Headers(MutableMapping[str, str]):
    """
    Efficient data structure for manipulating HTTP headers.

    A :class:`list` of ``(name, values)`` is inefficient for lookups.

    A :class:`dict` doesn't suffice because header names are case-insensitive
    and multiple occurrences of headers with the same name are possible.

    :class:`Headers` stores HTTP headers in a hybrid data structure to provide
    efficient insertions and lookups while preserving the original data.

    In order to account for multiple values with minimal hassle,
    :class:`Headers` follows this logic:

    - When getting a header with ``headers[name]``:
        - if there's no value, :exc:`KeyError` is raised;
        - if there's exactly one value, it's returned;
        - if there's more than one value, :exc:`MultipleValuesError` is raised.

    - When setting a header with ``headers[name] = value``, the value is
      appended to the list of values for that header.

    - When deleting a header with ``del headers[name]``, all values for that
      header are removed (this is slow).

    Other methods for manipulating headers are consistent with this logic.

    As long as no header occurs multiple times, :class:`Headers` behaves like
    :class:`dict`, except keys are lower-cased to provide case-insensitivity.

    Two methods support manipulating multiple values explicitly:

    - :meth:`get_all` returns a list of all values for a header;
    - :meth:`raw_items` returns an iterator of ``(name, values)`` pairs.

    """

    __slots__ = ["_dict", "_list"]

    # Like dict, Headers accepts an optional "mapping or iterable" argument.
    def __init__(self, *args: HeadersLike, **kwargs: str) -> None:
        self._dict: dict[str, list[str]] = {}
        self._list: list[tuple[str, str]] = []
        self.update(*args, **kwargs)

    def __str__(self) -> str:
        return "".join(f"{key}: {value}\r\n" for key, value in self._list) + "\r\n"

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}({self._list!r})"

    def copy(self) -> Headers:
        copy = self.__class__()
        copy._dict = self._dict.copy()
        copy._list = self._list.copy()
        return copy

    def serialize(self) -> bytes:
        # Since headers only contain ASCII characters, we can keep this simple.
        return str(self).encode()

    # Collection methods

    def __contains__(self, key: object) -> bool:
        return isinstance(key, str) and key.lower() in self._dict

    def __iter__(self) -> Iterator[str]:
        return iter(self._dict)

    def __len__(self) -> int:
        return len(self._dict)

    # MutableMapping methods

    def __getitem__(self, key: str) -> str:
        value = self._dict[key.lower()]
        if len(value) == 1:
            return value[0]
        else:
            raise MultipleValuesError(key)

    def __setitem__(self, key: str, value: str) -> None:
        self._dict.setdefault(key.lower(), []).append(value)
        self._list.append((key, value))

    def __delitem__(self, key: str) -> None:
        key_lower = key.lower()
        self._dict.__delitem__(key_lower)
        # This is inefficient. Fortunately deleting HTTP headers is uncommon.
        self._list = [(k, v) for k, v in self._list if k.lower() != key_lower]

    def __eq__(self, other: Any) -> bool:
        if not isinstance(other, Headers):
            return NotImplemented
        return self._dict == other._dict

    def clear(self) -> None:
        """
        Remove all headers.

        """
        self._dict = {}
        self._list = []

    def update(self, *args: HeadersLike, **kwargs: str) -> None:
        """
        Update from a :class:`Headers` instance and/or keyword arguments.

        """
        args = tuple(
            arg.raw_items() if isinstance(arg, Headers) else arg for arg in args
        )
        super().update(*args, **kwargs)

    # Methods for handling multiple values

    def get_all(self, key: str) -> list[str]:
        """
        Return the (possibly empty) list of all values for a header.

        Args:
            key: Header name.

        """
        return self._dict.get(key.lower(), [])

    def raw_items(self) -> Iterator[tuple[str, str]]:
        """
        Return an iterator of all values as ``(name, value)`` pairs.

        """
        return iter(self._list)


# copy of _typeshed.SupportsKeysAndGetItem.
class SupportsKeysAndGetItem(Protocol):  # pragma: no cover
    """
    Dict-like types with ``keys() -> str`` and ``__getitem__(key: str) -> str`` methods.

    """

    def keys(self) -> Iterable[str]: ...

    def __getitem__(self, key: str) -> str: ...


HeadersLike = (
    Headers | Mapping[str, str] | Iterable[tuple[str, str]] | SupportsKeysAndGetItem
)
"""
Types accepted where :class:`Headers` is expected.

In addition to :class:`Headers` itself, this includes dict-like types where both
keys and values are :class:`str`.

"""
