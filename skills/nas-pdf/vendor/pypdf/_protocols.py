"""Helpers for working with PDF types."""

from abc import abstractmethod
from pathlib import Path
from typing import IO, Any, Optional, Protocol, Union

from ._utils import StrByteType, StreamType


class PdfObjectProtocol(Protocol):
    indirect_reference: Any

    def clone(
        self,
        pdf_dest: Any,
        force_duplicate: bool = False,
        ignore_fields: Union[tuple[str, ...], list[str], None] = (),
    ) -> Any:
        ...  # pragma: no cover

    def _reference_clone(self, clone: Any, pdf_dest: Any) -> Any:
        ...  # pragma: no cover

    def get_object(self) -> Optional["PdfObjectProtocol"]:
        ...  # pragma: no cover

    def hash_value(self) -> bytes:
        ...  # pragma: no cover

    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        ...  # pragma: no cover


class XmpInformationProtocol(PdfObjectProtocol):
    pass


class PdfCommonDocProtocol(Protocol):
    @property
    def pdf_header(self) -> str:
        ...  # pragma: no cover

    @property
    def pages(self) -> list[Any]:
        ...  # pragma: no cover

    @property
    def root_object(self) -> PdfObjectProtocol:
        ...  # pragma: no cover

    def get_object(self, indirect_reference: Any) -> Optional[PdfObjectProtocol]:
        ...  # pragma: no cover

    @property
    def strict(self) -> bool:
        ...  # pragma: no cover


class PdfReaderProtocol(PdfCommonDocProtocol, Protocol):
    @property
    @abstractmethod
    def xref(self) -> dict[int, dict[int, Any]]:
        ...  # pragma: no cover

    @property
    @abstractmethod
    def trailer(self) -> dict[str, Any]:
        ...  # pragma: no cover


class PdfWriterProtocol(PdfCommonDocProtocol, Protocol):
    _objects: list[Any]
    _id_translated: dict[int, dict[int, int]]

    incremental: bool
    _reader: Any  # PdfReader

    @abstractmethod
    def write(self, stream: Union[Path, StrByteType]) -> tuple[bool, IO[Any]]:
        ...  # pragma: no cover

    @abstractmethod
    def _add_object(self, obj: Any) -> Any:
        ...  # pragma: no cover
