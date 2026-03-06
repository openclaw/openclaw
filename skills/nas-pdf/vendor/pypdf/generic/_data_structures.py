# Copyright (c) 2006, Mathieu Fenniak
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are
# met:
#
# * Redistributions of source code must retain the above copyright notice,
# this list of conditions and the following disclaimer.
# * Redistributions in binary form must reproduce the above copyright notice,
# this list of conditions and the following disclaimer in the documentation
# and/or other materials provided with the distribution.
# * The name of the author may not be used to endorse or promote products
# derived from this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.


__author__ = "Mathieu Fenniak"
__author_email__ = "biziqe@mathieu.fenniak.net"

import logging
import re
import sys
from collections.abc import Iterable, Sequence
from io import BytesIO
from math import ceil
from typing import (
    Any,
    Callable,
    Optional,
    Union,
    cast,
)

from .._protocols import PdfReaderProtocol, PdfWriterProtocol, XmpInformationProtocol
from .._utils import (
    WHITESPACES,
    StreamType,
    deprecation_no_replacement,
    logger_warning,
    read_non_whitespace,
    read_until_regex,
    read_until_whitespace,
    skip_over_comment,
)
from ..constants import (
    CheckboxRadioButtonAttributes,
    FieldDictionaryAttributes,
    OutlineFontFlag,
)
from ..constants import FilterTypes as FT
from ..constants import StreamAttributes as SA
from ..constants import TypArguments as TA
from ..constants import TypFitArguments as TF
from ..errors import STREAM_TRUNCATED_PREMATURELY, PdfReadError, PdfStreamError
from ._base import (
    BooleanObject,
    ByteStringObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NullObject,
    NumberObject,
    PdfObject,
    TextStringObject,
    is_null_or_none,
)
from ._fit import Fit
from ._image_inline import (
    extract_inline__ascii85_decode,
    extract_inline__ascii_hex_decode,
    extract_inline__dct_decode,
    extract_inline__run_length_decode,
    extract_inline_default,
)
from ._utils import read_hex_string_from_stream, read_string_from_stream

if sys.version_info >= (3, 11):
    from typing import Self
else:
    from typing_extensions import Self

logger = logging.getLogger(__name__)

IndirectPattern = re.compile(rb"[+-]?(\d+)\s+(\d+)\s+R[^a-zA-Z]")


class ArrayObject(list[Any], PdfObject):
    def replicate(
        self,
        pdf_dest: PdfWriterProtocol,
    ) -> "ArrayObject":
        arr = cast(
            "ArrayObject",
            self._reference_clone(ArrayObject(), pdf_dest, False),
        )
        for data in self:
            if hasattr(data, "replicate"):
                arr.append(data.replicate(pdf_dest))
            else:
                arr.append(data)
        return arr

    def clone(
        self,
        pdf_dest: PdfWriterProtocol,
        force_duplicate: bool = False,
        ignore_fields: Optional[Sequence[Union[str, int]]] = (),
    ) -> "ArrayObject":
        """Clone object into pdf_dest."""
        try:
            if self.indirect_reference.pdf == pdf_dest and not force_duplicate:  # type: ignore
                return self
        except Exception:
            pass
        arr = cast(
            "ArrayObject",
            self._reference_clone(ArrayObject(), pdf_dest, force_duplicate=True),
        )
        for data in self:
            if isinstance(data, StreamObject):
                dup = data._reference_clone(
                    data.clone(pdf_dest, force_duplicate, ignore_fields),
                    pdf_dest,
                    force_duplicate,
                )
                arr.append(dup.indirect_reference)
            elif hasattr(data, "clone"):
                arr.append(data.clone(pdf_dest, force_duplicate, ignore_fields))
            else:
                arr.append(data)
        return arr

    def hash_bin(self) -> int:
        """
        Used to detect modified object.

        Returns:
            Hash considering type and value.

        """
        return hash((self.__class__, tuple(x.hash_bin() for x in self)))

    def items(self) -> Iterable[Any]:
        """Emulate DictionaryObject.items for a list (index, object)."""
        return enumerate(self)

    def _to_lst(self, lst: Any) -> list[Any]:
        # Convert to list, internal
        if isinstance(lst, (list, tuple, set)):
            pass
        elif isinstance(lst, PdfObject):
            lst = [lst]
        elif isinstance(lst, str):
            if lst[0] == "/":
                lst = [NameObject(lst)]
            else:
                lst = [TextStringObject(lst)]
        elif isinstance(lst, bytes):
            lst = [ByteStringObject(lst)]
        else:  # for numbers,...
            lst = [lst]
        return lst

    def __add__(self, lst: Any) -> "ArrayObject":
        """
        Allow extension by adding list or add one element only

        Args:
            lst: any list, tuples are extended the list.
            other types(numbers,...) will be appended.
            if str is passed it will be converted into TextStringObject
            or NameObject (if starting with "/")
            if bytes is passed it will be converted into ByteStringObject

        Returns:
            ArrayObject with all elements

        """
        temp = ArrayObject(self)
        temp.extend(self._to_lst(lst))
        return temp

    def __iadd__(self, lst: Any) -> Self:
        """
         Allow extension by adding list or add one element only

        Args:
            lst: any list, tuples are extended the list.
            other types(numbers,...) will be appended.
            if str is passed it will be converted into TextStringObject
            or NameObject (if starting with "/")
            if bytes is passed it will be converted into ByteStringObject

        """
        self.extend(self._to_lst(lst))
        return self

    def __isub__(self, lst: Any) -> Self:
        """Allow to remove items"""
        for x in self._to_lst(lst):
            try:
                index = self.index(x)
                del self[index]
            except ValueError:
                pass
        return self

    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        if encryption_key is not None:  # deprecated
            deprecation_no_replacement(
                "the encryption_key parameter of write_to_stream", "5.0.0"
            )
        stream.write(b"[")
        for data in self:
            stream.write(b" ")
            data.write_to_stream(stream)
        stream.write(b" ]")

    @staticmethod
    def read_from_stream(
        stream: StreamType,
        pdf: Optional[PdfReaderProtocol],
        forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
    ) -> "ArrayObject":
        arr = ArrayObject()
        tmp = stream.read(1)
        if tmp != b"[":
            raise PdfReadError("Could not read array")
        while True:
            # skip leading whitespace
            tok = stream.read(1)
            while tok.isspace():
                tok = stream.read(1)
            if tok == b"":
                break
            if tok == b"%":
                stream.seek(-1, 1)
                skip_over_comment(stream)
                continue
            stream.seek(-1, 1)
            # check for array ending
            peek_ahead = stream.read(1)
            if peek_ahead == b"]":
                break
            stream.seek(-1, 1)
            # read and append object
            arr.append(read_object(stream, pdf, forced_encoding))
        return arr


class DictionaryObject(dict[Any, Any], PdfObject):
    def replicate(
        self,
        pdf_dest: PdfWriterProtocol,
    ) -> "DictionaryObject":
        d__ = cast(
            "DictionaryObject",
            self._reference_clone(self.__class__(), pdf_dest, False),
        )
        for k, v in self.items():
            d__[k.replicate(pdf_dest)] = (
                v.replicate(pdf_dest) if hasattr(v, "replicate") else v
            )
        return d__

    def clone(
        self,
        pdf_dest: PdfWriterProtocol,
        force_duplicate: bool = False,
        ignore_fields: Optional[Sequence[Union[str, int]]] = (),
    ) -> "DictionaryObject":
        """Clone object into pdf_dest."""
        try:
            if self.indirect_reference.pdf == pdf_dest and not force_duplicate:  # type: ignore
                return self
        except Exception:
            pass

        visited: set[tuple[int, int]] = set()  # (idnum, generation)
        d__ = cast(
            "DictionaryObject",
            self._reference_clone(self.__class__(), pdf_dest, force_duplicate),
        )
        if ignore_fields is None:
            ignore_fields = []
        if len(d__.keys()) == 0:
            d__._clone(self, pdf_dest, force_duplicate, ignore_fields, visited)
        return d__

    def _clone(
        self,
        src: "DictionaryObject",
        pdf_dest: PdfWriterProtocol,
        force_duplicate: bool,
        ignore_fields: Optional[Sequence[Union[str, int]]],
        visited: set[tuple[int, int]],  # (idnum, generation)
    ) -> None:
        """
        Update the object from src.

        Args:
            src: "DictionaryObject":
            pdf_dest:
            force_duplicate:
            ignore_fields:

        """
        # First we remove the ignore_fields
        # that are for a limited number of levels
        assert ignore_fields is not None
        ignore_fields = list(ignore_fields)
        x = 0
        while x < len(ignore_fields):
            if isinstance(ignore_fields[x], int):
                if cast(int, ignore_fields[x]) <= 0:
                    del ignore_fields[x]
                    del ignore_fields[x]
                    continue
                ignore_fields[x] -= 1  # type:ignore
            x += 1
        #  Check if this is a chain list, we need to loop to prevent recur
        if any(
            field not in ignore_fields
            and field in src
            and isinstance(src.raw_get(field), IndirectObject)
            and isinstance(src[field], DictionaryObject)
            and (
                src.get("/Type", None) is None
                or cast(DictionaryObject, src[field]).get("/Type", None) is None
                or src.get("/Type", None)
                == cast(DictionaryObject, src[field]).get("/Type", None)
            )
            for field in ["/Next", "/Prev", "/N", "/V"]
        ):
            ignore_fields = list(ignore_fields)
            for lst in (("/Next", "/Prev"), ("/N", "/V")):
                for k in lst:
                    objs = []
                    if (
                        k in src
                        and k not in self
                        and isinstance(src.raw_get(k), IndirectObject)
                        and isinstance(src[k], DictionaryObject)
                        # If need to go further the idea is to check
                        # that the types are the same
                        and (
                            src.get("/Type", None) is None
                            or cast(DictionaryObject, src[k]).get("/Type", None) is None
                            or src.get("/Type", None)
                            == cast(DictionaryObject, src[k]).get("/Type", None)
                        )
                    ):
                        cur_obj: Optional[DictionaryObject] = cast(
                            "DictionaryObject", src[k]
                        )
                        prev_obj: Optional[DictionaryObject] = self
                        while cur_obj is not None:
                            clon = cast(
                                "DictionaryObject",
                                cur_obj._reference_clone(
                                    cur_obj.__class__(), pdf_dest, force_duplicate
                                ),
                            )
                            # Check to see if we've previously processed our item
                            if clon.indirect_reference is not None:
                                idnum = clon.indirect_reference.idnum
                                generation = clon.indirect_reference.generation
                                if (idnum, generation) in visited:
                                    cur_obj = None
                                    break
                                visited.add((idnum, generation))
                            objs.append((cur_obj, clon))
                            assert prev_obj is not None
                            prev_obj[NameObject(k)] = clon.indirect_reference
                            prev_obj = clon
                            try:
                                if cur_obj == src:
                                    cur_obj = None
                                else:
                                    cur_obj = cast("DictionaryObject", cur_obj[k])
                            except Exception:
                                cur_obj = None
                        for s, c in objs:
                            c._clone(
                                s, pdf_dest, force_duplicate, ignore_fields, visited
                            )

        for k, v in src.items():
            if k not in ignore_fields:
                if isinstance(v, StreamObject):
                    if not hasattr(v, "indirect_reference"):
                        v.indirect_reference = None
                    vv = v.clone(pdf_dest, force_duplicate, ignore_fields)
                    assert vv.indirect_reference is not None
                    self[k.clone(pdf_dest)] = vv.indirect_reference
                elif k not in self:
                    self[NameObject(k)] = (
                        v.clone(pdf_dest, force_duplicate, ignore_fields)
                        if hasattr(v, "clone")
                        else v
                    )

    def hash_bin(self) -> int:
        """
        Used to detect modified object.

        Returns:
            Hash considering type and value.

        """
        return hash(
            (self.__class__, tuple(((k, v.hash_bin()) for k, v in self.items())))
        )

    def raw_get(self, key: Any) -> Any:
        return dict.__getitem__(self, key)

    def get_inherited(self, key: str, default: Any = None) -> Any:
        """
        Returns the value of a key or from the parent if not found.
        If not found returns default.

        Args:
            key: string identifying the field to return

            default: default value to return

        Returns:
            Current key or inherited one, otherwise default value.

        """
        if key in self:
            return self[key]
        try:
            if "/Parent" not in self:
                return default
            raise KeyError("Not present")
        except KeyError:
            return cast("DictionaryObject", self["/Parent"].get_object()).get_inherited(
                key, default
            )

    def __setitem__(self, key: Any, value: Any) -> Any:
        if not isinstance(key, PdfObject):
            raise ValueError("Key must be a PdfObject")
        if not isinstance(value, PdfObject):
            raise ValueError("Value must be a PdfObject")
        return dict.__setitem__(self, key, value)

    def setdefault(self, key: Any, value: Optional[Any] = None) -> Any:
        if not isinstance(key, PdfObject):
            raise ValueError("Key must be a PdfObject")
        if not isinstance(value, PdfObject):
            raise ValueError("Value must be a PdfObject")
        return dict.setdefault(self, key, value)

    def __getitem__(self, key: Any) -> PdfObject:
        return dict.__getitem__(self, key).get_object()

    @property
    def xmp_metadata(self) -> Optional[XmpInformationProtocol]:
        """
        Retrieve XMP (Extensible Metadata Platform) data relevant to this
        object, if available.

        See Table 347 — Additional entries in a metadata stream dictionary.

        Returns:
          Returns a :class:`~pypdf.xmp.XmpInformation` instance
          that can be used to access XMP metadata from the document. Can also
          return None if no metadata was found on the document root.

        """
        from ..xmp import XmpInformation  # noqa: PLC0415

        metadata = self.get("/Metadata", None)
        if is_null_or_none(metadata):
            return None
        assert metadata is not None, "mypy"
        metadata = metadata.get_object()
        return XmpInformation(metadata)

    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        if encryption_key is not None:  # deprecated
            deprecation_no_replacement(
                "the encryption_key parameter of write_to_stream", "5.0.0"
            )
        stream.write(b"<<\n")
        for key, value in self.items():
            if len(key) > 2 and key[1] == "%" and key[-1] == "%":
                continue
            key.write_to_stream(stream, encryption_key)
            stream.write(b" ")
            value.write_to_stream(stream)
            stream.write(b"\n")
        stream.write(b">>")

    @classmethod
    def _get_next_object_position(
            cls, position_before: int, position_end: int, generations: list[int], pdf: PdfReaderProtocol
    ) -> int:
        out = position_end
        for generation in generations:
            location = pdf.xref[generation]
            values = [x for x in location.values() if position_before < x <= position_end]
            if values:
                out = min(out, *values)
        return out

    @classmethod
    def _read_unsized_from_stream(
            cls, stream: StreamType, pdf: PdfReaderProtocol
    ) -> bytes:
        object_position = cls._get_next_object_position(
            position_before=stream.tell(), position_end=2 ** 32, generations=list(pdf.xref), pdf=pdf
        ) - 1
        current_position = stream.tell()
        # Read until the next object position.
        read_value = stream.read(object_position - stream.tell())
        endstream_position = read_value.find(b"endstream")
        if endstream_position < 0:
            raise PdfReadError(
                f"Unable to find 'endstream' marker for obj starting at {current_position}."
            )
        # 9 = len(b"endstream")
        stream.seek(current_position + endstream_position + 9)
        return read_value[: endstream_position - 1]

    @staticmethod
    def read_from_stream(
        stream: StreamType,
        pdf: Optional[PdfReaderProtocol],
        forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
    ) -> "DictionaryObject":
        tmp = stream.read(2)
        if tmp != b"<<":
            raise PdfReadError(
                f"Dictionary read error at byte {hex(stream.tell())}: "
                "stream must begin with '<<'"
            )
        data: dict[Any, Any] = {}
        while True:
            tok = read_non_whitespace(stream)
            if tok == b"\x00":
                continue
            if tok == b"%":
                stream.seek(-1, 1)
                skip_over_comment(stream)
                continue
            if not tok:
                raise PdfStreamError(STREAM_TRUNCATED_PREMATURELY)

            if tok == b">":
                stream.read(1)
                break
            stream.seek(-1, 1)
            try:
                try:
                    key = read_object(stream, pdf)
                    if isinstance(key, NullObject):
                        break
                    if not isinstance(key, NameObject):
                        raise PdfReadError(
                            f"Expecting a NameObject for key but found {key!r}"
                        )
                except PdfReadError as exc:
                    if pdf is not None and pdf.strict:
                        raise
                    logger_warning(exc.__repr__(), __name__)
                    continue
                tok = read_non_whitespace(stream)
                stream.seek(-1, 1)
                value = read_object(stream, pdf, forced_encoding)
            except Exception as exc:
                if pdf is not None and pdf.strict:
                    raise PdfReadError(exc.__repr__())
                logger_warning(exc.__repr__(), __name__)
                retval = DictionaryObject()
                retval.update(data)
                return retval  # return partial data

            if not data.get(key):
                data[key] = value
            else:
                # multiple definitions of key not permitted
                msg = (
                    f"Multiple definitions in dictionary at byte "
                    f"{hex(stream.tell())} for key {key}"
                )
                if pdf is not None and pdf.strict:
                    raise PdfReadError(msg)
                logger_warning(msg, __name__)

        pos = stream.tell()
        s = read_non_whitespace(stream)
        if s == b"s" and stream.read(5) == b"tream":
            eol = stream.read(1)
            # Occasional PDF file output has spaces after 'stream' keyword but before EOL.
            # patch provided by Danial Sandler
            while eol == b" ":
                eol = stream.read(1)
            if eol not in (b"\n", b"\r"):
                raise PdfStreamError("Stream data must be followed by a newline")
            if eol == b"\r" and stream.read(1) != b"\n":
                stream.seek(-1, 1)
            # this is a stream object, not a dictionary
            if SA.LENGTH not in data:
                if pdf is not None and pdf.strict:
                    raise PdfStreamError("Stream length not defined")
                logger_warning(
                    f"Stream length not defined @pos={stream.tell()}", __name__
                )
                data[NameObject(SA.LENGTH)] = NumberObject(-1)
            length = data[SA.LENGTH]
            if isinstance(length, IndirectObject):
                t = stream.tell()
                assert pdf is not None, "mypy"
                length = pdf.get_object(length)
                stream.seek(t, 0)
            if length is None:  # if the PDF is damaged
                length = -1
            pstart = stream.tell()
            if length >= 0:
                data["__streamdata__"] = stream.read(length)
            else:
                data["__streamdata__"] = read_until_regex(
                    stream, re.compile(b"endstream")
                )
            e = read_non_whitespace(stream)
            ndstream = stream.read(8)
            if (e + ndstream) != b"endstream":
                # the odd PDF file has a length that is too long, so
                # we need to read backwards to find the "endstream" ending.
                # ReportLab (unknown version) generates files with this bug,
                # and Python users into PDF files tend to be our audience.
                # we need to do this to correct the streamdata and chop off
                # an extra character.
                pos = stream.tell()
                stream.seek(-10, 1)
                end = stream.read(9)
                if end == b"endstream":
                    # we found it by looking back one character further.
                    data["__streamdata__"] = data["__streamdata__"][:-1]
                elif pdf is not None and not pdf.strict:
                    stream.seek(pstart, 0)
                    data["__streamdata__"] = DictionaryObject._read_unsized_from_stream(stream, pdf)
                    pos = stream.tell()
                else:
                    stream.seek(pos, 0)
                    raise PdfReadError(
                        "Unable to find 'endstream' marker after stream at byte "
                        f"{hex(stream.tell())} (nd='{ndstream!r}', end='{end!r}')."
                    )
        else:
            stream.seek(pos, 0)
        if "__streamdata__" in data:
            return StreamObject.initialize_from_dictionary(data)
        retval = DictionaryObject()
        retval.update(data)
        return retval


class TreeObject(DictionaryObject):
    def __init__(self, dct: Optional[DictionaryObject] = None) -> None:
        DictionaryObject.__init__(self)
        if dct:
            self.update(dct)

    def has_children(self) -> bool:
        return "/First" in self

    def __iter__(self) -> Any:
        return self.children()

    def children(self) -> Iterable[Any]:
        if not self.has_children():
            return

        child_ref = self[NameObject("/First")]
        last = self[NameObject("/Last")]
        child = child_ref.get_object()
        visited: set[int] = set()
        while True:
            child_id = id(child)
            if child_id in visited:
                logger_warning(f"Detected cycle in outline structure for {child}", __name__)
                return
            visited.add(child_id)

            yield child

            if child == last:
                return
            child_ref = child.get(NameObject("/Next"))  # type: ignore
            if is_null_or_none(child_ref):
                return
            child = child_ref.get_object()

    def add_child(self, child: Any, pdf: PdfWriterProtocol) -> None:
        self.insert_child(child, None, pdf)

    def inc_parent_counter_default(
        self, parent: Union[None, IndirectObject, "TreeObject"], n: int
    ) -> None:
        if is_null_or_none(parent):
            return
        assert parent is not None, "mypy"
        parent = cast("TreeObject", parent.get_object())
        if "/Count" in parent:
            parent[NameObject("/Count")] = NumberObject(
                max(0, cast(int, parent[NameObject("/Count")]) + n)
            )
            self.inc_parent_counter_default(parent.get("/Parent", None), n)

    def inc_parent_counter_outline(
        self, parent: Union[None, IndirectObject, "TreeObject"], n: int
    ) -> None:
        if is_null_or_none(parent):
            return
        assert parent is not None, "mypy"
        parent = cast("TreeObject", parent.get_object())
        #  BooleanObject requires comparison with == not is
        opn = parent.get("/%is_open%", True) == True  # noqa: E712
        c = cast(int, parent.get("/Count", 0))
        if c < 0:
            c = abs(c)
        parent[NameObject("/Count")] = NumberObject((c + n) * (1 if opn else -1))
        if not opn:
            return
        self.inc_parent_counter_outline(parent.get("/Parent", None), n)

    def insert_child(
        self,
        child: Any,
        before: Any,
        pdf: PdfWriterProtocol,
        inc_parent_counter: Optional[Callable[..., Any]] = None,
    ) -> IndirectObject:
        if inc_parent_counter is None:
            inc_parent_counter = self.inc_parent_counter_default
        child_obj = child.get_object()
        child = child.indirect_reference  # get_reference(child_obj)

        prev: Optional[DictionaryObject]
        if "/First" not in self:  # no child yet
            self[NameObject("/First")] = child
            self[NameObject("/Count")] = NumberObject(0)
            self[NameObject("/Last")] = child
            child_obj[NameObject("/Parent")] = self.indirect_reference
            inc_parent_counter(self, child_obj.get("/Count", 1))
            if "/Next" in child_obj:
                del child_obj["/Next"]
            if "/Prev" in child_obj:
                del child_obj["/Prev"]
            return child
        prev = cast("DictionaryObject", self["/Last"])

        while prev.indirect_reference != before:
            if "/Next" in prev:
                prev = cast("TreeObject", prev["/Next"])
            else:  # append at the end
                prev[NameObject("/Next")] = cast("TreeObject", child)
                child_obj[NameObject("/Prev")] = prev.indirect_reference
                child_obj[NameObject("/Parent")] = self.indirect_reference
                if "/Next" in child_obj:
                    del child_obj["/Next"]
                self[NameObject("/Last")] = child
                inc_parent_counter(self, child_obj.get("/Count", 1))
                return child
        try:  # insert as first or in the middle
            assert isinstance(prev["/Prev"], DictionaryObject)
            prev["/Prev"][NameObject("/Next")] = child
            child_obj[NameObject("/Prev")] = prev["/Prev"]
        except Exception:  # it means we are inserting in first position
            del child_obj["/Next"]
        child_obj[NameObject("/Next")] = prev
        prev[NameObject("/Prev")] = child
        child_obj[NameObject("/Parent")] = self.indirect_reference
        inc_parent_counter(self, child_obj.get("/Count", 1))
        return child

    def _remove_node_from_tree(
        self, prev: Any, prev_ref: Any, cur: Any, last: Any
    ) -> None:
        """
        Adjust the pointers of the linked list and tree node count.

        Args:
            prev:
            prev_ref:
            cur:
            last:

        """
        next_ref = cur.get(NameObject("/Next"), None)
        if prev is None:
            if next_ref:
                # Removing first tree node
                next_obj = next_ref.get_object()
                del next_obj[NameObject("/Prev")]
                self[NameObject("/First")] = next_ref
                self[NameObject("/Count")] = NumberObject(
                    self[NameObject("/Count")] - 1  # type: ignore
                )

            else:
                # Removing only tree node
                self[NameObject("/Count")] = NumberObject(0)
                del self[NameObject("/First")]
                if NameObject("/Last") in self:
                    del self[NameObject("/Last")]
        else:
            if next_ref:
                # Removing middle tree node
                next_obj = next_ref.get_object()
                next_obj[NameObject("/Prev")] = prev_ref
                prev[NameObject("/Next")] = next_ref
            else:
                # Removing last tree node
                assert cur == last
                del prev[NameObject("/Next")]
                self[NameObject("/Last")] = prev_ref
            self[NameObject("/Count")] = NumberObject(self[NameObject("/Count")] - 1)  # type: ignore

    def remove_child(self, child: Any) -> None:
        child_obj = child.get_object()
        child = child_obj.indirect_reference

        if NameObject("/Parent") not in child_obj:
            raise ValueError("Removed child does not appear to be a tree item")
        if child_obj[NameObject("/Parent")] != self:
            raise ValueError("Removed child is not a member of this tree")

        found = False
        prev_ref = None
        prev = None
        cur_ref: Optional[Any] = self[NameObject("/First")]
        cur: Optional[dict[str, Any]] = cur_ref.get_object()  # type: ignore
        last_ref = self[NameObject("/Last")]
        last = last_ref.get_object()
        while cur is not None:
            if cur == child_obj:
                self._remove_node_from_tree(prev, prev_ref, cur, last)
                found = True
                break

            # Go to the next node
            prev_ref = cur_ref
            prev = cur
            if NameObject("/Next") in cur:
                cur_ref = cur[NameObject("/Next")]
                cur = cur_ref.get_object()
            else:
                cur_ref = None
                cur = None

        if not found:
            raise ValueError("Removal couldn't find item in tree")

        _reset_node_tree_relationship(child_obj)

    def remove_from_tree(self) -> None:
        """Remove the object from the tree it is in."""
        if NameObject("/Parent") not in self:
            raise ValueError("Removed child does not appear to be a tree item")
        cast("TreeObject", self["/Parent"]).remove_child(self)

    def empty_tree(self) -> None:
        for child in self:
            child_obj = child.get_object()
            _reset_node_tree_relationship(child_obj)

        if NameObject("/Count") in self:
            del self[NameObject("/Count")]
        if NameObject("/First") in self:
            del self[NameObject("/First")]
        if NameObject("/Last") in self:
            del self[NameObject("/Last")]


def _reset_node_tree_relationship(child_obj: Any) -> None:
    """
    Call this after a node has been removed from a tree.

    This resets the nodes attributes in respect to that tree.

    Args:
        child_obj:

    """
    del child_obj[NameObject("/Parent")]
    if NameObject("/Next") in child_obj:
        del child_obj[NameObject("/Next")]
    if NameObject("/Prev") in child_obj:
        del child_obj[NameObject("/Prev")]


class StreamObject(DictionaryObject):
    def __init__(self) -> None:
        self._data: bytes = b""
        self.decoded_self: Optional[DecodedStreamObject] = None

    def replicate(
        self,
        pdf_dest: PdfWriterProtocol,
    ) -> "StreamObject":
        d__ = cast(
            "StreamObject",
            self._reference_clone(self.__class__(), pdf_dest, False),
        )
        d__._data = self._data
        try:
            decoded_self = self.decoded_self
            if decoded_self is None:
                self.decoded_self = None
            else:
                self.decoded_self = cast(
                    "DecodedStreamObject", decoded_self.replicate(pdf_dest)
                )
        except Exception:
            pass
        for k, v in self.items():
            d__[k.replicate(pdf_dest)] = (
                v.replicate(pdf_dest) if hasattr(v, "replicate") else v
            )
        return d__

    def _clone(
        self,
        src: DictionaryObject,
        pdf_dest: PdfWriterProtocol,
        force_duplicate: bool,
        ignore_fields: Optional[Sequence[Union[str, int]]],
        visited: set[tuple[int, int]],
    ) -> None:
        """
        Update the object from src.

        Args:
            src:
            pdf_dest:
            force_duplicate:
            ignore_fields:

        """
        self._data = cast("StreamObject", src)._data
        try:
            decoded_self = cast("StreamObject", src).decoded_self
            if decoded_self is None:
                self.decoded_self = None
            else:
                self.decoded_self = cast(
                    "DecodedStreamObject",
                    decoded_self.clone(pdf_dest, force_duplicate, ignore_fields),
                )
        except Exception:
            pass
        super()._clone(src, pdf_dest, force_duplicate, ignore_fields, visited)

    def hash_bin(self) -> int:
        """
        Used to detect modified object.

        Returns:
            Hash considering type and value.

        """
        # Use _data to prevent errors on non-decoded streams.
        return hash((super().hash_bin(), self._data))

    def get_data(self) -> bytes:
        return self._data

    def set_data(self, data: bytes) -> None:
        self._data = data

    def hash_value_data(self) -> bytes:
        data = super().hash_value_data()
        data += self.get_data()
        return data

    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        if encryption_key is not None:  # deprecated
            deprecation_no_replacement(
                "the encryption_key parameter of write_to_stream", "5.0.0"
            )
        self[NameObject(SA.LENGTH)] = NumberObject(len(self._data))
        DictionaryObject.write_to_stream(self, stream)
        del self[SA.LENGTH]
        stream.write(b"\nstream\n")
        stream.write(self._data)
        stream.write(b"\nendstream")

    @staticmethod
    def initialize_from_dictionary(
        data: dict[str, Any]
    ) -> Union["EncodedStreamObject", "DecodedStreamObject"]:
        retval: Union[EncodedStreamObject, DecodedStreamObject]
        if SA.FILTER in data:
            retval = EncodedStreamObject()
        else:
            retval = DecodedStreamObject()
        retval._data = data["__streamdata__"]
        del data["__streamdata__"]
        if SA.LENGTH in data:
            del data[SA.LENGTH]
        retval.update(data)
        return retval

    def flate_encode(self, level: int = -1) -> "EncodedStreamObject":
        from ..filters import FlateDecode  # noqa: PLC0415

        if SA.FILTER in self:
            f = self[SA.FILTER]
            if isinstance(f, ArrayObject):
                f = ArrayObject([NameObject(FT.FLATE_DECODE), *f])
                try:
                    params = ArrayObject(
                        [NullObject(), *self.get(SA.DECODE_PARMS, ArrayObject())]
                    )
                except TypeError:
                    # case of error where the * operator is not working (not an array
                    params = ArrayObject(
                        [NullObject(), self.get(SA.DECODE_PARMS, ArrayObject())]
                    )
            else:
                f = ArrayObject([NameObject(FT.FLATE_DECODE), f])
                params = ArrayObject(
                    [NullObject(), self.get(SA.DECODE_PARMS, NullObject())]
                )
        else:
            f = NameObject(FT.FLATE_DECODE)
            params = None
        retval = EncodedStreamObject()
        retval.update(self)
        retval[NameObject(SA.FILTER)] = f
        if params is not None:
            retval[NameObject(SA.DECODE_PARMS)] = params
        retval._data = FlateDecode.encode(self._data, level)
        return retval

    def decode_as_image(self, pillow_parameters: Union[dict[str, Any], None] = None) -> Any:
        """
        Try to decode the stream object as an image

        Args:
            pillow_parameters: parameters provided to Pillow Image.save() method,
                cf. <https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.Image.save>

        Returns:
            a PIL image if proper decoding has been found
        Raises:
            Exception: Errors during decoding will be reported.
                It is recommended to catch exceptions to prevent
                stops in your program.

        """
        from .._xobj_image_helpers import _xobj_to_image  # noqa: PLC0415

        if self.get("/Subtype", "") != "/Image":
            try:
                msg = f"{self.indirect_reference} does not seem to be an Image"  # pragma: no cover
            except AttributeError:
                msg = f"{self.__repr__()} object does not seem to be an Image"  # pragma: no cover
            logger_warning(msg, __name__)
        extension, _, img = _xobj_to_image(self, pillow_parameters)
        if extension is None:
            return None  # pragma: no cover
        return img


class DecodedStreamObject(StreamObject):
    pass


class EncodedStreamObject(StreamObject):
    def __init__(self) -> None:
        self.decoded_self: Optional[DecodedStreamObject] = None

    # This overrides the parent method
    def get_data(self) -> bytes:
        from ..filters import decode_stream_data  # noqa: PLC0415

        if self.decoded_self is not None:
            # Cached version of decoded object
            return self.decoded_self.get_data()

        # Create decoded object
        decoded = DecodedStreamObject()
        decoded.set_data(decode_stream_data(self))
        for key, value in self.items():
            if key not in (SA.LENGTH, SA.FILTER, SA.DECODE_PARMS):
                decoded[key] = value
        self.decoded_self = decoded
        return decoded.get_data()

    # This overrides the parent method:
    def set_data(self, data: bytes) -> None:
        from ..filters import FlateDecode  # noqa: PLC0415

        if self.get(SA.FILTER, "") in (FT.FLATE_DECODE, [FT.FLATE_DECODE]):
            if not isinstance(data, bytes):
                raise TypeError("Data must be bytes")
            if self.decoded_self is None:
                self.get_data()  # to create self.decoded_self
            assert self.decoded_self is not None, "mypy"
            self.decoded_self.set_data(data)
            super().set_data(FlateDecode.encode(data))
        else:
            raise PdfReadError(
                "Streams encoded with a filter different from FlateDecode are not supported"
            )


class ContentStream(DecodedStreamObject):
    """
    In order to be fast, this data structure can contain either:

    * raw data in ._data
    * parsed stream operations in ._operations.

    At any time, ContentStream object can either have both of those fields defined,
    or one field defined and the other set to None.

    These fields are "rebuilt" lazily, when accessed:

    * when .get_data() is called, if ._data is None, it is rebuilt from ._operations.
    * when .operations is called, if ._operations is None, it is rebuilt from ._data.

    Conversely, these fields can be invalidated:

    * when .set_data() is called, ._operations is set to None.
    * when .operations is set, ._data is set to None.
    """

    def __init__(
        self,
        stream: Any,
        pdf: Any,
        forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
    ) -> None:
        self.pdf = pdf
        self._operations: list[tuple[Any, bytes]] = []

        # stream may be a StreamObject or an ArrayObject containing
        # StreamObjects to be concatenated together.
        if stream is None:
            super().set_data(b"")
        else:
            stream = stream.get_object()
            if isinstance(stream, ArrayObject):
                data = b""
                for s in stream:
                    s_resolved = s.get_object()
                    if isinstance(s_resolved, NullObject):
                        continue
                    if not isinstance(s_resolved, StreamObject):
                        # No need to emit an exception here for now - the PDF structure
                        # seems to already be broken beforehand in these cases.
                        logger_warning(
                            f"Expected StreamObject, got {type(s_resolved).__name__} instead. Data might be wrong.",
                            __name__
                        )
                    else:
                        data += s_resolved.get_data()
                    if len(data) == 0 or data[-1] != b"\n":
                        data += b"\n"
                super().set_data(bytes(data))
            else:
                stream_data = stream.get_data()
                assert stream_data is not None
                super().set_data(stream_data)
        self.forced_encoding = forced_encoding

    def replicate(
        self,
        pdf_dest: PdfWriterProtocol,
    ) -> "ContentStream":
        d__ = cast(
            "ContentStream",
            self._reference_clone(self.__class__(None, None), pdf_dest, False),
        )
        d__._data = self._data
        try:
            decoded_self = self.decoded_self
            if decoded_self is None:
                self.decoded_self = None
            else:
                self.decoded_self = cast(
                    "DecodedStreamObject", decoded_self.replicate(pdf_dest)
                )
        except Exception:
            pass
        for k, v in self.items():
            d__[k.replicate(pdf_dest)] = (
                v.replicate(pdf_dest) if hasattr(v, "replicate") else v
            )
        return d__
        d__.set_data(self._data)
        d__.pdf = pdf_dest
        d__._operations = list(self._operations)
        d__.forced_encoding = self.forced_encoding
        return d__

    def clone(
        self,
        pdf_dest: Any,
        force_duplicate: bool = False,
        ignore_fields: Optional[Sequence[Union[str, int]]] = (),
    ) -> "ContentStream":
        """
        Clone object into pdf_dest.

        Args:
            pdf_dest:
            force_duplicate:
            ignore_fields:

        Returns:
            The cloned ContentStream

        """
        try:
            if self.indirect_reference.pdf == pdf_dest and not force_duplicate:  # type: ignore
                return self
        except Exception:
            pass

        visited: set[tuple[int, int]] = set()
        d__ = cast(
            "ContentStream",
            self._reference_clone(
                self.__class__(None, None), pdf_dest, force_duplicate
            ),
        )
        if ignore_fields is None:
            ignore_fields = []
        d__._clone(self, pdf_dest, force_duplicate, ignore_fields, visited)
        return d__

    def _clone(
        self,
        src: DictionaryObject,
        pdf_dest: PdfWriterProtocol,
        force_duplicate: bool,
        ignore_fields: Optional[Sequence[Union[str, int]]],
        visited: set[tuple[int, int]],
    ) -> None:
        """
        Update the object from src.

        Args:
            src:
            pdf_dest:
            force_duplicate:
            ignore_fields:

        """
        src_cs = cast("ContentStream", src)
        super().set_data(src_cs._data)
        self.pdf = pdf_dest
        self._operations = list(src_cs._operations)
        self.forced_encoding = src_cs.forced_encoding
        # no need to call DictionaryObjection or anything
        # like super(DictionaryObject,self)._clone(src, pdf_dest, force_duplicate, ignore_fields, visited)

    def _parse_content_stream(self, stream: StreamType) -> None:
        # 7.8.2 Content Streams
        stream.seek(0, 0)
        operands: list[Union[int, str, PdfObject]] = []
        while True:
            peek = read_non_whitespace(stream)
            if peek in (b"", 0):
                break
            stream.seek(-1, 1)
            if peek.isalpha() or peek in (b"'", b'"'):
                operator = read_until_regex(stream, NameObject.delimiter_pattern)
                if operator == b"BI":
                    # begin inline image - a completely different parsing
                    # mechanism is required, of course... thanks buddy...
                    assert operands == []
                    ii = self._read_inline_image(stream)
                    self._operations.append((ii, b"INLINE IMAGE"))
                else:
                    self._operations.append((operands, operator))
                    operands = []
            elif peek == b"%":
                # If we encounter a comment in the content stream, we have to
                # handle it here. Typically, read_object will handle
                # encountering a comment -- but read_object assumes that
                # following the comment must be the object we're trying to
                # read. In this case, it could be an operator instead.
                while peek not in (b"\r", b"\n", b""):
                    peek = stream.read(1)
            else:
                operands.append(read_object(stream, None, self.forced_encoding))

    def _read_inline_image(self, stream: StreamType) -> dict[str, Any]:
        # begin reading just after the "BI" - begin image
        # first read the dictionary of settings.
        settings = DictionaryObject()
        while True:
            tok = read_non_whitespace(stream)
            stream.seek(-1, 1)
            if tok == b"I":
                # "ID" - begin of image data
                break
            key = read_object(stream, self.pdf)
            tok = read_non_whitespace(stream)
            stream.seek(-1, 1)
            value = read_object(stream, self.pdf)
            settings[key] = value
        # left at beginning of ID
        tmp = stream.read(3)
        assert tmp[:2] == b"ID"
        filtr = settings.get("/F", settings.get("/Filter", "not set"))
        savpos = stream.tell()
        if isinstance(filtr, list):
            filtr = filtr[0]  # used forencoding
        if "AHx" in filtr or "ASCIIHexDecode" in filtr:
            data = extract_inline__ascii_hex_decode(stream)
        elif "A85" in filtr or "ASCII85Decode" in filtr:
            data = extract_inline__ascii85_decode(stream)
        elif "RL" in filtr or "RunLengthDecode" in filtr:
            data = extract_inline__run_length_decode(stream)
        elif "DCT" in filtr or "DCTDecode" in filtr:
            data = extract_inline__dct_decode(stream)
        elif filtr == "not set":
            cs = settings.get("/CS", "")
            if isinstance(cs, list):
                cs = cs[0]
            if "RGB" in cs:
                lcs = 3
            elif "CMYK" in cs:
                lcs = 4
            else:
                bits = settings.get(
                    "/BPC",
                    8 if cs in {"/I", "/G", "/Indexed", "/DeviceGray"} else -1,
                )
                if bits > 0:
                    lcs = bits / 8.0
                else:
                    data = extract_inline_default(stream)
                    lcs = -1
            if lcs > 0:
                data = stream.read(
                    ceil(cast(int, settings["/W"]) * lcs) * cast(int, settings["/H"])
                )
            # Move to the `EI` if possible.
            ei = read_non_whitespace(stream)
            stream.seek(-1, 1)
        else:
            data = extract_inline_default(stream)

        ei = stream.read(3)
        stream.seek(-1, 1)
        if ei[:2] != b"EI" or ei[2:3] not in WHITESPACES:
            # Deal with wrong/missing `EI` tags. Example: Wrong dimensions specified above.
            stream.seek(savpos, 0)
            data = extract_inline_default(stream)
            ei = stream.read(3)
            stream.seek(-1, 1)
            if ei[:2] != b"EI" or ei[2:3] not in WHITESPACES:  # pragma: no cover
                # Check the same condition again. This should never fail as
                # edge cases are covered by `extract_inline_default` above,
                # but check this ot make sure that we are behind the `EI` afterwards.
                raise PdfStreamError(
                    f"Could not extract inline image, even using fallback. Expected 'EI', got {ei!r}"
                )
        return {"settings": settings, "data": data}

    # This overrides the parent method
    def get_data(self) -> bytes:
        if not self._data:
            new_data = BytesIO()
            for operands, operator in self._operations:
                if operator == b"INLINE IMAGE":
                    new_data.write(b"BI")
                    dict_text = BytesIO()
                    operands["settings"].write_to_stream(dict_text)
                    new_data.write(dict_text.getvalue()[2:-2])
                    new_data.write(b"ID ")
                    new_data.write(operands["data"])
                    new_data.write(b"EI")
                else:
                    for op in operands:
                        op.write_to_stream(new_data)
                        new_data.write(b" ")
                    new_data.write(operator)
                new_data.write(b"\n")
            self._data = new_data.getvalue()
        return self._data

    # This overrides the parent method
    def set_data(self, data: bytes) -> None:
        super().set_data(data)
        self._operations = []

    @property
    def operations(self) -> list[tuple[Any, bytes]]:
        if not self._operations and self._data:
            self._parse_content_stream(BytesIO(self._data))
            self._data = b""
        return self._operations

    @operations.setter
    def operations(self, operations: list[tuple[Any, bytes]]) -> None:
        self._operations = operations
        self._data = b""

    def isolate_graphics_state(self) -> None:
        if self._operations:
            self._operations.insert(0, ([], b"q"))
            self._operations.append(([], b"Q"))
        elif self._data:
            self._data = b"q\n" + self._data + b"\nQ\n"

    # This overrides the parent method
    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        if not self._data and self._operations:
            self.get_data()  # this ensures ._data is rebuilt
        super().write_to_stream(stream, encryption_key)


def read_object(
    stream: StreamType,
    pdf: Optional[PdfReaderProtocol],
    forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
) -> Union[PdfObject, int, str, ContentStream]:
    tok = stream.read(1)
    stream.seek(-1, 1)  # reset to start
    if tok == b"/":
        return NameObject.read_from_stream(stream, pdf)
    if tok == b"<":
        # hexadecimal string OR dictionary
        peek = stream.read(2)
        stream.seek(-2, 1)  # reset to start
        if peek == b"<<":
            return DictionaryObject.read_from_stream(stream, pdf, forced_encoding)
        return read_hex_string_from_stream(stream, forced_encoding)
    if tok == b"[":
        return ArrayObject.read_from_stream(stream, pdf, forced_encoding)
    if tok in (b"t", b"f"):
        return BooleanObject.read_from_stream(stream)
    if tok == b"(":
        return read_string_from_stream(stream, forced_encoding)
    if tok == b"e" and stream.read(6) == b"endobj":
        return NullObject()
    if tok == b"n":
        return NullObject.read_from_stream(stream)
    if tok == b"%":
        # comment
        skip_over_comment(stream)
        tok = read_non_whitespace(stream)
        stream.seek(-1, 1)
        return read_object(stream, pdf, forced_encoding)
    if tok in b"0123456789+-.":
        # number object OR indirect reference
        peek = stream.read(20)
        stream.seek(-len(peek), 1)  # reset to start
        if IndirectPattern.match(peek) is not None:
            assert pdf is not None, "mypy"
            return IndirectObject.read_from_stream(stream, pdf)
        return NumberObject.read_from_stream(stream)
    pos = stream.tell()
    stream.seek(-20, 1)
    stream_extract = stream.read(80)
    stream.seek(pos)
    read_until_whitespace(stream)
    raise PdfReadError(
        f"Invalid Elementary Object starting with {tok!r} @{pos}: {stream_extract!r}"
    )


class Field(TreeObject):
    """
    A class representing a field dictionary.

    This class is accessed through
    :meth:`get_fields()<pypdf.PdfReader.get_fields>`
    """

    def __init__(self, data: DictionaryObject) -> None:
        DictionaryObject.__init__(self)
        field_attributes = (
            FieldDictionaryAttributes.attributes()
            + CheckboxRadioButtonAttributes.attributes()
        )
        self.indirect_reference = data.indirect_reference
        for attr in field_attributes:
            try:
                self[NameObject(attr)] = data[attr]
            except KeyError:
                pass
        if isinstance(self.get("/V"), EncodedStreamObject):
            d = cast(EncodedStreamObject, self[NameObject("/V")]).get_data()
            if isinstance(d, bytes):
                d_str = d.decode()
            elif d is None:
                d_str = ""
            else:
                raise Exception("Should never happen")
            self[NameObject("/V")] = TextStringObject(d_str)

    # TABLE 8.69 Entries common to all field dictionaries
    @property
    def field_type(self) -> Optional[NameObject]:
        """Read-only property accessing the type of this field."""
        return self.get(FieldDictionaryAttributes.FT)

    @property
    def parent(self) -> Optional[DictionaryObject]:
        """Read-only property accessing the parent of this field."""
        return self.get(FieldDictionaryAttributes.Parent)

    @property
    def kids(self) -> Optional["ArrayObject"]:
        """Read-only property accessing the kids of this field."""
        return self.get(FieldDictionaryAttributes.Kids)

    @property
    def name(self) -> Optional[str]:
        """Read-only property accessing the name of this field."""
        return self.get(FieldDictionaryAttributes.T)

    @property
    def alternate_name(self) -> Optional[str]:
        """Read-only property accessing the alternate name of this field."""
        return self.get(FieldDictionaryAttributes.TU)

    @property
    def mapping_name(self) -> Optional[str]:
        """
        Read-only property accessing the mapping name of this field.

        This name is used by pypdf as a key in the dictionary returned by
        :meth:`get_fields()<pypdf.PdfReader.get_fields>`
        """
        return self.get(FieldDictionaryAttributes.TM)

    @property
    def flags(self) -> Optional[int]:
        """
        Read-only property accessing the field flags, specifying various
        characteristics of the field (see Table 8.70 of the PDF 1.7 reference).
        """
        return self.get(FieldDictionaryAttributes.Ff)

    @property
    def value(self) -> Optional[Any]:
        """
        Read-only property accessing the value of this field.

        Format varies based on field type.
        """
        return self.get(FieldDictionaryAttributes.V)

    @property
    def default_value(self) -> Optional[Any]:
        """Read-only property accessing the default value of this field."""
        return self.get(FieldDictionaryAttributes.DV)

    @property
    def additional_actions(self) -> Optional[DictionaryObject]:
        """
        Read-only property accessing the additional actions dictionary.

        This dictionary defines the field's behavior in response to trigger
        events. See Section 8.5.2 of the PDF 1.7 reference.
        """
        return self.get(FieldDictionaryAttributes.AA)


class Destination(TreeObject):
    """
    A class representing a destination within a PDF file.

    See section 12.3.2 of the PDF 2.0 reference.

    Args:
        title: Title of this destination.
        page: Reference to the page of this destination. Should
            be an instance of :class:`IndirectObject<pypdf.generic.IndirectObject>`.
        fit: How the destination is displayed.

    Raises:
        PdfReadError: If destination type is invalid.

    """

    node: Optional[
        DictionaryObject
    ] = None  # node provide access to the original Object

    def __init__(
        self,
        title: Union[str, bytes],
        page: Union[NumberObject, IndirectObject, NullObject, DictionaryObject],
        fit: Fit,
    ) -> None:
        self._filtered_children: list[Any] = []  # used in PdfWriter

        typ = fit.fit_type
        args = fit.fit_args

        DictionaryObject.__init__(self)
        self[NameObject("/Title")] = TextStringObject(title)
        self[NameObject("/Page")] = page
        self[NameObject("/Type")] = typ

        # from table 8.2 of the PDF 1.7 reference.
        if typ == "/XYZ":
            if len(args) < 1:  # left is missing : should never occur
                args.append(NumberObject(0.0))
            if len(args) < 2:  # top is missing
                args.append(NumberObject(0.0))
            if len(args) < 3:  # zoom is missing
                args.append(NumberObject(0.0))
            (
                self[NameObject(TA.LEFT)],
                self[NameObject(TA.TOP)],
                self[NameObject("/Zoom")],
            ) = args
        elif len(args) == 0:
            pass
        elif typ == TF.FIT_R:
            (
                self[NameObject(TA.LEFT)],
                self[NameObject(TA.BOTTOM)],
                self[NameObject(TA.RIGHT)],
                self[NameObject(TA.TOP)],
            ) = args
        elif typ in [TF.FIT_H, TF.FIT_BH]:
            try:  # Prefer to be more robust not only to null parameters
                (self[NameObject(TA.TOP)],) = args
            except Exception:
                (self[NameObject(TA.TOP)],) = (NullObject(),)
        elif typ in [TF.FIT_V, TF.FIT_BV]:
            try:  # Prefer to be more robust not only to null parameters
                (self[NameObject(TA.LEFT)],) = args
            except Exception:
                (self[NameObject(TA.LEFT)],) = (NullObject(),)
        elif typ in [TF.FIT, TF.FIT_B]:
            pass
        else:
            raise PdfReadError(f"Unknown Destination Type: {typ!r}")

    @property
    def dest_array(self) -> "ArrayObject":
        return ArrayObject(
            [self.raw_get("/Page"), self["/Type"]]
            + [
                self[x]
                for x in ["/Left", "/Bottom", "/Right", "/Top", "/Zoom"]
                if x in self
            ]
        )

    def write_to_stream(
        self, stream: StreamType, encryption_key: Union[None, str, bytes] = None
    ) -> None:
        if encryption_key is not None:  # deprecated
            deprecation_no_replacement(
                "the encryption_key parameter of write_to_stream", "5.0.0"
            )
        stream.write(b"<<\n")
        key = NameObject("/D")
        key.write_to_stream(stream)
        stream.write(b" ")
        value = self.dest_array
        value.write_to_stream(stream)

        key = NameObject("/S")
        key.write_to_stream(stream)
        stream.write(b" ")
        value_s = NameObject("/GoTo")
        value_s.write_to_stream(stream)

        stream.write(b"\n")
        stream.write(b">>")

    @property
    def title(self) -> Optional[str]:
        """Read-only property accessing the destination title."""
        return self.get("/Title")

    @property
    def page(self) -> Optional[IndirectObject]:
        """Read-only property accessing the IndirectObject of the destination page."""
        return self.get("/Page")

    @property
    def typ(self) -> Optional[str]:
        """Read-only property accessing the destination type."""
        return self.get("/Type")

    @property
    def zoom(self) -> Optional[int]:
        """Read-only property accessing the zoom factor."""
        return self.get("/Zoom", None)

    @property
    def left(self) -> Optional[FloatObject]:
        """Read-only property accessing the left horizontal coordinate."""
        return self.get("/Left", None)

    @property
    def right(self) -> Optional[FloatObject]:
        """Read-only property accessing the right horizontal coordinate."""
        return self.get("/Right", None)

    @property
    def top(self) -> Optional[FloatObject]:
        """Read-only property accessing the top vertical coordinate."""
        return self.get("/Top", None)

    @property
    def bottom(self) -> Optional[FloatObject]:
        """Read-only property accessing the bottom vertical coordinate."""
        return self.get("/Bottom", None)

    @property
    def color(self) -> Optional["ArrayObject"]:
        """Read-only property accessing the color in (R, G, B) with values 0.0-1.0."""
        return self.get(
            "/C", ArrayObject([FloatObject(0), FloatObject(0), FloatObject(0)])
        )

    @property
    def font_format(self) -> Optional[OutlineFontFlag]:
        """
        Read-only property accessing the font type.

        1=italic, 2=bold, 3=both
        """
        return self.get("/F", 0)

    @property
    def outline_count(self) -> Optional[int]:
        """
        Read-only property accessing the outline count.

        positive = expanded
        negative = collapsed
        absolute value = number of visible descendants at all levels
        """
        return self.get("/Count", None)
