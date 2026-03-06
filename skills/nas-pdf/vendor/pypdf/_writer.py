# Copyright (c) 2006, Mathieu Fenniak
# Copyright (c) 2007, Ashish Kulkarni <kulkarni.ashish@gmail.com>
#
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

import decimal
import enum
import hashlib
import re
import struct
import sys
import uuid
from collections.abc import Iterable, Mapping
from io import BytesIO, FileIO, IOBase
from itertools import compress
from pathlib import Path
from re import Pattern
from types import TracebackType
from typing import (
    IO,
    Any,
    Callable,
    Optional,
    Union,
    cast,
)

if sys.version_info >= (3, 11):
    from typing import Self
else:
    from typing_extensions import Self

from ._doc_common import DocumentInformation, PdfDocCommon
from ._encryption import EncryptAlgorithm, Encryption
from ._page import PageObject, Transformation
from ._page_labels import nums_clear_range, nums_insert, nums_next
from ._reader import PdfReader
from ._utils import (
    StrByteType,
    StreamType,
    _get_max_pdf_version_header,
    deprecation_no_replacement,
    logger_warning,
)
from .constants import AnnotationDictionaryAttributes as AA
from .constants import CatalogAttributes as CA
from .constants import (
    CatalogDictionary,
    GoToActionArguments,
    ImageType,
    InteractiveFormDictEntries,
    OutlineFontFlag,
    PageLabelStyle,
    PagesAttributes,
    TypFitArguments,
    UserAccessPermissions,
)
from .constants import Core as CO
from .constants import FieldDictionaryAttributes as FA
from .constants import PageAttributes as PG
from .constants import TrailerKeys as TK
from .errors import PdfReadError, PyPdfError
from .generic import (
    PAGE_FIT,
    ArrayObject,
    BooleanObject,
    ByteStringObject,
    ContentStream,
    Destination,
    DictionaryObject,
    EmbeddedFile,
    Fit,
    FloatObject,
    IndirectObject,
    NameObject,
    NullObject,
    NumberObject,
    PdfObject,
    RectangleObject,
    ReferenceLink,
    StreamObject,
    TextStringObject,
    TreeObject,
    ViewerPreferences,
    create_string_object,
    extract_links,
    hex_to_rgb,
    is_null_or_none,
)
from .generic._appearance_stream import TextStreamAppearance
from .pagerange import PageRange, PageRangeSpec
from .types import (
    AnnotationSubtype,
    BorderArrayType,
    LayoutType,
    OutlineItemType,
    OutlineType,
    PagemodeType,
)
from .xmp import XmpInformation

ALL_DOCUMENT_PERMISSIONS = UserAccessPermissions.all()


class ObjectDeletionFlag(enum.IntFlag):
    NONE = 0
    TEXT = enum.auto()
    LINKS = enum.auto()
    ATTACHMENTS = enum.auto()
    OBJECTS_3D = enum.auto()
    ALL_ANNOTATIONS = enum.auto()
    XOBJECT_IMAGES = enum.auto()
    INLINE_IMAGES = enum.auto()
    DRAWING_IMAGES = enum.auto()
    IMAGES = XOBJECT_IMAGES | INLINE_IMAGES | DRAWING_IMAGES


def _rolling_checksum(stream: BytesIO, blocksize: int = 65536) -> str:
    hash = hashlib.md5(usedforsecurity=False)
    for block in iter(lambda: stream.read(blocksize), b""):
        hash.update(block)
    return hash.hexdigest()


class PdfWriter(PdfDocCommon):
    """
    Write a PDF file out, given pages produced by another class or through
    cloning a PDF file during initialization.

    Typically data is added from a :class:`PdfReader<pypdf.PdfReader>`.

    Args:
        clone_from: identical to fileobj (for compatibility)

        incremental: If true, loads the document and set the PdfWriter in incremental mode.

            When writing incrementally, the original document is written first and new/modified
            content is appended. To be used for signed document/forms to keep signature valid.

        full: If true, loads all the objects (always full if incremental = True).
            This parameter may allow loading large PDFs.

        strict: If true, pypdf will raise an exception if a PDF does not follow the specification.
            If false, pypdf will try to be forgiving and do something reasonable, but it will log
            a warning message. It is a best-effort approach.

    """

    def __init__(
        self,
        fileobj: Union[None, PdfReader, StrByteType, Path] = "",
        clone_from: Union[None, PdfReader, StrByteType, Path] = None,
        incremental: bool = False,
        full: bool = False,
        strict: bool = False,
    ) -> None:
        self.strict = strict
        """
        If true, pypdf will raise an exception if a PDF does not follow the specification.
        If false, pypdf will try to be forgiving and do something reasonable, but it will log
        a warning message. It is a best-effort approach.
        """

        self.incremental = incremental or full
        """
        Returns if the PdfWriter object has been started in incremental mode.
        """

        self._objects: list[Optional[PdfObject]] = []
        """
        The indirect objects in the PDF.
        For the incremental case, it will be filled with None
        in clone_reader_document_root.
        """

        self._original_hash: list[int] = []
        """
        List of hashes after import; used to identify changes.
        """

        self._idnum_hash: dict[bytes, tuple[IndirectObject, list[IndirectObject]]] = {}
        """
        Maps hash values of indirect objects to the list of IndirectObjects.
        This is used for compression.
        """

        self._id_translated: dict[int, dict[int, int]] = {}
        """List of already translated IDs.
           dict[id(pdf)][(idnum, generation)]
        """

        self._info_obj: Optional[PdfObject]
        """The PDF files's document information dictionary,
        defined by Info in the PDF file's trailer dictionary."""

        self._ID: Union[ArrayObject, None] = None
        """The PDF file identifier,
        defined by the ID in the PDF file's trailer dictionary."""

        self._unresolved_links: list[tuple[ReferenceLink, ReferenceLink]] = []
        "Tracks links in pages added to the writer for resolving later."
        self._merged_in_pages: dict[Optional[IndirectObject], Optional[IndirectObject]] = {}
        "Tracks pages added to the writer and what page they turned into."

        if self.incremental:
            if isinstance(fileobj, (str, Path)):
                with open(fileobj, "rb") as f:
                    fileobj = BytesIO(f.read(-1))
            if isinstance(fileobj, BytesIO):
                fileobj = PdfReader(fileobj)
            if not isinstance(fileobj, PdfReader):
                raise PyPdfError("Invalid type for incremental mode")
            self._reader = fileobj  # prev content is in _reader.stream
            self._header = fileobj.pdf_header.encode()
            self._readonly = True  # TODO: to be analysed
        else:
            self._header = b"%PDF-1.3"
            self._info_obj = self._add_object(
                DictionaryObject(
                    {NameObject("/Producer"): create_string_object("pypdf")}
                )
            )

        def _get_clone_from(
            fileobj: Union[None, PdfReader, str, Path, IO[Any], BytesIO],
            clone_from: Union[None, PdfReader, str, Path, IO[Any], BytesIO],
        ) -> Union[None, PdfReader, str, Path, IO[Any], BytesIO]:
            if isinstance(fileobj, (str, Path, IO, BytesIO)) and (
                fileobj == "" or clone_from is not None
            ):
                return clone_from
            cloning = True
            if isinstance(fileobj, (str, Path)) and (
                not Path(str(fileobj)).exists()
                or Path(str(fileobj)).stat().st_size == 0
            ):
                cloning = False
            if isinstance(fileobj, (IOBase, BytesIO)):
                t = fileobj.tell()
                if fileobj.seek(0, 2) == 0:
                    cloning = False
                fileobj.seek(t, 0)
            if cloning:
                clone_from = fileobj
            return clone_from

        clone_from = _get_clone_from(fileobj, clone_from)
        # To prevent overwriting
        self.temp_fileobj = fileobj
        self.fileobj = ""
        self._with_as_usage = False
        self._cloned = False
        # The root of our page tree node
        pages = DictionaryObject(
            {
                NameObject(PagesAttributes.TYPE): NameObject("/Pages"),
                NameObject(PagesAttributes.COUNT): NumberObject(0),
                NameObject(PagesAttributes.KIDS): ArrayObject(),
            }
        )
        self.flattened_pages = []
        self._encryption: Optional[Encryption] = None
        self._encrypt_entry: Optional[DictionaryObject] = None

        if clone_from is not None:
            if not isinstance(clone_from, PdfReader):
                clone_from = PdfReader(clone_from)
            self.clone_document_from_reader(clone_from)
            self._cloned = True
        else:
            self._pages = self._add_object(pages)
            self._root_object = DictionaryObject(
                {
                    NameObject(PagesAttributes.TYPE): NameObject(CO.CATALOG),
                    NameObject(CO.PAGES): self._pages,
                }
            )
            self._add_object(self._root_object)
        if full and not incremental:
            self.incremental = False
        if isinstance(self._ID, list):
            if isinstance(self._ID[0], TextStringObject):
                self._ID[0] = ByteStringObject(self._ID[0].get_original_bytes())
            if isinstance(self._ID[1], TextStringObject):
                self._ID[1] = ByteStringObject(self._ID[1].get_original_bytes())

    # for commonality
    @property
    def is_encrypted(self) -> bool:
        """
        Read-only boolean property showing whether this PDF file is encrypted.

        Note that this property, if true, will remain true even after the
        :meth:`decrypt()<pypdf.PdfReader.decrypt>` method is called.
        """
        return False

    @property
    def root_object(self) -> DictionaryObject:
        """
        Provide direct access to PDF Structure.

        Note:
            Recommended only for read access.

        """
        return self._root_object

    @property
    def _info(self) -> Optional[DictionaryObject]:
        """
        Provide access to "/Info". Standardized with PdfReader.

        Returns:
            /Info Dictionary; None if the entry does not exist

        """
        return (
            None
            if self._info_obj is None
            else cast(DictionaryObject, self._info_obj.get_object())
        )

    @_info.setter
    def _info(self, value: Optional[Union[IndirectObject, DictionaryObject]]) -> None:
        if value is None:
            try:
                self._objects[self._info_obj.indirect_reference.idnum - 1] = None  # type: ignore
            except (KeyError, AttributeError):
                pass
            self._info_obj = None
        else:
            if self._info_obj is None:
                self._info_obj = self._add_object(DictionaryObject())
            obj = cast(DictionaryObject, self._info_obj.get_object())
            obj.clear()
            obj.update(cast(DictionaryObject, value.get_object()))

    @property
    def xmp_metadata(self) -> Optional[XmpInformation]:
        """XMP (Extensible Metadata Platform) data."""
        return cast(XmpInformation, self.root_object.xmp_metadata)

    @xmp_metadata.setter
    def xmp_metadata(self, value: Union[XmpInformation, bytes, None]) -> None:
        """XMP (Extensible Metadata Platform) data."""
        if value is None:
            if "/Metadata" in self.root_object:
                del self.root_object["/Metadata"]
            return

        metadata = self.root_object.get("/Metadata", None)
        if not isinstance(metadata, IndirectObject):
            if metadata is not None:
                del self.root_object["/Metadata"]
            metadata_stream = StreamObject()
            stream_reference = self._add_object(metadata_stream)
            self.root_object[NameObject("/Metadata")] = stream_reference
        else:
            metadata_stream = cast(StreamObject, metadata.get_object())

        if isinstance(value, XmpInformation):
            bytes_data = value.stream.get_data()
        else:
            bytes_data = value
        metadata_stream.set_data(bytes_data)

    @property
    def with_as_usage(self) -> bool:
        deprecation_no_replacement("with_as_usage", "5.0")
        return self._with_as_usage

    @with_as_usage.setter
    def with_as_usage(self, value: bool) -> None:
        deprecation_no_replacement("with_as_usage", "5.0")
        self._with_as_usage = value

    def __enter__(self) -> Self:
        """Store how writer is initialized by 'with'."""
        c: bool = self._cloned
        t = self.temp_fileobj
        self.__init__()  # type: ignore
        self._cloned = c
        self._with_as_usage = True
        self.fileobj = t  # type: ignore
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        """Write data to the fileobj."""
        if self.fileobj and not self._cloned:
            self.write(self.fileobj)

    @property
    def pdf_header(self) -> str:
        """
        Read/Write property of the PDF header that is written.

        This should be something like ``'%PDF-1.5'``. It is recommended to set
        the lowest version that supports all features which are used within the
        PDF file.

        Note: `pdf_header` returns a string but accepts bytes or str for writing
        """
        return self._header.decode()

    @pdf_header.setter
    def pdf_header(self, new_header: Union[str, bytes]) -> None:
        if isinstance(new_header, str):
            new_header = new_header.encode()
        self._header = new_header

    def _add_object(self, obj: PdfObject) -> IndirectObject:
        if (
            getattr(obj, "indirect_reference", None) is not None
            and obj.indirect_reference.pdf == self  # type: ignore
        ):
            return obj.indirect_reference  # type: ignore
        # check for /Contents in Pages (/Contents in annotations are strings)
        if isinstance(obj, DictionaryObject) and isinstance(
            obj.get(PG.CONTENTS, None), (ArrayObject, DictionaryObject)
        ):
            obj[NameObject(PG.CONTENTS)] = self._add_object(obj[PG.CONTENTS])
        self._objects.append(obj)
        obj.indirect_reference = IndirectObject(len(self._objects), 0, self)
        return obj.indirect_reference

    def get_object(
        self,
        indirect_reference: Union[int, IndirectObject],
    ) -> PdfObject:
        if isinstance(indirect_reference, int):
            obj = self._objects[indirect_reference - 1]
        elif indirect_reference.pdf != self:
            raise ValueError("PDF must be self")
        else:
            obj = self._objects[indirect_reference.idnum - 1]
        assert obj is not None, "mypy"
        return obj

    def _replace_object(
        self,
        indirect_reference: Union[int, IndirectObject],
        obj: PdfObject,
    ) -> PdfObject:
        if isinstance(indirect_reference, IndirectObject):
            if indirect_reference.pdf != self:
                raise ValueError("PDF must be self")
            indirect_reference = indirect_reference.idnum
        gen = self._objects[indirect_reference - 1].indirect_reference.generation  # type: ignore
        if (
            getattr(obj, "indirect_reference", None) is not None
            and obj.indirect_reference.pdf != self  # type: ignore
        ):
            obj = obj.clone(self)
        self._objects[indirect_reference - 1] = obj
        obj.indirect_reference = IndirectObject(indirect_reference, gen, self)

        assert isinstance(obj, PdfObject), "mypy"
        return obj

    def _add_page(
        self,
        page: PageObject,
        index: int,
        excluded_keys: Iterable[str] = (),
    ) -> PageObject:
        if not isinstance(page, PageObject) or page.get(PagesAttributes.TYPE, None) != CO.PAGE:
            raise ValueError("Invalid page object")
        assert self.flattened_pages is not None, "for mypy"
        page_org = page
        excluded_keys = list(excluded_keys)
        excluded_keys += [PagesAttributes.PARENT, "/StructParents"]
        # Acrobat does not accept two indirect references pointing on the same
        # page; therefore in order to add multiple copies of the same
        # page, we need to create a new dictionary for the page, however the
        # objects below (including content) are not duplicated:
        try:  # delete an already existing page
            del self._id_translated[id(page_org.indirect_reference.pdf)][  # type: ignore
                page_org.indirect_reference.idnum  # type: ignore
            ]
        except Exception:
            pass

        page = cast(
            "PageObject", page_org.clone(self, False, excluded_keys).get_object()
        )
        if page_org.pdf is not None:
            other = page_org.pdf.pdf_header
            self.pdf_header = _get_max_pdf_version_header(self.pdf_header, other)

        node, idx = self._get_page_in_node(index)
        page[NameObject(PagesAttributes.PARENT)] = node.indirect_reference

        if idx >= 0:
            cast(ArrayObject, node[PagesAttributes.KIDS]).insert(idx, page.indirect_reference)
            self.flattened_pages.insert(index, page)
        else:
            cast(ArrayObject, node[PagesAttributes.KIDS]).append(page.indirect_reference)
            self.flattened_pages.append(page)
        recurse = 0
        while not is_null_or_none(node):
            node = cast(DictionaryObject, node.get_object())
            node[NameObject(PagesAttributes.COUNT)] = NumberObject(cast(int, node[PagesAttributes.COUNT]) + 1)
            node = node.get(PagesAttributes.PARENT, None)  # type: ignore[assignment]  # TODO: Fix.
            recurse += 1
            if recurse > 1000:
                raise PyPdfError("Too many recursive calls!")

        if page_org.pdf is not None:
            # the page may contain links to other pages, and those other
            # pages may or may not already be added.  we store the
            # information we need, so that we can resolve the references
            # later.
            self._unresolved_links.extend(extract_links(page, page_org))
            self._merged_in_pages[page_org.indirect_reference] = page.indirect_reference

        return page

    def set_need_appearances_writer(self, state: bool = True) -> None:
        """
        Sets the "NeedAppearances" flag in the PDF writer.

        The "NeedAppearances" flag indicates whether the appearance dictionary
        for form fields should be automatically generated by the PDF viewer or
        if the embedded appearance should be used.

        Args:
            state: The actual value of the NeedAppearances flag.

        Returns:
            None

        """
        # See §12.7.2 and §7.7.2 for more information:
        # https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
        try:
            # get the AcroForm tree
            if CatalogDictionary.ACRO_FORM not in self._root_object:
                self._root_object[
                    NameObject(CatalogDictionary.ACRO_FORM)
                ] = self._add_object(DictionaryObject())

            need_appearances = NameObject(InteractiveFormDictEntries.NeedAppearances)
            cast(DictionaryObject, self._root_object[CatalogDictionary.ACRO_FORM])[
                need_appearances
            ] = BooleanObject(state)
        except Exception as exc:  # pragma: no cover
            logger_warning(
                f"set_need_appearances_writer({state}) catch : {exc}", __name__
            )

    def create_viewer_preferences(self) -> ViewerPreferences:
        o = ViewerPreferences()
        self._root_object[
            NameObject(CatalogDictionary.VIEWER_PREFERENCES)
        ] = self._add_object(o)
        return o

    def add_page(
        self,
        page: PageObject,
        excluded_keys: Iterable[str] = (),
    ) -> PageObject:
        """
        Add a page to this PDF file.

        Recommended for advanced usage including the adequate excluded_keys.

        The page is usually acquired from a :class:`PdfReader<pypdf.PdfReader>`
        instance.

        Args:
            page: The page to add to the document. Should be
                an instance of :class:`PageObject<pypdf._page.PageObject>`
            excluded_keys:

        Returns:
            The added PageObject.

        """
        assert self.flattened_pages is not None, "mypy"
        return self._add_page(page, len(self.flattened_pages), excluded_keys)

    def insert_page(
        self,
        page: PageObject,
        index: int = 0,
        excluded_keys: Iterable[str] = (),
    ) -> PageObject:
        """
        Insert a page in this PDF file. The page is usually acquired from a
        :class:`PdfReader<pypdf.PdfReader>` instance.

        Args:
            page: The page to add to the document.
            index: Position at which the page will be inserted.
            excluded_keys:

        Returns:
            The added PageObject.

        """
        assert self.flattened_pages is not None, "mypy"
        if index < 0:
            index += len(self.flattened_pages)
        if index < 0:
            raise ValueError("Invalid index value")
        if index >= len(self.flattened_pages):
            return self.add_page(page, excluded_keys)
        return self._add_page(page, index, excluded_keys)

    def _get_page_number_by_indirect(
        self, indirect_reference: Union[None, int, NullObject, IndirectObject]
    ) -> Optional[int]:
        """
        Generate _page_id2num.

        Args:
            indirect_reference:

        Returns:
            The page number or None

        """
        # To provide same function as in PdfReader
        if is_null_or_none(indirect_reference):
            return None
        assert indirect_reference is not None, "mypy"
        if isinstance(indirect_reference, int):
            indirect_reference = IndirectObject(indirect_reference, 0, self)
        obj = indirect_reference.get_object()
        if isinstance(obj, PageObject):
            return obj.page_number
        return None

    def add_blank_page(
        self, width: Optional[float] = None, height: Optional[float] = None
    ) -> PageObject:
        """
        Append a blank page to this PDF file and return it.

        If no page size is specified, use the size of the last page.

        Args:
            width: The width of the new page expressed in default user
                space units.
            height: The height of the new page expressed in default
                user space units.

        Returns:
            The newly appended page.

        Raises:
            PageSizeNotDefinedError: if width and height are not defined
                and previous page does not exist.

        """
        page = PageObject.create_blank_page(self, width, height)
        return self.add_page(page)

    def insert_blank_page(
        self,
        width: Optional[Union[float, decimal.Decimal]] = None,
        height: Optional[Union[float, decimal.Decimal]] = None,
        index: int = 0,
    ) -> PageObject:
        """
        Insert a blank page to this PDF file and return it.

        If no page size is specified for a dimension, use the size of the last page.

        Args:
            width: The width of the new page expressed in default user
                space units.
            height: The height of the new page expressed in default
                user space units.
            index: Position to add the page.

        Returns:
            The newly inserted page.

        Raises:
            PageSizeNotDefinedError: if width and height are not defined
                and previous page does not exist.

        """
        if width is None or (height is None and index < self.get_num_pages()):
            oldpage = self.pages[index]
            width = oldpage.mediabox.width
            height = oldpage.mediabox.height
        page = PageObject.create_blank_page(self, width, height)
        self.insert_page(page, index)
        return page

    @property
    def open_destination(
        self,
    ) -> Union[None, Destination, TextStringObject, ByteStringObject]:
        return super().open_destination

    @open_destination.setter
    def open_destination(self, dest: Union[None, str, Destination, PageObject]) -> None:
        if dest is None:
            try:
                del self._root_object["/OpenAction"]
            except KeyError:
                pass
        elif isinstance(dest, str):
            self._root_object[NameObject("/OpenAction")] = TextStringObject(dest)
        elif isinstance(dest, Destination):
            self._root_object[NameObject("/OpenAction")] = dest.dest_array
        elif isinstance(dest, PageObject):
            self._root_object[NameObject("/OpenAction")] = Destination(
                "Opening",
                dest.indirect_reference
                if dest.indirect_reference is not None
                else NullObject(),
                PAGE_FIT,
            ).dest_array

    def add_js(self, javascript: str) -> None:
        """
        Add JavaScript which will launch upon opening this PDF.

        Args:
            javascript: Your JavaScript.

        Example:
            This will launch the print window when the PDF is opened.

            >>> from pypdf import PdfWriter
            >>> output = PdfWriter()
            >>> output.add_js("this.print({bUI:true,bSilent:false,bShrinkToFit:true});")

        """
        # Names / JavaScript preferred to be able to add multiple scripts
        if "/Names" not in self._root_object:
            self._root_object[NameObject(CA.NAMES)] = DictionaryObject()
        names = cast(DictionaryObject, self._root_object[CA.NAMES])
        if "/JavaScript" not in names:
            names[NameObject("/JavaScript")] = DictionaryObject(
                {NameObject("/Names"): ArrayObject()}
            )
        js_list = cast(
            ArrayObject, cast(DictionaryObject, names["/JavaScript"])["/Names"]
        )
        # We need a name for parameterized JavaScript in the PDF file,
        # but it can be anything.
        js_list.append(create_string_object(str(uuid.uuid4())))

        js = DictionaryObject(
            {
                NameObject(PagesAttributes.TYPE): NameObject("/Action"),
                NameObject("/S"): NameObject("/JavaScript"),
                NameObject("/JS"): TextStringObject(f"{javascript}"),
            }
        )
        js_list.append(self._add_object(js))

    def add_attachment(self, filename: str, data: Union[str, bytes]) -> "EmbeddedFile":
        """
        Embed a file inside the PDF.

        Reference:
        https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf
        Section 7.11.3

        Args:
            filename: The filename to display.
            data: The data in the file.

        Returns:
            EmbeddedFile instance for the newly created embedded file.

        """
        return EmbeddedFile._create_new(self, filename, data)

    def append_pages_from_reader(
        self,
        reader: PdfReader,
        after_page_append: Optional[Callable[[PageObject], None]] = None,
    ) -> None:
        """
        Copy pages from reader to writer. Includes an optional callback
        parameter which is invoked after pages are appended to the writer.

        ``append`` should be preferred.

        Args:
            reader: a PdfReader object from which to copy page
                annotations to this writer object. The writer's annots
                will then be updated.
            after_page_append:
                Callback function that is invoked after each page is appended to
                the writer. Signature includes a reference to the appended page
                (delegates to append_pages_from_reader). The single parameter of
                the callback is a reference to the page just appended to the
                document.

        """
        reader_num_pages = len(reader.pages)
        # Copy pages from reader to writer
        for reader_page_number in range(reader_num_pages):
            reader_page = reader.pages[reader_page_number]
            writer_page = self.add_page(reader_page)
            # Trigger callback, pass writer page as parameter
            if callable(after_page_append):
                after_page_append(writer_page)

    def _merge_content_stream_to_page(
        self,
        page: PageObject,
        new_content_data: bytes,
    ) -> None:
        """
        Combines existing content stream(s) with new content (as bytes).

        Args:
            page: The page to which the new content data will be added.
            new_content_data: A binary-encoded new content stream, for
                instance the commands to draw an XObject.
        """
        # First resolve the existing page content. This always is an IndirectObject:
        # PDF Explained by John Whitington
        # https://www.oreilly.com/library/view/pdf-explained/9781449321581/ch04.html
        if NameObject("/Contents") in page:
            existing_content_ref = page[NameObject("/Contents")]
            existing_content = existing_content_ref.get_object()

            if isinstance(existing_content, ArrayObject):
                # Create a new StreamObject for the new_content_data
                new_stream_obj = StreamObject()
                new_stream_obj.set_data(new_content_data)
                existing_content.append(self._add_object(new_stream_obj))
                page[NameObject("/Contents")] = self._add_object(existing_content)
            if isinstance(existing_content, StreamObject):
                # Merge new content to existing StreamObject
                merged_data = existing_content.get_data() + b"\n" + new_content_data
                new_stream = StreamObject()
                new_stream.set_data(merged_data)
                page[NameObject("/Contents")] = self._add_object(new_stream)
        else:
            # If no existing content, then we have an empty page.
            # Create a new StreamObject in a new /Contents entry.
            new_stream = StreamObject()
            new_stream.set_data(new_content_data)
            page[NameObject("/Contents")] = self._add_object(new_stream)

    def _add_apstream_object(
            self,
            page: PageObject,
            appearance_stream_obj: StreamObject,
            object_name: str,
            x_offset: float,
            y_offset: float,
        ) -> None:
        """
        Adds an appearance stream to the page content in the form of
        an XObject.

        Args:
            page: The page to which to add the appearance stream.
            appearance_stream_obj: The appearance stream.
            object_name: The name of the appearance stream.
            x_offset: The horizontal offset for the appearance stream.
            y_offset: The vertical offset for the appearance stream.
        """
        # Prepare XObject resource dictionary on the page. This currently
        # only deals with font resources, but can easily be adapted to also
        # include other resources.
        pg_res = cast(DictionaryObject, page[PG.RESOURCES])
        if "/Resources" in appearance_stream_obj:
            ap_stream_res = cast(DictionaryObject, appearance_stream_obj["/Resources"])
            ap_stream_font_dict = cast(DictionaryObject, ap_stream_res.get("/Font", DictionaryObject()))
            if "/Font" not in pg_res:
                font_dict_ref = self._add_object(DictionaryObject())
                pg_res[NameObject("/Font")] = font_dict_ref
            pg_font_res = cast(DictionaryObject, pg_res["/Font"].get_object())
            # Merge fonts from the appearance stream into the page's font resources
            for font_name, font_res in ap_stream_font_dict.items():
                if font_name not in pg_font_res:
                    font_res_ref = self._add_object(font_res)
                    pg_font_res[font_name] = font_res_ref
        # Always add the resolved stream object to the writer to get a new IndirectObject.
        # This ensures we have a valid IndirectObject managed by *this* writer.
        xobject_ref = self._add_object(appearance_stream_obj)
        xobject_name = NameObject(f"/Fm_{object_name}")._sanitize()
        if "/XObject" not in pg_res:
            pg_res[NameObject("/XObject")] = DictionaryObject()
        pg_xo_res  = cast(DictionaryObject, pg_res["/XObject"])
        if xobject_name not in pg_xo_res:
            pg_xo_res[xobject_name] = xobject_ref
        else:
            logger_warning(
                f"XObject {xobject_name!r} already added to page resources. This might be an issue.",
                __name__
            )
        xobject_cm = Transformation().translate(x_offset, y_offset)
        xobject_drawing_commands = f"q\n{xobject_cm._to_cm()}\n{xobject_name} Do\nQ".encode()
        self._merge_content_stream_to_page(page, xobject_drawing_commands)

    FFBITS_NUL = FA.FfBits(0)

    def update_page_form_field_values(
        self,
        page: Union[PageObject, list[PageObject], None],
        fields: Mapping[str, Union[str, list[str], tuple[str, str, float]]],
        flags: FA.FfBits = FFBITS_NUL,
        auto_regenerate: Optional[bool] = True,
        flatten: bool = False,
    ) -> None:
        """
        Update the form field values for a given page from a fields dictionary.

        Copy field texts and values from fields to page.
        If the field links to a parent object, add the information to the parent.

        Args:
            page: `PageObject` - references **PDF writer's page** where the
                annotations and field data will be updated.
                `List[Pageobject]` - provides list of pages to be processed.
                `None` - all pages.
            fields: a Python dictionary of:

                * field names (/T) as keys and text values (/V) as value
                * field names (/T) as keys and list of text values (/V) for multiple choice list
                * field names (/T) as keys and tuple of:
                    * text values (/V)
                    * font id (e.g. /F1, the font id must exist)
                    * font size (0 for autosize)

            flags: A set of flags from :class:`~pypdf.constants.FieldDictionaryAttributes.FfBits`.

            auto_regenerate: Set/unset the need_appearances flag;
                the flag is unchanged if auto_regenerate is None.

            flatten: Whether or not to flatten the annotation. If True, this adds the annotation's
                appearance stream to the page contents. Note that this option does not remove the
                annotation itself.

        """
        if CatalogDictionary.ACRO_FORM not in self._root_object:
            raise PyPdfError("No /AcroForm dictionary in PDF of PdfWriter Object")
        acro_form = cast(DictionaryObject, self._root_object[CatalogDictionary.ACRO_FORM])
        if InteractiveFormDictEntries.Fields not in acro_form:
            raise PyPdfError("No /Fields dictionary in PDF of PdfWriter Object")
        if isinstance(auto_regenerate, bool):
            self.set_need_appearances_writer(auto_regenerate)
        # Iterate through pages, update field values
        if page is None:
            page = list(self.pages)
        if isinstance(page, list):
            for p in page:
                if PG.ANNOTS in p:  # just to prevent warnings
                    self.update_page_form_field_values(p, fields, flags, None, flatten=flatten)
            return
        if PG.ANNOTS not in page:
            logger_warning("No fields to update on this page", __name__)
            return
        appearance_stream_obj: Optional[StreamObject] = None

        for annotation in page[PG.ANNOTS]:  # type: ignore
            annotation = cast(DictionaryObject, annotation.get_object())
            if annotation.get("/Subtype", "") != "/Widget":
                continue
            if "/FT" in annotation and "/T" in annotation:
                parent_annotation = annotation
            else:
                parent_annotation = annotation.get(
                    PG.PARENT, DictionaryObject()
                ).get_object()

            for field, value in fields.items():
                rectangle = cast(RectangleObject, annotation[AA.Rect])
                if not (
                    self._get_qualified_field_name(parent_annotation) == field
                    or parent_annotation.get("/T", None) == field
                ):
                    continue
                if (
                    parent_annotation.get("/FT", None) == "/Ch"
                    and "/I" in parent_annotation
                ):
                    del parent_annotation["/I"]
                if flags:
                    annotation[NameObject(FA.Ff)] = NumberObject(flags)
                # Set the field value
                if not (value is None and flatten):  # Only change values if given by user and not flattening.
                    if isinstance(value, list):
                        lst = ArrayObject(TextStringObject(v) for v in value)
                        parent_annotation[NameObject(FA.V)] = lst
                    elif isinstance(value, tuple):
                        annotation[NameObject(FA.V)] = TextStringObject(
                            value[0],
                        )
                    else:
                        parent_annotation[NameObject(FA.V)] = TextStringObject(value)
                # Get or create the field's appearance stream object
                if parent_annotation.get(FA.FT) == "/Btn":
                    # Checkbox button (no /FT found in Radio widgets);
                    # We can find the associated appearance stream object
                    # within the annotation.
                    v = NameObject(value)
                    ap = cast(DictionaryObject, annotation[NameObject(AA.AP)])
                    normal_ap = cast(DictionaryObject, ap["/N"])
                    if v not in normal_ap:
                        v = NameObject("/Off")
                    appearance_stream_obj = normal_ap.get(v)
                    # Other cases will be updated through the for loop
                    annotation[NameObject(AA.AS)] = v
                    annotation[NameObject(FA.V)] = v
                elif (
                    parent_annotation.get(FA.FT) == "/Tx"
                    or parent_annotation.get(FA.FT) == "/Ch"
                ):
                    # Textbox; we need to generate the appearance stream object
                    if isinstance(value, tuple):
                        appearance_stream_obj = TextStreamAppearance.from_text_annotation(
                            acro_form, parent_annotation, annotation, value[1], value[2]
                        )
                    else:
                        appearance_stream_obj = TextStreamAppearance.from_text_annotation(
                            acro_form, parent_annotation, annotation
                        )
                    # Add the appearance stream object
                    if AA.AP not in annotation:
                        annotation[NameObject(AA.AP)] = DictionaryObject(
                            {NameObject("/N"): self._add_object(appearance_stream_obj)}
                        )
                    elif "/N" not in (ap:= cast(DictionaryObject, annotation[AA.AP])):
                        cast(DictionaryObject, annotation[NameObject(AA.AP)])[
                            NameObject("/N")
                        ] = self._add_object(appearance_stream_obj)
                    else:  # [/AP][/N] exists
                        n = annotation[AA.AP]["/N"].indirect_reference.idnum  # type: ignore
                        self._objects[n - 1] = appearance_stream_obj
                        appearance_stream_obj.indirect_reference = IndirectObject(n, 0, self)
                elif (
                    annotation.get(FA.FT) == "/Sig"
                ):  # deprecated  # not implemented yet
                    logger_warning("Signature forms not implemented yet", __name__)
                if flatten and appearance_stream_obj is not None:
                    self._add_apstream_object(page, appearance_stream_obj, field, rectangle[0], rectangle[1])

    def reattach_fields(
        self, page: Optional[PageObject] = None
    ) -> list[DictionaryObject]:
        """
        Parse annotations within the page looking for orphan fields and
        reattach then into the Fields Structure.

        Args:
            page: page to analyze.
                  If none is provided, all pages will be analyzed.

        Returns:
            list of reattached fields.

        """
        lst = []
        if page is None:
            for p in self.pages:
                lst += self.reattach_fields(p)
            return lst

        try:
            af = cast(DictionaryObject, self._root_object[CatalogDictionary.ACRO_FORM])
        except KeyError:
            af = DictionaryObject()
            self._root_object[NameObject(CatalogDictionary.ACRO_FORM)] = af
        try:
            fields = cast(ArrayObject, af[InteractiveFormDictEntries.Fields])
        except KeyError:
            fields = ArrayObject()
            af[NameObject(InteractiveFormDictEntries.Fields)] = fields

        if "/Annots" not in page:
            return lst
        annotations = cast(ArrayObject, page["/Annots"])
        for idx, annotation in enumerate(annotations):
            is_indirect = isinstance(annotation, IndirectObject)
            annotation = cast(DictionaryObject, annotation.get_object())
            if annotation.get("/Subtype", "") == "/Widget" and "/FT" in annotation:
                if (
                    "indirect_reference" in annotation.__dict__
                    and annotation.indirect_reference in fields
                ):
                    continue
                if not is_indirect:
                    annotations[idx] = self._add_object(annotation)
                fields.append(annotation.indirect_reference)
                lst.append(annotation)
        return lst

    def clone_reader_document_root(self, reader: PdfReader) -> None:
        """
        Copy the reader document root to the writer and all sub-elements,
        including pages, threads, outlines,... For partial insertion, ``append``
        should be considered.

        Args:
            reader: PdfReader from which the document root should be copied.

        """
        self._info_obj = None
        if self.incremental:
            self._objects = [None] * (cast(int, reader.trailer["/Size"]) - 1)
            for i in range(len(self._objects)):
                o = reader.get_object(i + 1)
                if o is not None:
                    self._objects[i] = o.replicate(self)
        else:
            self._objects.clear()
        self._root_object = reader.root_object.clone(self)
        self._pages = self._root_object.raw_get("/Pages")

        if len(self._objects) > cast(int, reader.trailer["/Size"]):
            if self.strict:
                raise PdfReadError(
                    f"Object count {len(self._objects)} exceeds defined trailer size {reader.trailer['/Size']}"
                )
            logger_warning(
                f"Object count {len(self._objects)} exceeds defined trailer size {reader.trailer['/Size']}",
                __name__
            )

        # must be done here before rewriting
        if self.incremental:
            self._original_hash = [
                (obj.hash_bin() if obj is not None else 0) for obj in self._objects
            ]

        try:
            self._flatten()
        except IndexError:
            raise PdfReadError("Got index error while flattening.")

        assert self.flattened_pages is not None
        for p in self.flattened_pages:
            self._replace_object(cast(IndirectObject, p.indirect_reference).idnum, p)
            if not self.incremental:
                p[NameObject("/Parent")] = self._pages
        if not self.incremental:
            cast(DictionaryObject, self._pages.get_object())[
                NameObject("/Kids")
            ] = ArrayObject([p.indirect_reference for p in self.flattened_pages])

    def clone_document_from_reader(
        self,
        reader: PdfReader,
        after_page_append: Optional[Callable[[PageObject], None]] = None,
    ) -> None:
        """
        Create a copy (clone) of a document from a PDF file reader cloning
        section '/Root' and '/Info' and '/ID' of the pdf.

        Args:
            reader: PDF file reader instance from which the clone
                should be created.
            after_page_append:
                Callback function that is invoked after each page is appended to
                the writer. Signature includes a reference to the appended page
                (delegates to append_pages_from_reader). The single parameter of
                the callback is a reference to the page just appended to the
                document.

        """
        self.clone_reader_document_root(reader)
        inf = reader._info
        if self.incremental:
            if inf is not None:
                self._info_obj = cast(
                    IndirectObject, inf.clone(self).indirect_reference
                )
                assert isinstance(self._info, DictionaryObject), "for mypy"
                self._original_hash[
                    self._info_obj.indirect_reference.idnum - 1
                ] = self._info.hash_bin()
        elif inf is not None:
            self._info_obj = self._add_object(
                DictionaryObject(cast(DictionaryObject, inf.get_object()))
            )
        # else: _info_obj = None done in clone_reader_document_root()

        try:
            self._ID = cast(ArrayObject, reader._ID).clone(self)
        except AttributeError:
            pass

        if callable(after_page_append):
            for page in cast(
                ArrayObject, cast(DictionaryObject, self._pages.get_object())["/Kids"]
            ):
                after_page_append(page.get_object())

    def _compute_document_identifier(self) -> ByteStringObject:
        stream = BytesIO()
        self._write_pdf_structure(stream)
        stream.seek(0)
        return ByteStringObject(_rolling_checksum(stream).encode("utf8"))

    def generate_file_identifiers(self) -> None:
        """
        Generate an identifier for the PDF that will be written.

        The only point of this is ensuring uniqueness. Reproducibility is not
        required.
        When a file is first written, both identifiers shall be set to the same value.
        If both identifiers match when a file reference is resolved, it is very
        likely that the correct and unchanged file has been found. If only the first
        identifier matches, a different version of the correct file has been found.
        see §14.4 "File Identifiers".
        """
        if self._ID:
            id1 = self._ID[0]
            id2 = self._compute_document_identifier()
        else:
            id1 = self._compute_document_identifier()
            id2 = id1
        self._ID = ArrayObject((id1, id2))

    def encrypt(
        self,
        user_password: str,
        owner_password: Optional[str] = None,
        use_128bit: bool = True,
        permissions_flag: UserAccessPermissions = ALL_DOCUMENT_PERMISSIONS,
        *,
        algorithm: Optional[str] = None,
    ) -> None:
        """
        Encrypt this PDF file with the PDF Standard encryption handler.

        Args:
            user_password: The password which allows for opening
                and reading the PDF file with the restrictions provided.
            owner_password: The password which allows for
                opening the PDF files without any restrictions. By default,
                the owner password is the same as the user password.
            use_128bit: flag as to whether to use 128bit
                encryption. When false, 40bit encryption will be used.
                By default, this flag is on.
            permissions_flag: permissions as described in
                Table 3.20 of the PDF 1.7 specification. A bit value of 1 means
                the permission is granted.
                Hence an integer value of -1 will set all flags.
                Bit position 3 is for printing, 4 is for modifying content,
                5 and 6 control annotations, 9 for form fields,
                10 for extraction of text and graphics.
            algorithm: encrypt algorithm. Values may be one of "RC4-40", "RC4-128",
                "AES-128", "AES-256-R5", "AES-256". If it is valid,
                `use_128bit` will be ignored.

        """
        if owner_password is None:
            owner_password = user_password

        if algorithm is not None:
            try:
                alg = getattr(EncryptAlgorithm, algorithm.replace("-", "_"))
            except AttributeError:
                raise ValueError(f"Algorithm '{algorithm}' NOT supported")
        else:
            alg = EncryptAlgorithm.RC4_128
            if not use_128bit:
                alg = EncryptAlgorithm.RC4_40
        self.generate_file_identifiers()
        assert self._ID
        self._encryption = Encryption.make(alg, permissions_flag, self._ID[0])
        # in case call `encrypt` again
        entry = self._encryption.write_entry(user_password, owner_password)
        if self._encrypt_entry:
            # replace old encrypt_entry
            assert self._encrypt_entry.indirect_reference is not None
            entry.indirect_reference = self._encrypt_entry.indirect_reference
            self._objects[entry.indirect_reference.idnum - 1] = entry
        else:
            self._add_object(entry)
        self._encrypt_entry = entry

    def _resolve_links(self) -> None:
        """Patch up links that were added to the document earlier, to
        make sure they still point to the same pages.
        """
        for (new_link, old_link) in self._unresolved_links:
            old_page = old_link.find_referenced_page()
            if not old_page:
                continue
            new_page = self._merged_in_pages.get(old_page)
            if new_page is None:
                continue
            new_link.patch_reference(self, new_page)

    def write_stream(self, stream: StreamType) -> None:
        if hasattr(stream, "mode") and "b" not in stream.mode:
            logger_warning(
                f"File <{stream.name}> to write to is not in binary mode. "
                "It may not be written to correctly.",
                __name__,
            )
        self._resolve_links()

        if self.incremental:
            self._reader.stream.seek(0)
            stream.write(self._reader.stream.read(-1))
            if len(self.list_objects_in_increment()) > 0:
                self._write_increment(stream)  # writes objs, xref stream and startxref
        else:
            object_positions, free_objects = self._write_pdf_structure(stream)
            xref_location = self._write_xref_table(
                stream, object_positions, free_objects
            )
            self._write_trailer(stream, xref_location)

    def write(self, stream: Union[Path, StrByteType]) -> tuple[bool, IO[Any]]:
        """
        Write the collection of pages added to this object out as a PDF file.

        Args:
            stream: An object to write the file to. The object can support
                the write method and the tell method, similar to a file object, or
                be a file path, just like the fileobj, just named it stream to keep
                existing workflow.

        Returns:
            A tuple (bool, IO).

        """
        my_file = False

        if stream == "":
            raise ValueError(f"Output({stream=}) is empty.")

        if isinstance(stream, (str, Path)):
            stream = FileIO(stream, "wb")
            my_file = True

        self.write_stream(stream)

        if my_file:
            stream.close()
        else:
            stream.flush()

        return my_file, stream

    def list_objects_in_increment(self) -> list[IndirectObject]:
        """
        For analysis or debugging.
        Provides the list of new or modified objects that will be written
        in the increment.
        Deleted objects will not be freed but will become orphans.

        Returns:
            List of new or modified IndirectObjects

        """
        original_hash_count = len(self._original_hash)
        return [
            cast(IndirectObject, obj).indirect_reference
            for i, obj in enumerate(self._objects)
            if (
                obj is not None
                and (
                    i >= original_hash_count
                    or obj.hash_bin() != self._original_hash[i]
                )
            )
        ]

    def _write_increment(self, stream: StreamType) -> None:
        object_positions = {}
        object_blocks = []
        current_start = -1
        current_stop = -2
        original_hash_count = len(self._original_hash)
        for i, obj in enumerate(self._objects):
            if obj is not None and (
                i >= original_hash_count
                or obj.hash_bin() != self._original_hash[i]
            ):
                idnum = i + 1
                assert isinstance(obj, PdfObject), "mypy"
                # first write new/modified object
                object_positions[idnum] = stream.tell()
                stream.write(f"{idnum} 0 obj\n".encode())
                """ encryption is not operational
                if self._encryption and obj != self._encrypt_entry:
                    obj = self._encryption.encrypt_object(obj, idnum, 0)
                """
                obj.write_to_stream(stream)
                stream.write(b"\nendobj\n")

                # prepare xref
                if idnum != current_stop:
                    if current_start > 0:
                        object_blocks.append(
                            [current_start, current_stop - current_start]
                        )
                    current_start = idnum
                current_stop = idnum + 1
        assert current_start > 0, "for pytest only"
        object_blocks.append([current_start, current_stop - current_start])
        # write incremented xref
        xref_location = stream.tell()
        xr_id = len(self._objects) + 1
        stream.write(f"{xr_id} 0 obj".encode())
        init_data = {
            NameObject("/Type"): NameObject("/XRef"),
            NameObject("/Size"): NumberObject(xr_id + 1),
            NameObject("/Root"): self.root_object.indirect_reference,
            NameObject("/Filter"): NameObject("/FlateDecode"),
            NameObject("/Index"): ArrayObject(
                [NumberObject(_it) for _su in object_blocks for _it in _su]
            ),
            NameObject("/W"): ArrayObject(
                [NumberObject(1), NumberObject(4), NumberObject(1)]
            ),
            "__streamdata__": b"",
        }
        if self._info is not None and (
            self._info.indirect_reference.idnum - 1  # type: ignore
            >= len(self._original_hash)
            or cast(IndirectObject, self._info).hash_bin()  # kept for future
            != self._original_hash[
                self._info.indirect_reference.idnum - 1  # type: ignore
            ]
        ):
            init_data[NameObject(TK.INFO)] = self._info.indirect_reference
        init_data[NameObject(TK.PREV)] = NumberObject(self._reader._startxref)
        if self._ID:
            init_data[NameObject(TK.ID)] = self._ID
        xr = StreamObject.initialize_from_dictionary(init_data)
        xr.set_data(
            b"".join(
                [struct.pack(b">BIB", 1, _pos, 0) for _pos in object_positions.values()]
            )
        )
        xr.write_to_stream(stream)
        stream.write(f"\nendobj\nstartxref\n{xref_location}\n%%EOF\n".encode())  # eof

    def _write_pdf_structure(self, stream: StreamType) -> tuple[list[int], list[int]]:
        object_positions = []
        free_objects = []
        stream.write(self.pdf_header.encode() + b"\n")
        stream.write(b"%\xE2\xE3\xCF\xD3\n")

        for idnum, obj in enumerate(self._objects, start=1):
            if obj is not None:
                object_positions.append(stream.tell())
                stream.write(f"{idnum} 0 obj\n".encode())
                if self._encryption and obj != self._encrypt_entry:
                    obj = self._encryption.encrypt_object(obj, idnum, 0)
                obj.write_to_stream(stream)
                stream.write(b"\nendobj\n")
            else:
                object_positions.append(-1)
                free_objects.append(idnum)
        free_objects.append(0)  # add 0 to loop in accordance with specification
        return object_positions, free_objects

    def _write_xref_table(
        self, stream: StreamType, object_positions: list[int], free_objects: list[int]
    ) -> int:
        xref_location = stream.tell()
        stream.write(b"xref\n")
        stream.write(f"0 {len(self._objects) + 1}\n".encode())
        stream.write(f"{free_objects[0]:0>10} {65535:0>5} f \n".encode())
        free_idx = 1
        for offset in object_positions:
            if offset > 0:
                stream.write(f"{offset:0>10} {0:0>5} n \n".encode())
            else:
                stream.write(f"{free_objects[free_idx]:0>10} {1:0>5} f \n".encode())
                free_idx += 1
        return xref_location

    def _write_trailer(self, stream: StreamType, xref_location: int) -> None:
        """
        Write the PDF trailer to the stream.

        To quote the PDF specification:
            [The] trailer [gives] the location of the cross-reference table and
            of certain special objects within the body of the file.
        """
        stream.write(b"trailer\n")
        trailer = DictionaryObject(
            {
                NameObject(TK.SIZE): NumberObject(len(self._objects) + 1),
                NameObject(TK.ROOT): self.root_object.indirect_reference,
            }
        )
        if self._info is not None:
            trailer[NameObject(TK.INFO)] = self._info.indirect_reference
        if self._ID is not None:
            trailer[NameObject(TK.ID)] = self._ID
        if self._encrypt_entry:
            trailer[NameObject(TK.ENCRYPT)] = self._encrypt_entry.indirect_reference
        trailer.write_to_stream(stream)
        stream.write(f"\nstartxref\n{xref_location}\n%%EOF\n".encode())  # eof

    @property
    def metadata(self) -> Optional[DocumentInformation]:
        """
        Retrieve/set the PDF file's document information dictionary, if it exists.

        Args:
            value: dict with the entries to be set. if None : remove the /Info entry from the pdf.

        Note that some PDF files use (XMP) metadata streams instead of document
        information dictionaries, and these metadata streams will not be
        accessed by this function, but by :meth:`~xmp_metadata`.

        """
        return super().metadata

    @metadata.setter
    def metadata(
        self,
        value: Optional[Union[DocumentInformation, DictionaryObject, dict[Any, Any]]],
    ) -> None:
        if value is None:
            self._info = None
        else:
            if self._info is not None:
                self._info.clear()

            self.add_metadata(value)

    def add_metadata(self, infos: dict[str, Any]) -> None:
        """
        Add custom metadata to the output.

        Args:
            infos: a Python dictionary where each key is a field
                and each value is your new metadata.

        """
        args = {}
        if isinstance(infos, PdfObject):
            infos = cast(DictionaryObject, infos.get_object())
        for key, value in list(infos.items()):
            if isinstance(value, PdfObject):
                value = value.get_object()
            args[NameObject(key)] = create_string_object(str(value))
        if self._info is None:
            self._info = DictionaryObject()
        self._info.update(args)

    def compress_identical_objects(
        self,
        remove_identicals: bool = True,
        remove_orphans: bool = True,
    ) -> None:
        """
        Parse the PDF file and merge objects that have the same hash.
        This will make objects common to multiple pages.
        Recommended to be used just before writing output.

        Args:
            remove_identicals: Remove identical objects.
            remove_orphans: Remove unreferenced objects.

        """

        def replace_in_obj(
            obj: PdfObject, crossref: dict[IndirectObject, IndirectObject]
        ) -> None:
            if isinstance(obj, DictionaryObject):
                key_val = obj.items()
            elif isinstance(obj, ArrayObject):
                key_val = enumerate(obj)  # type: ignore
            else:
                return
            assert isinstance(obj, (DictionaryObject, ArrayObject))
            for k, v in key_val:
                if isinstance(v, IndirectObject):
                    orphans[v.idnum - 1] = False
                    if v in crossref:
                        obj[k] = crossref[v]
                else:
                    """the filtering on DictionaryObject and ArrayObject only
                    will be performed within replace_in_obj"""
                    replace_in_obj(v, crossref)

        # _idnum_hash :dict[hash]=(1st_ind_obj,[other_indir_objs,...])
        self._idnum_hash = {}
        orphans = [True] * len(self._objects)
        # look for similar objects
        for idx, obj in enumerate(self._objects):
            if is_null_or_none(obj):
                continue
            assert obj is not None, "mypy"  # mypy: TypeGuard of `is_null_or_none` does not help here.
            assert isinstance(obj.indirect_reference, IndirectObject)
            h = obj.hash_value()
            if remove_identicals and h in self._idnum_hash:
                self._idnum_hash[h][1].append(obj.indirect_reference)
                self._objects[idx] = None
            else:
                self._idnum_hash[h] = (obj.indirect_reference, [])

        # generate the dict converting others to 1st
        cnv = {v[0]: v[1] for v in self._idnum_hash.values() if len(v[1]) > 0}
        cnv_rev: dict[IndirectObject, IndirectObject] = {}
        for k, v in cnv.items():
            cnv_rev.update(zip(v, (k,) * len(v)))

        # replace reference to merged objects
        for obj in self._objects:
            if isinstance(obj, (DictionaryObject, ArrayObject)):
                replace_in_obj(obj, cnv_rev)

        # remove orphans (if applicable)
        orphans[self.root_object.indirect_reference.idnum - 1] = False  # type: ignore

        if not is_null_or_none(self._info):
            orphans[self._info.indirect_reference.idnum - 1] = False  # type: ignore

        try:
            orphans[self._ID.indirect_reference.idnum - 1] = False  # type: ignore
        except AttributeError:
            pass
        for i in compress(range(len(self._objects)), orphans):
            self._objects[i] = None

    def get_reference(self, obj: PdfObject) -> IndirectObject:
        idnum = self._objects.index(obj) + 1
        ref = IndirectObject(idnum, 0, self)
        assert ref.get_object() == obj
        return ref

    def get_outline_root(self) -> TreeObject:
        if CO.OUTLINES in self._root_object:
            # Entries in the catalog dictionary
            outline = cast(TreeObject, self._root_object[CO.OUTLINES])
            if not isinstance(outline, TreeObject):
                t = TreeObject(outline)
                self._replace_object(outline.indirect_reference.idnum, t)
                outline = t
            idnum = self._objects.index(outline) + 1
            outline_ref = IndirectObject(idnum, 0, self)
            assert outline_ref.get_object() == outline
        else:
            outline = TreeObject()
            outline.update({})
            outline_ref = self._add_object(outline)
            self._root_object[NameObject(CO.OUTLINES)] = outline_ref

        return outline

    def get_threads_root(self) -> ArrayObject:
        """
        The list of threads.

        See §12.4.3 of the PDF 1.7 or PDF 2.0 specification.

        Returns:
            An array (possibly empty) of Dictionaries with an ``/F`` key,
            and optionally information about the thread in ``/I`` or ``/Metadata`` keys.

        """
        if CO.THREADS in self._root_object:
            # Entries in the catalog dictionary
            threads = cast(ArrayObject, self._root_object[CO.THREADS])
        else:
            threads = ArrayObject()
            self._root_object[NameObject(CO.THREADS)] = threads
        return threads

    @property
    def threads(self) -> ArrayObject:
        """
        Read-only property for the list of threads.

        See §12.4.3 of the PDF 1.7 or PDF 2.0 specification.

        Each element is a dictionary with an ``/F`` key, and optionally
        information about the thread in ``/I`` or ``/Metadata`` keys.
        """
        return self.get_threads_root()

    def add_outline_item_destination(
        self,
        page_destination: Union[IndirectObject, PageObject, TreeObject],
        parent: Union[None, TreeObject, IndirectObject] = None,
        before: Union[None, TreeObject, IndirectObject] = None,
        is_open: bool = True,
    ) -> IndirectObject:
        page_destination = cast(PageObject, page_destination.get_object())
        if isinstance(page_destination, PageObject):
            return self.add_outline_item_destination(
                Destination(
                    f"page #{page_destination.page_number}",
                    cast(IndirectObject, page_destination.indirect_reference),
                    Fit.fit(),
                )
            )

        if parent is None:
            parent = self.get_outline_root()

        page_destination[NameObject("/%is_open%")] = BooleanObject(is_open)
        parent = cast(TreeObject, parent.get_object())
        page_destination_ref = self._add_object(page_destination)
        if before is not None:
            before = before.indirect_reference
        parent.insert_child(
            page_destination_ref,
            before,
            self,
            page_destination.inc_parent_counter_outline
            if is_open
            else (lambda x, y: 0),  # noqa: ARG005
        )
        if "/Count" not in page_destination:
            page_destination[NameObject("/Count")] = NumberObject(0)

        return page_destination_ref

    def add_outline_item_dict(
        self,
        outline_item: OutlineItemType,
        parent: Union[None, TreeObject, IndirectObject] = None,
        before: Union[None, TreeObject, IndirectObject] = None,
        is_open: bool = True,
    ) -> IndirectObject:
        outline_item_object = TreeObject()
        outline_item_object.update(outline_item)

        """code currently unreachable
        if "/A" in outline_item:
            action = DictionaryObject()
            a_dict = cast(DictionaryObject, outline_item["/A"])
            for k, v in list(a_dict.items()):
                action[NameObject(str(k))] = v
            action_ref = self._add_object(action)
            outline_item_object[NameObject("/A")] = action_ref
        """
        return self.add_outline_item_destination(
            outline_item_object, parent, before, is_open
        )

    def add_outline_item(
        self,
        title: str,
        page_number: Union[None, PageObject, IndirectObject, int],
        parent: Union[None, TreeObject, IndirectObject] = None,
        before: Union[None, TreeObject, IndirectObject] = None,
        color: Optional[Union[tuple[float, float, float], str]] = None,
        bold: bool = False,
        italic: bool = False,
        fit: Fit = PAGE_FIT,
        is_open: bool = True,
    ) -> IndirectObject:
        """
        Add an outline item (commonly referred to as a "Bookmark") to the PDF file.

        Args:
            title: Title to use for this outline item.
            page_number: Page number this outline item will point to.
            parent: A reference to a parent outline item to create nested
                outline items.
            before:
            color: Color of the outline item's font as a red, green, blue tuple
                from 0.0 to 1.0 or as a Hex String (#RRGGBB)
            bold: Outline item font is bold
            italic: Outline item font is italic
            fit: The fit of the destination page.

        Returns:
            The added outline item as an indirect object.

        """
        page_ref: Union[None, NullObject, IndirectObject, NumberObject]
        if isinstance(italic, Fit):  # it means that we are on the old params
            if fit is not None and page_number is None:
                page_number = fit
            return self.add_outline_item(
                title, page_number, parent, None, before, color, bold, italic, is_open=is_open
            )
        if page_number is None:
            action_ref = None
        else:
            if isinstance(page_number, IndirectObject):
                page_ref = page_number
            elif isinstance(page_number, PageObject):
                page_ref = page_number.indirect_reference
            elif isinstance(page_number, int):
                try:
                    page_ref = self.pages[page_number].indirect_reference
                except IndexError:
                    page_ref = NumberObject(page_number)
            if page_ref is None:
                logger_warning(
                    f"can not find reference of page {page_number}",
                    __name__,
                )
                page_ref = NullObject()
            dest = Destination(
                NameObject("/" + title + " outline item"),
                page_ref,
                fit,
            )

            action_ref = self._add_object(
                DictionaryObject(
                    {
                        NameObject(GoToActionArguments.D): dest.dest_array,
                        NameObject(GoToActionArguments.S): NameObject("/GoTo"),
                    }
                )
            )
        outline_item = self._add_object(
            _create_outline_item(action_ref, title, color, italic, bold)
        )

        if parent is None:
            parent = self.get_outline_root()
        return self.add_outline_item_destination(outline_item, parent, before, is_open)

    def add_outline(self) -> None:
        raise NotImplementedError(
            "This method is not yet implemented. Use :meth:`add_outline_item` instead."
        )

    def add_named_destination_array(
        self, title: TextStringObject, destination: Union[IndirectObject, ArrayObject]
    ) -> None:
        named_dest = self.get_named_dest_root()
        i = 0
        while i < len(named_dest):
            if title < named_dest[i]:
                named_dest.insert(i, destination)
                named_dest.insert(i, TextStringObject(title))
                return
            i += 2
        named_dest.extend([TextStringObject(title), destination])
        return

    def add_named_destination_object(
        self,
        page_destination: PdfObject,
    ) -> IndirectObject:
        page_destination_ref = self._add_object(page_destination.dest_array)  # type: ignore
        self.add_named_destination_array(
            cast("TextStringObject", page_destination["/Title"]), page_destination_ref  # type: ignore
        )

        return page_destination_ref

    def add_named_destination(
        self,
        title: str,
        page_number: int,
    ) -> IndirectObject:
        page_ref = self.get_object(self._pages)[PagesAttributes.KIDS][page_number]  # type: ignore
        dest = DictionaryObject()
        dest.update(
            {
                NameObject(GoToActionArguments.D): ArrayObject(
                    [page_ref, NameObject(TypFitArguments.FIT_H), NumberObject(826)]
                ),
                NameObject(GoToActionArguments.S): NameObject("/GoTo"),
            }
        )

        dest_ref = self._add_object(dest)
        if not isinstance(title, TextStringObject):
            title = TextStringObject(str(title))

        self.add_named_destination_array(title, dest_ref)
        return dest_ref

    def remove_links(self) -> None:
        """Remove links and annotations from this output."""
        for page in self.pages:
            self.remove_objects_from_page(page, ObjectDeletionFlag.ALL_ANNOTATIONS)

    def remove_annotations(
        self, subtypes: Optional[Union[AnnotationSubtype, Iterable[AnnotationSubtype]]]
    ) -> None:
        """
        Remove annotations by annotation subtype.

        Args:
            subtypes: subtype or list of subtypes to be removed.
                Examples are: "/Link", "/FileAttachment", "/Sound",
                "/Movie", "/Screen", ...
                If you want to remove all annotations, use subtypes=None.

        """
        for page in self.pages:
            self._remove_annots_from_page(page, subtypes)

    def _remove_annots_from_page(
        self,
        page: Union[IndirectObject, PageObject, DictionaryObject],
        subtypes: Optional[Iterable[str]],
    ) -> None:
        page = cast(DictionaryObject, page.get_object())
        if PG.ANNOTS in page:
            i = 0
            while i < len(cast(ArrayObject, page[PG.ANNOTS])):
                an = cast(ArrayObject, page[PG.ANNOTS])[i]
                obj = cast(DictionaryObject, an.get_object())
                if subtypes is None or cast(str, obj["/Subtype"]) in subtypes:
                    if isinstance(an, IndirectObject):
                        self._objects[an.idnum - 1] = NullObject()  # to reduce PDF size
                    del page[PG.ANNOTS][i]  # type:ignore
                else:
                    i += 1

    def remove_objects_from_page(
        self,
        page: Union[PageObject, DictionaryObject],
        to_delete: Union[ObjectDeletionFlag, Iterable[ObjectDeletionFlag]],
        text_filters: Optional[dict[str, Any]] = None
    ) -> None:
        """
        Remove objects specified by ``to_delete`` from the given page.

        Args:
            page: Page object to clean up.
            to_delete: Objects to be deleted; can be a ``ObjectDeletionFlag``
                or a list of ObjectDeletionFlag
            text_filters: Properties of text to be deleted, if applicable. Optional.
                This is a Python dictionary with the following properties:

                * font_ids: List of font resource IDs (such as /F1 or /T1_0) to be deleted.

        """
        if isinstance(to_delete, (list, tuple)):
            for to_d in to_delete:
                self.remove_objects_from_page(page, to_d)
            return None
        assert isinstance(to_delete, ObjectDeletionFlag)

        if to_delete & ObjectDeletionFlag.LINKS:
            return self._remove_annots_from_page(page, ("/Link",))
        if to_delete & ObjectDeletionFlag.ATTACHMENTS:
            return self._remove_annots_from_page(
                page, ("/FileAttachment", "/Sound", "/Movie", "/Screen")
            )
        if to_delete & ObjectDeletionFlag.OBJECTS_3D:
            return self._remove_annots_from_page(page, ("/3D",))
        if to_delete & ObjectDeletionFlag.ALL_ANNOTATIONS:
            return self._remove_annots_from_page(page, None)

        jump_operators = []
        if to_delete & ObjectDeletionFlag.DRAWING_IMAGES:
            jump_operators = [
                b"w", b"J", b"j", b"M", b"d", b"i",
                b"W", b"W*",
                b"b", b"b*", b"B", b"B*", b"S", b"s", b"f", b"f*", b"F", b"n",
                b"m", b"l", b"c", b"v", b"y", b"h", b"re",
                b"sh"
            ]
        if to_delete & ObjectDeletionFlag.TEXT:
            jump_operators = [b"Tj", b"TJ", b"'", b'"']

        if not isinstance(page, PageObject):
            page = PageObject(self, page.indirect_reference)  # pragma: no cover
        if "/Contents" in page:
            content = cast(ContentStream, page.get_contents())

            images, forms = self._remove_objects_from_page__clean_forms(
                elt=page, stack=[], jump_operators=jump_operators, to_delete=to_delete, text_filters=text_filters,
            )

            self._remove_objects_from_page__clean(
                content=content, images=images, forms=forms,
                jump_operators=jump_operators, to_delete=to_delete,
                text_filters=text_filters
            )
            page.replace_contents(content)
        return [], []  # type: ignore[return-value]

    def _remove_objects_from_page__clean(
            self,
            content: ContentStream,
            images: list[str],
            forms: list[str],
            jump_operators: list[bytes],
            to_delete: ObjectDeletionFlag,
            text_filters: Optional[dict[str, Any]] = None,
    ) -> None:
        font_id = None
        font_ids_to_delete = []
        if text_filters and to_delete & ObjectDeletionFlag.TEXT:
            font_ids_to_delete = text_filters.get("font_ids", [])

        i = 0
        while i < len(content.operations):
            operands, operator = content.operations[i]
            if operator == b"Tf":
                font_id = operands[0]
            if (
                (
                    operator == b"INLINE IMAGE"
                    and (to_delete & ObjectDeletionFlag.INLINE_IMAGES)
                )
                or (operator in jump_operators)
                or (
                    operator == b"Do"
                    and (to_delete & ObjectDeletionFlag.XOBJECT_IMAGES)
                    and (operands[0] in images)
                )
            ):
                if (
                    not to_delete & ObjectDeletionFlag.TEXT
                    or (to_delete & ObjectDeletionFlag.TEXT and not text_filters)
                    or (to_delete & ObjectDeletionFlag.TEXT and font_id in font_ids_to_delete)
                ):
                    del content.operations[i]
                else:
                    i += 1
            else:
                i += 1
        content.get_data()  # this ensures ._data is rebuilt from the .operations

    def _remove_objects_from_page__clean_forms(
            self,
            elt: DictionaryObject,
            stack: list[DictionaryObject],
            jump_operators: list[bytes],
            to_delete: ObjectDeletionFlag,
            text_filters: Optional[dict[str, Any]] = None,
    ) -> tuple[list[str], list[str]]:
        # elt in recursive call is a new ContentStream object, so we have to check the indirect_reference
        if (elt in stack) or (
                hasattr(elt, "indirect_reference") and any(
                    elt.indirect_reference == getattr(x, "indirect_reference", -1)
                    for x in stack
                )
        ):
            # to prevent infinite looping
            return [], []  # pragma: no cover
        try:
            d = cast(
                dict[Any, Any],
                cast(DictionaryObject, elt["/Resources"])["/XObject"],
            )
        except KeyError:
            d = {}
        images = []
        forms = []
        for k, v in d.items():
            o = v.get_object()
            try:
                content: Any = None
                if (
                        to_delete & ObjectDeletionFlag.XOBJECT_IMAGES
                        and o["/Subtype"] == "/Image"
                ):
                    content = NullObject()  # to delete the image keeping the entry
                    images.append(k)
                if o["/Subtype"] == "/Form":
                    forms.append(k)
                    if isinstance(o, ContentStream):
                        content = o
                    else:
                        content = ContentStream(o, self)
                        content.update(
                            {
                                k1: v1
                                for k1, v1 in o.items()
                                if k1 not in ["/Length", "/Filter", "/DecodeParms"]
                            }
                        )
                        try:
                            content.indirect_reference = o.indirect_reference
                        except AttributeError:  # pragma: no cover
                            pass
                    stack.append(elt)

                    # clean subforms
                    self._remove_objects_from_page__clean_forms(
                        elt=content, stack=stack, jump_operators=jump_operators, to_delete=to_delete,
                        text_filters=text_filters,
                    )
                if content is not None:
                    if isinstance(v, IndirectObject):
                        self._objects[v.idnum - 1] = content
                    else:
                        # should only occur in a PDF not respecting PDF spec
                        # where streams must be indirected.
                        d[k] = self._add_object(content)  # pragma: no cover
            except (TypeError, KeyError):
                pass
        for im in images:
            del d[im]  # for clean-up
        if isinstance(elt, StreamObject):  # for /Form
            if not isinstance(elt, ContentStream):  # pragma: no cover
                e = ContentStream(elt, self)
                e.update(elt.items())
                elt = e
            # clean the content
            self._remove_objects_from_page__clean(
                content=elt, images=images, forms=forms, jump_operators=jump_operators,
                to_delete=to_delete, text_filters=text_filters
            )
        return images, forms

    def remove_images(
        self,
        to_delete: ImageType = ImageType.ALL,
    ) -> None:
        """
        Remove images from this output.

        Args:
            to_delete: The type of images to be deleted
                (default = all images types)

        """
        if isinstance(to_delete, bool):
            to_delete = ImageType.ALL

        i = ObjectDeletionFlag.NONE

        for image in ("XOBJECT_IMAGES", "INLINE_IMAGES", "DRAWING_IMAGES"):
            if to_delete & ImageType[image]:
                i |= ObjectDeletionFlag[image]

        for page in self.pages:
            self.remove_objects_from_page(page, i)

    def remove_text(self, font_names: Optional[list[str]] = None) -> None:
        """
        Remove text from the PDF.

        Args:
            font_names: List of font names to remove, such as "Helvetica-Bold".
                Optional. If not specified, all text will be removed.
        """
        if not font_names:
            font_names = []

        for page in self.pages:
            resource_ids_to_remove = []

            # Content streams reference fonts and other resources with names like "/F1" or "/T1_0"
            # Font names need to be converted to resource names/IDs for easier removal
            if font_names:
                # Recursively loop through page objects to gather font info
                def get_font_info(
                    obj: Any,
                    font_info: Optional[dict[str, Any]] = None,
                    key: Optional[str] = None
                ) -> dict[str, Any]:
                    if font_info is None:
                        font_info = {}
                    if isinstance(obj, IndirectObject):
                        obj = obj.get_object()
                    if isinstance(obj, dict):
                        if obj.get("/Type") == "/Font":
                            font_name = obj.get("/BaseFont", "")
                            # Normalize font names like "/RRXFFV+Palatino-Bold" to "Palatino-Bold"
                            normalized_font_name = font_name.lstrip("/").split("+")[-1]
                            if normalized_font_name not in font_info:
                                font_info[normalized_font_name] = {
                                    "normalized_font_name": normalized_font_name,
                                    "resource_ids": [],
                                }
                            if key not in font_info[normalized_font_name]["resource_ids"]:
                                font_info[normalized_font_name]["resource_ids"].append(key)
                        for k in obj:
                            font_info = get_font_info(obj[k], font_info, k)
                    elif isinstance(obj, (list, ArrayObject)):
                        for child_obj in obj:
                            font_info = get_font_info(child_obj, font_info)
                    return font_info

                # Add relevant resource names for removal
                font_info = get_font_info(page.get("/Resources"))
                for font_name in font_names:
                    if font_name in font_info:
                        resource_ids_to_remove.extend(font_info[font_name]["resource_ids"])

            text_filters = {}
            if font_names:
                text_filters["font_ids"] = resource_ids_to_remove
            self.remove_objects_from_page(page, ObjectDeletionFlag.TEXT, text_filters=text_filters)

    def add_uri(
        self,
        page_number: int,
        uri: str,
        rect: RectangleObject,
        border: Optional[ArrayObject] = None,
    ) -> None:
        """
        Add an URI from a rectangular area to the specified page.

        Args:
            page_number: index of the page on which to place the URI action.
            uri: URI of resource to link to.
            rect: :class:`RectangleObject<pypdf.generic.RectangleObject>` or
                array of four integers specifying the clickable rectangular area
                ``[xLL, yLL, xUR, yUR]``, or string in the form
                ``"[ xLL yLL xUR yUR ]"``.
            border: if provided, an array describing border-drawing
                properties. See the PDF spec for details. No border will be
                drawn if this argument is omitted.

        """
        page_link = self.get_object(self._pages)[PagesAttributes.KIDS][page_number]  # type: ignore
        page_ref = cast(dict[str, Any], self.get_object(page_link))

        border_arr: BorderArrayType
        if border is not None:
            border_arr = [NumberObject(n) for n in border[:3]]
            if len(border) == 4:
                dash_pattern = ArrayObject([NumberObject(n) for n in border[3]])
                border_arr.append(dash_pattern)
        else:
            border_arr = [NumberObject(2), NumberObject(2), NumberObject(2)]

        if isinstance(rect, str):
            rect = NumberObject(rect)
        elif isinstance(rect, RectangleObject):
            pass
        else:
            rect = RectangleObject(rect)

        lnk2 = DictionaryObject()
        lnk2.update(
            {
                NameObject("/S"): NameObject("/URI"),
                NameObject("/URI"): TextStringObject(uri),
            }
        )
        lnk = DictionaryObject()
        lnk.update(
            {
                NameObject(AA.Type): NameObject("/Annot"),
                NameObject(AA.Subtype): NameObject("/Link"),
                NameObject(AA.P): page_link,
                NameObject(AA.Rect): rect,
                NameObject("/H"): NameObject("/I"),
                NameObject(AA.Border): ArrayObject(border_arr),
                NameObject("/A"): lnk2,
            }
        )
        lnk_ref = self._add_object(lnk)

        if PG.ANNOTS in page_ref:
            page_ref[PG.ANNOTS].append(lnk_ref)
        else:
            page_ref[NameObject(PG.ANNOTS)] = ArrayObject([lnk_ref])

    _valid_layouts = (
        "/NoLayout",
        "/SinglePage",
        "/OneColumn",
        "/TwoColumnLeft",
        "/TwoColumnRight",
        "/TwoPageLeft",
        "/TwoPageRight",
    )

    def _get_page_layout(self) -> Optional[LayoutType]:
        try:
            return cast(LayoutType, self._root_object["/PageLayout"])
        except KeyError:
            return None

    def _set_page_layout(self, layout: Union[NameObject, LayoutType]) -> None:
        """
        Set the page layout.

        Args:
            layout: The page layout to be used.

        .. list-table:: Valid ``layout`` arguments
           :widths: 50 200

           * - /NoLayout
             - Layout explicitly not specified
           * - /SinglePage
             - Show one page at a time
           * - /OneColumn
             - Show one column at a time
           * - /TwoColumnLeft
             - Show pages in two columns, odd-numbered pages on the left
           * - /TwoColumnRight
             - Show pages in two columns, odd-numbered pages on the right
           * - /TwoPageLeft
             - Show two pages at a time, odd-numbered pages on the left
           * - /TwoPageRight
             - Show two pages at a time, odd-numbered pages on the right

        """
        if not isinstance(layout, NameObject):
            if layout not in self._valid_layouts:
                logger_warning(
                    f"Layout should be one of: {'', ''.join(self._valid_layouts)}",
                    __name__,
                )
            layout = NameObject(layout)
        self._root_object.update({NameObject("/PageLayout"): layout})

    def set_page_layout(self, layout: LayoutType) -> None:
        """
        Set the page layout.

        Args:
            layout: The page layout to be used

        .. list-table:: Valid ``layout`` arguments
           :widths: 50 200

           * - /NoLayout
             - Layout explicitly not specified
           * - /SinglePage
             - Show one page at a time
           * - /OneColumn
             - Show one column at a time
           * - /TwoColumnLeft
             - Show pages in two columns, odd-numbered pages on the left
           * - /TwoColumnRight
             - Show pages in two columns, odd-numbered pages on the right
           * - /TwoPageLeft
             - Show two pages at a time, odd-numbered pages on the left
           * - /TwoPageRight
             - Show two pages at a time, odd-numbered pages on the right

        """
        self._set_page_layout(layout)

    @property
    def page_layout(self) -> Optional[LayoutType]:
        """
        Page layout property.

        .. list-table:: Valid ``layout`` values
           :widths: 50 200

           * - /NoLayout
             - Layout explicitly not specified
           * - /SinglePage
             - Show one page at a time
           * - /OneColumn
             - Show one column at a time
           * - /TwoColumnLeft
             - Show pages in two columns, odd-numbered pages on the left
           * - /TwoColumnRight
             - Show pages in two columns, odd-numbered pages on the right
           * - /TwoPageLeft
             - Show two pages at a time, odd-numbered pages on the left
           * - /TwoPageRight
             - Show two pages at a time, odd-numbered pages on the right
        """
        return self._get_page_layout()

    @page_layout.setter
    def page_layout(self, layout: LayoutType) -> None:
        self._set_page_layout(layout)

    _valid_modes = (
        "/UseNone",
        "/UseOutlines",
        "/UseThumbs",
        "/FullScreen",
        "/UseOC",
        "/UseAttachments",
    )

    def _get_page_mode(self) -> Optional[PagemodeType]:
        try:
            return cast(PagemodeType, self._root_object["/PageMode"])
        except KeyError:
            return None

    @property
    def page_mode(self) -> Optional[PagemodeType]:
        """
        Page mode property.

        .. list-table:: Valid ``mode`` values
           :widths: 50 200

           * - /UseNone
             - Do not show outline or thumbnails panels
           * - /UseOutlines
             - Show outline (aka bookmarks) panel
           * - /UseThumbs
             - Show page thumbnails panel
           * - /FullScreen
             - Fullscreen view
           * - /UseOC
             - Show Optional Content Group (OCG) panel
           * - /UseAttachments
             - Show attachments panel
        """
        return self._get_page_mode()

    @page_mode.setter
    def page_mode(self, mode: PagemodeType) -> None:
        if isinstance(mode, NameObject):
            mode_name: NameObject = mode
        else:
            if mode not in self._valid_modes:
                logger_warning(
                    f"Mode should be one of: {', '.join(self._valid_modes)}", __name__
                )
            mode_name = NameObject(mode)
        self._root_object.update({NameObject("/PageMode"): mode_name})

    def add_annotation(
        self,
        page_number: Union[int, PageObject],
        annotation: dict[str, Any],
    ) -> DictionaryObject:
        """
        Add a single annotation to the page.
        The added annotation must be a new annotation.
        It cannot be recycled.

        Args:
            page_number: PageObject or page index.
            annotation: Annotation to be added (created with annotation).

        Returns:
            The inserted object.
            This can be used for popup creation, for example.

        """
        page = page_number
        if isinstance(page, int):
            page = self.pages[page]
        elif not isinstance(page, PageObject):
            raise TypeError("page: invalid type")

        to_add = cast(DictionaryObject, _pdf_objectify(annotation))
        to_add[NameObject("/P")] = page.indirect_reference

        if page.annotations is None:
            page[NameObject("/Annots")] = ArrayObject()
        assert page.annotations is not None

        # Internal link annotations need the correct object type for the
        # destination
        if to_add.get("/Subtype") == "/Link" and "/Dest" in to_add:
            tmp = cast(dict[Any, Any], to_add[NameObject("/Dest")])
            dest = Destination(
                NameObject("/LinkName"),
                tmp["target_page_index"],
                Fit(
                    fit_type=tmp["fit"], fit_args=dict(tmp)["fit_args"]
                ),  # I have no clue why this dict-hack is necessary
            )
            to_add[NameObject("/Dest")] = dest.dest_array

        page.annotations.append(self._add_object(to_add))

        if to_add.get("/Subtype") == "/Popup" and NameObject("/Parent") in to_add:
            cast(DictionaryObject, to_add["/Parent"].get_object())[
                NameObject("/Popup")
            ] = to_add.indirect_reference

        return to_add

    def clean_page(self, page: Union[PageObject, IndirectObject]) -> PageObject:
        """
        Perform some clean up in the page.
        Currently: convert NameObject named destination to TextStringObject
        (required for names/dests list)

        Args:
            page:

        Returns:
            The cleaned PageObject

        """
        page = cast("PageObject", page.get_object())
        for a in page.get("/Annots", []):
            a_obj = a.get_object()
            d = a_obj.get("/Dest", None)
            act = a_obj.get("/A", None)
            if isinstance(d, NameObject):
                a_obj[NameObject("/Dest")] = TextStringObject(d)
            elif act is not None:
                act = act.get_object()
                d = act.get("/D", None)
                if isinstance(d, NameObject):
                    act[NameObject("/D")] = TextStringObject(d)
        return page

    def _create_stream(
        self, fileobj: Union[Path, StrByteType, PdfReader]
    ) -> tuple[IOBase, Optional[Encryption]]:
        # If the fileobj parameter is a string, assume it is a path
        # and create a file object at that location. If it is a file,
        # copy the file's contents into a BytesIO stream object; if
        # it is a PdfReader, copy that reader's stream into a
        # BytesIO stream.
        # If fileobj is none of the above types, it is not modified
        encryption_obj = None
        stream: IOBase
        if isinstance(fileobj, (str, Path)):
            with FileIO(fileobj, "rb") as f:
                stream = BytesIO(f.read())
        elif isinstance(fileobj, PdfReader):
            if fileobj._encryption:
                encryption_obj = fileobj._encryption
            orig_tell = fileobj.stream.tell()
            fileobj.stream.seek(0)
            stream = BytesIO(fileobj.stream.read())

            # reset the stream to its original location
            fileobj.stream.seek(orig_tell)
        elif hasattr(fileobj, "seek") and hasattr(fileobj, "read"):
            fileobj.seek(0)
            filecontent = fileobj.read()
            stream = BytesIO(filecontent)
        else:
            raise NotImplementedError(
                "Merging requires an object that PdfReader can parse. "
                "Typically, that is a Path or a string representing a Path, "
                "a file object, or an object implementing .seek and .read. "
                "Passing a PdfReader directly works as well."
            )
        return stream, encryption_obj

    def append(
        self,
        fileobj: Union[StrByteType, PdfReader, Path],
        outline_item: Union[
            str, None, PageRange, tuple[int, int], tuple[int, int, int], list[int]
        ] = None,
        pages: Union[
            None,
            PageRange,
            tuple[int, int],
            tuple[int, int, int],
            list[int],
            list[PageObject],
        ] = None,
        import_outline: bool = True,
        excluded_fields: Optional[Union[list[str], tuple[str, ...]]] = None,
    ) -> None:
        """
        Identical to the :meth:`merge()<merge>` method, but assumes you want to
        concatenate all pages onto the end of the file instead of specifying a
        position.

        Args:
            fileobj: A File Object or an object that supports the standard
                read and seek methods similar to a File Object. Could also be a
                string representing a path to a PDF file.
            outline_item: Optionally, you may specify a string to build an
                outline (aka 'bookmark') to identify the beginning of the
                included file.
            pages: Can be a :class:`PageRange<pypdf.pagerange.PageRange>`
                or a ``(start, stop[, step])`` tuple
                or a list of pages to be processed
                to merge only the specified range of pages from the source
                document into the output document.
            import_outline: You may prevent the source document's
                outline (collection of outline items, previously referred to as
                'bookmarks') from being imported by specifying this as ``False``.
            excluded_fields: Provide the list of fields/keys to be ignored
                if ``/Annots`` is part of the list, the annotation will be ignored
                if ``/B`` is part of the list, the articles will be ignored

        """
        if excluded_fields is None:
            excluded_fields = ()
        if isinstance(outline_item, (tuple, list, PageRange)):
            if isinstance(pages, bool):
                if not isinstance(import_outline, bool):
                    excluded_fields = import_outline
                import_outline = pages
            pages = outline_item
            self.merge(
                None,
                fileobj,
                None,
                pages,
                import_outline,
                excluded_fields,
            )
        else:  # if isinstance(outline_item, str):
            self.merge(
                None,
                fileobj,
                outline_item,
                pages,
                import_outline,
                excluded_fields,
            )

    def merge(
        self,
        position: Optional[int],
        fileobj: Union[Path, StrByteType, PdfReader],
        outline_item: Optional[str] = None,
        pages: Optional[Union[PageRangeSpec, list[PageObject]]] = None,
        import_outline: bool = True,
        excluded_fields: Optional[Union[list[str], tuple[str, ...]]] = (),
    ) -> None:
        """
        Merge the pages from the given file into the output file at the
        specified page number.

        Args:
            position: The *page number* to insert this file. File will
                be inserted after the given number.
            fileobj: A File Object or an object that supports the standard
                read and seek methods similar to a File Object. Could also be a
                string representing a path to a PDF file.
            outline_item: Optionally, you may specify a string to build an outline
                (aka 'bookmark') to identify the
                beginning of the included file.
            pages: can be a :class:`PageRange<pypdf.pagerange.PageRange>`
                or a ``(start, stop[, step])`` tuple
                or a list of pages to be processed
                to merge only the specified range of pages from the source
                document into the output document.
            import_outline: You may prevent the source document's
                outline (collection of outline items, previously referred to as
                'bookmarks') from being imported by specifying this as ``False``.
            excluded_fields: provide the list of fields/keys to be ignored
                if ``/Annots`` is part of the list, the annotation will be ignored
                if ``/B`` is part of the list, the articles will be ignored

        Raises:
            TypeError: The pages attribute is not configured properly

        """
        if isinstance(fileobj, PdfDocCommon):
            reader = fileobj
        else:
            stream, _encryption_obj = self._create_stream(fileobj)
            # Create a new PdfReader instance using the stream
            # (either file or BytesIO or StringIO) created above
            reader = PdfReader(stream, strict=False)  # type: ignore[arg-type]

        if excluded_fields is None:
            excluded_fields = ()
        # Find the range of pages to merge.
        if pages is None:
            pages = list(range(len(reader.pages)))
        elif isinstance(pages, PageRange):
            pages = list(range(*pages.indices(len(reader.pages))))
        elif isinstance(pages, list):
            pass  # keep unchanged
        elif isinstance(pages, tuple) and len(pages) <= 3:
            pages = list(range(*pages))
        elif not isinstance(pages, tuple):
            raise TypeError(
                '"pages" must be a tuple of (start, stop[, step]) or a list'
            )

        srcpages = {}
        for page in pages:
            if isinstance(page, PageObject):
                pg = page
            else:
                pg = reader.pages[page]
            assert pg.indirect_reference is not None
            if position is None:
                # numbers in the exclude list identifies that the exclusion is
                # only applicable to 1st level of cloning
                srcpages[pg.indirect_reference.idnum] = self.add_page(
                    pg, [*list(excluded_fields), 1, "/B", 1, "/Annots"]  # type: ignore
                )
            else:
                srcpages[pg.indirect_reference.idnum] = self.insert_page(
                    pg, position, [*list(excluded_fields), 1, "/B", 1, "/Annots"]  # type: ignore
                )
                position += 1
            srcpages[pg.indirect_reference.idnum].original_page = pg

        reader._named_destinations = (
            reader.named_destinations
        )  # need for the outline processing below

        arr: Any

        for dest in reader._named_destinations.values():
            self._merge__process_named_dests(dest=dest, reader=reader, srcpages=srcpages)

        outline_item_typ: TreeObject
        if outline_item is not None:
            outline_item_typ = cast(
                "TreeObject",
                self.add_outline_item(
                    TextStringObject(outline_item),
                    next(iter(srcpages.values())).indirect_reference,
                    fit=PAGE_FIT,
                ).get_object(),
            )
        else:
            outline_item_typ = self.get_outline_root()

        _ro = reader.root_object
        if import_outline and CO.OUTLINES in _ro:
            outline = self._get_filtered_outline(
                _ro.get(CO.OUTLINES, None), srcpages, reader
            )
            self._insert_filtered_outline(
                outline, outline_item_typ, None
            )  # TODO: use before parameter

        if "/Annots" not in excluded_fields:
            for pag in srcpages.values():
                lst = self._insert_filtered_annotations(
                    pag.original_page.get("/Annots", []), pag, srcpages, reader
                )
                if len(lst) > 0:
                    pag[NameObject("/Annots")] = lst
                self.clean_page(pag)

        if "/AcroForm" in _ro and not is_null_or_none(_ro["/AcroForm"]):
            if "/AcroForm" not in self._root_object:
                self._root_object[NameObject("/AcroForm")] = self._add_object(
                    cast(
                        DictionaryObject,
                        reader.root_object["/AcroForm"],
                    ).clone(self, False, ("/Fields",))
                )
                arr = ArrayObject()
            else:
                arr = cast(
                    ArrayObject,
                    cast(DictionaryObject, self._root_object["/AcroForm"])["/Fields"],
                )
            trslat = self._id_translated[id(reader)]
            try:
                for f in reader.root_object["/AcroForm"]["/Fields"]:  # type: ignore
                    try:
                        ind = IndirectObject(trslat[f.idnum], 0, self)
                        if ind not in arr:
                            arr.append(ind)
                    except KeyError:
                        # for trslat[] which mean the field has not be copied
                        # through the page
                        pass
            except KeyError:  # for /Acroform or /Fields are not existing
                arr = self._add_object(ArrayObject())
            cast(DictionaryObject, self._root_object["/AcroForm"])[
                NameObject("/Fields")
            ] = arr

        if "/B" not in excluded_fields:
            self.add_filtered_articles("", srcpages, reader)

    def _merge__process_named_dests(self, dest: Any, reader: PdfDocCommon, srcpages: dict[int, PageObject]) -> None:
        arr: Any = dest.dest_array
        if "/Names" in self._root_object and dest["/Title"] in cast(
            list[Any],
            cast(
                DictionaryObject,
                cast(DictionaryObject, self._root_object["/Names"]).get("/Dests", DictionaryObject()),
            ).get("/Names", DictionaryObject()),
        ):
            # already exists: should not duplicate it
            pass
        elif dest["/Page"] is None or isinstance(dest["/Page"], NullObject):
            pass
        elif isinstance(dest["/Page"], int):
            # the page reference is a page number normally not a PDF Reference
            # page numbers as int are normally accepted only in external goto
            try:
                p = reader.pages[dest["/Page"]]
            except IndexError:
                return
            assert p.indirect_reference is not None
            try:
                arr[NumberObject(0)] = NumberObject(
                    srcpages[p.indirect_reference.idnum].page_number
                )
                self.add_named_destination_array(dest["/Title"], arr)
            except KeyError:
                pass
        elif dest["/Page"].indirect_reference.idnum in srcpages:
            arr[NumberObject(0)] = srcpages[
                dest["/Page"].indirect_reference.idnum
            ].indirect_reference
            self.add_named_destination_array(dest["/Title"], arr)

    def _add_articles_thread(
        self,
        thread: DictionaryObject,  # thread entry from the reader's array of threads
        pages: dict[int, PageObject],
        reader: PdfReader,
    ) -> IndirectObject:
        """
        Clone the thread with only the applicable articles.

        Args:
            thread:
            pages:
            reader:

        Returns:
            The added thread as an indirect reference

        """
        nthread = thread.clone(
            self, force_duplicate=True, ignore_fields=("/F",)
        )  # use of clone to keep link between reader and writer
        self.threads.append(nthread.indirect_reference)
        first_article = cast("DictionaryObject", thread["/F"])
        current_article: Optional[DictionaryObject] = first_article
        new_article: Optional[DictionaryObject] = None
        while current_article is not None:
            pag = self._get_cloned_page(
                cast("PageObject", current_article["/P"]), pages, reader
            )
            if pag is not None:
                if new_article is None:
                    new_article = cast(
                        "DictionaryObject",
                        self._add_object(DictionaryObject()).get_object(),
                    )
                    new_first = new_article
                    nthread[NameObject("/F")] = new_article.indirect_reference
                else:
                    new_article2 = cast(
                        "DictionaryObject",
                        self._add_object(
                            DictionaryObject(
                                {NameObject("/V"): new_article.indirect_reference}
                            )
                        ).get_object(),
                    )
                    new_article[NameObject("/N")] = new_article2.indirect_reference
                    new_article = new_article2
                new_article[NameObject("/P")] = pag
                new_article[NameObject("/T")] = nthread.indirect_reference
                new_article[NameObject("/R")] = current_article["/R"]
                pag_obj = cast("PageObject", pag.get_object())
                if "/B" not in pag_obj:
                    pag_obj[NameObject("/B")] = ArrayObject()
                cast("ArrayObject", pag_obj["/B"]).append(
                    new_article.indirect_reference
                )
            current_article = cast("DictionaryObject", current_article["/N"])
            if current_article == first_article:
                new_article[NameObject("/N")] = new_first.indirect_reference  # type: ignore
                new_first[NameObject("/V")] = new_article.indirect_reference  # type: ignore
                current_article = None
        assert nthread.indirect_reference is not None
        return nthread.indirect_reference

    def add_filtered_articles(
        self,
        fltr: Union[
            Pattern[Any], str
        ],  # thread entry from the reader's array of threads
        pages: dict[int, PageObject],
        reader: PdfReader,
    ) -> None:
        """
        Add articles matching the defined criteria.

        Args:
            fltr:
            pages:
            reader:

        """
        if isinstance(fltr, str):
            fltr = re.compile(fltr)
        elif not isinstance(fltr, Pattern):
            fltr = re.compile("")
        for p in pages.values():
            pp = p.original_page
            for a in pp.get("/B", ()):
                a_obj = a.get_object()
                if is_null_or_none(a_obj):
                    continue
                thr = a_obj.get("/T")
                if thr is None:
                    continue
                thr = thr.get_object()
                if thr.indirect_reference.idnum not in self._id_translated[
                    id(reader)
                ] and fltr.search((thr.get("/I", {})).get("/Title", "")):
                    self._add_articles_thread(thr, pages, reader)

    def _get_cloned_page(
        self,
        page: Union[None, IndirectObject, PageObject, NullObject],
        pages: dict[int, PageObject],
        reader: PdfReader,
    ) -> Optional[IndirectObject]:
        if isinstance(page, NullObject):
            return None
        if isinstance(page, DictionaryObject) and page.get("/Type", "") == "/Page":
            _i = page.indirect_reference
        elif isinstance(page, IndirectObject):
            _i = page
        try:
            return pages[_i.idnum].indirect_reference  # type: ignore
        except Exception:
            return None

    def _insert_filtered_annotations(
        self,
        annots: Union[IndirectObject, list[DictionaryObject], None],
        page: PageObject,
        pages: dict[int, PageObject],
        reader: PdfReader,
    ) -> list[Destination]:
        outlist = ArrayObject()
        if isinstance(annots, IndirectObject):
            annots = cast("list[Any]", annots.get_object())
        if annots is None:
            return outlist
        if not isinstance(annots, list):
            logger_warning(f"Expected list of annotations, got {annots} of type {annots.__class__.__name__}.", __name__)
            return outlist
        for an in annots:
            ano = cast("DictionaryObject", an.get_object())
            if (
                ano["/Subtype"] != "/Link"
                or "/A" not in ano
                or cast("DictionaryObject", ano["/A"])["/S"] != "/GoTo"
                or "/Dest" in ano
            ):
                if "/Dest" not in ano:
                    outlist.append(self._add_object(ano.clone(self)))
                else:
                    d = ano["/Dest"]
                    if isinstance(d, str):
                        # it is a named dest
                        if str(d) in self.get_named_dest_root():
                            outlist.append(ano.clone(self).indirect_reference)
                    else:
                        d = cast("ArrayObject", d)
                        p = self._get_cloned_page(d[0], pages, reader)
                        if p is not None:
                            anc = ano.clone(self, ignore_fields=("/Dest",))
                            anc[NameObject("/Dest")] = ArrayObject([p, *d[1:]])
                            outlist.append(self._add_object(anc))
            else:
                d = cast("DictionaryObject", ano["/A"]).get("/D", NullObject())
                if is_null_or_none(d):
                    continue
                if isinstance(d, str):
                    # it is a named dest
                    if str(d) in self.get_named_dest_root():
                        outlist.append(ano.clone(self).indirect_reference)
                else:
                    d = cast("ArrayObject", d)
                    p = self._get_cloned_page(d[0], pages, reader)
                    if p is not None:
                        anc = ano.clone(self, ignore_fields=("/D",))
                        cast("DictionaryObject", anc["/A"])[
                            NameObject("/D")
                        ] = ArrayObject([p, *d[1:]])
                        outlist.append(self._add_object(anc))
        return outlist

    def _get_filtered_outline(
        self,
        node: Any,
        pages: dict[int, PageObject],
        reader: PdfReader,
    ) -> list[Destination]:
        """
        Extract outline item entries that are part of the specified page set.

        Args:
            node:
            pages:
            reader:

        Returns:
            A list of destination objects.

        """
        new_outline = []
        if node is None:
            node = NullObject()
        node = node.get_object()
        if is_null_or_none(node):
            node = DictionaryObject()
        if node.get("/Type", "") == "/Outlines" or "/Title" not in node:
            node = node.get("/First", None)
            if node is not None:
                node = node.get_object()
                new_outline += self._get_filtered_outline(node, pages, reader)
        else:
            v: Union[None, IndirectObject, NullObject]
            while node is not None:
                node = node.get_object()
                o = cast("Destination", reader._build_outline_item(node))
                v = self._get_cloned_page(cast("PageObject", o["/Page"]), pages, reader)
                if v is None:
                    v = NullObject()
                o[NameObject("/Page")] = v
                if "/First" in node:
                    o._filtered_children = self._get_filtered_outline(
                        node["/First"], pages, reader
                    )
                else:
                    o._filtered_children = []
                if (
                    not isinstance(o["/Page"], NullObject)
                    or len(o._filtered_children) > 0
                ):
                    new_outline.append(o)
                node = node.get("/Next", None)
        return new_outline

    def _clone_outline(self, dest: Destination) -> TreeObject:
        n_ol = TreeObject()
        self._add_object(n_ol)
        n_ol[NameObject("/Title")] = TextStringObject(dest["/Title"])
        if not isinstance(dest["/Page"], NullObject):
            if dest.node is not None and "/A" in dest.node:
                n_ol[NameObject("/A")] = dest.node["/A"].clone(self)
            else:
                n_ol[NameObject("/Dest")] = dest.dest_array
        # TODO: /SE
        if dest.node is not None:
            n_ol[NameObject("/F")] = NumberObject(dest.node.get("/F", 0))
            n_ol[NameObject("/C")] = ArrayObject(
                dest.node.get(
                    "/C", [FloatObject(0.0), FloatObject(0.0), FloatObject(0.0)]
                )
            )
        return n_ol

    def _insert_filtered_outline(
        self,
        outlines: list[Destination],
        parent: Union[TreeObject, IndirectObject],
        before: Union[None, TreeObject, IndirectObject] = None,
    ) -> None:
        for dest in outlines:
            # TODO: can be improved to keep A and SE entries (ignored for the moment)
            # with np=self.add_outline_item_destination(dest,parent,before)
            if dest.get("/Type", "") == "/Outlines" or "/Title" not in dest:
                np = parent
            else:
                np = self._clone_outline(dest)
                cast(TreeObject, parent.get_object()).insert_child(np, before, self)
            self._insert_filtered_outline(dest._filtered_children, np, None)

    def close(self) -> None:
        """Implemented for API harmonization."""
        return

    def find_outline_item(
        self,
        outline_item: dict[str, Any],
        root: Optional[OutlineType] = None,
    ) -> Optional[list[int]]:
        if root is None:
            o = self.get_outline_root()
        else:
            o = cast("TreeObject", root)

        i = 0
        while o is not None:
            if (
                o.indirect_reference == outline_item
                or o.get("/Title", None) == outline_item
            ):
                return [i]
            if "/First" in o:
                res = self.find_outline_item(
                    outline_item, cast(OutlineType, o["/First"])
                )
                if res:
                    return ([i] if "/Title" in o else []) + res
            if "/Next" in o:
                i += 1
                o = cast(TreeObject, o["/Next"])
            else:
                return None
        raise PyPdfError("This line is theoretically unreachable.")  # pragma: no cover

    def reset_translation(
        self, reader: Union[None, PdfReader, IndirectObject] = None
    ) -> None:
        """
        Reset the translation table between reader and the writer object.

        Late cloning will create new independent objects.

        Args:
            reader: PdfReader or IndirectObject referencing a PdfReader object.
                if set to None or omitted, all tables will be reset.

        """
        if reader is None:
            self._id_translated = {}
        elif isinstance(reader, PdfReader):
            try:
                del self._id_translated[id(reader)]
            except Exception:
                pass
        elif isinstance(reader, IndirectObject):
            try:
                del self._id_translated[id(reader.pdf)]
            except Exception:
                pass
        else:
            raise Exception("invalid parameter {reader}")

    def set_page_label(
        self,
        page_index_from: int,
        page_index_to: int,
        style: Optional[PageLabelStyle] = None,
        prefix: Optional[str] = None,
        start: Optional[int] = 0,
    ) -> None:
        """
        Set a page label to a range of pages.

        Page indexes must be given starting from 0.
        Labels must have a style, a prefix or both.
        If a range is not assigned any page label, a decimal label starting from 1 is applied.

        Args:
            page_index_from: page index of the beginning of the range starting from 0
            page_index_to: page index of the beginning of the range starting from 0
            style: The numbering style to be used for the numeric portion of each page label:

                       * ``/D`` Decimal Arabic numerals
                       * ``/R`` Uppercase Roman numerals
                       * ``/r`` Lowercase Roman numerals
                       * ``/A`` Uppercase letters (A to Z for the first 26 pages,
                         AA to ZZ for the next 26, and so on)
                       * ``/a`` Lowercase letters (a to z for the first 26 pages,
                         aa to zz for the next 26, and so on)

            prefix: The label prefix for page labels in this range.
            start:  The value of the numeric portion for the first page label
                    in the range.
                    Subsequent pages are numbered sequentially from this value,
                    which must be greater than or equal to 1.
                    Default value: 1.

        """
        if style is None and prefix is None:
            raise ValueError("At least one of style and prefix must be given")
        if page_index_from < 0:
            raise ValueError("page_index_from must be greater or equal than 0")
        if page_index_to < page_index_from:
            raise ValueError(
                "page_index_to must be greater or equal than page_index_from"
            )
        if page_index_to >= len(self.pages):
            raise ValueError("page_index_to exceeds number of pages")
        if start is not None and start != 0 and start < 1:
            raise ValueError("If given, start must be greater or equal than one")

        self._set_page_label(page_index_from, page_index_to, style, prefix, start)

    def _set_page_label(
        self,
        page_index_from: int,
        page_index_to: int,
        style: Optional[PageLabelStyle] = None,
        prefix: Optional[str] = None,
        start: Optional[int] = 0,
    ) -> None:
        """
        Set a page label to a range of pages.

        Page indexes must be given starting from 0.
        Labels must have a style, a prefix or both.
        If a range is not assigned any page label a decimal label starting from 1 is applied.

        Args:
            page_index_from: page index of the beginning of the range starting from 0
            page_index_to: page index of the beginning of the range starting from 0
            style:  The numbering style to be used for the numeric portion of each page label:
                        /D Decimal Arabic numerals
                        /R Uppercase Roman numerals
                        /r Lowercase Roman numerals
                        /A Uppercase letters (A to Z for the first 26 pages,
                           AA to ZZ for the next 26, and so on)
                        /a Lowercase letters (a to z for the first 26 pages,
                           aa to zz for the next 26, and so on)
            prefix: The label prefix for page labels in this range.
            start:  The value of the numeric portion for the first page label
                    in the range.
                    Subsequent pages are numbered sequentially from this value,
                    which must be greater than or equal to 1. Default value: 1.

        """
        default_page_label = DictionaryObject()
        default_page_label[NameObject("/S")] = NameObject("/D")

        new_page_label = DictionaryObject()
        if style is not None:
            new_page_label[NameObject("/S")] = NameObject(style)
        if prefix is not None:
            new_page_label[NameObject("/P")] = TextStringObject(prefix)
        if start != 0:
            new_page_label[NameObject("/St")] = NumberObject(start)

        if NameObject(CatalogDictionary.PAGE_LABELS) not in self._root_object:
            nums = ArrayObject()
            nums_insert(NumberObject(0), default_page_label, nums)
            page_labels = TreeObject()
            page_labels[NameObject("/Nums")] = nums
            self._root_object[NameObject(CatalogDictionary.PAGE_LABELS)] = page_labels

        page_labels = cast(
            TreeObject, self._root_object[NameObject(CatalogDictionary.PAGE_LABELS)]
        )
        nums = cast(ArrayObject, page_labels[NameObject("/Nums")])

        nums_insert(NumberObject(page_index_from), new_page_label, nums)
        nums_clear_range(NumberObject(page_index_from), page_index_to, nums)
        next_label_pos, *_ = nums_next(NumberObject(page_index_from), nums)
        if next_label_pos != page_index_to + 1 and page_index_to + 1 < len(self.pages):
            nums_insert(NumberObject(page_index_to + 1), default_page_label, nums)

        page_labels[NameObject("/Nums")] = nums
        self._root_object[NameObject(CatalogDictionary.PAGE_LABELS)] = page_labels

    def _repr_mimebundle_(
        self,
        include: Union[None, Iterable[str]] = None,
        exclude: Union[None, Iterable[str]] = None,
    ) -> dict[str, Any]:
        """
        Integration into Jupyter Notebooks.

        This method returns a dictionary that maps a mime-type to its
        representation.

        .. seealso::

           https://ipython.readthedocs.io/en/stable/config/integrating.html
        """
        pdf_data = BytesIO()
        self.write(pdf_data)
        data = {
            "application/pdf": pdf_data,
        }

        if include is not None:
            # Filter representations based on include list
            data = {k: v for k, v in data.items() if k in include}

        if exclude is not None:
            # Remove representations based on exclude list
            data = {k: v for k, v in data.items() if k not in exclude}

        return data


def _pdf_objectify(obj: Union[dict[str, Any], str, float, list[Any]]) -> PdfObject:
    if isinstance(obj, PdfObject):
        return obj
    if isinstance(obj, dict):
        to_add = DictionaryObject()
        for key, value in obj.items():
            to_add[NameObject(key)] = _pdf_objectify(value)
        return to_add
    if isinstance(obj, str):
        if obj.startswith("/"):
            return NameObject(obj)
        return TextStringObject(obj)
    if isinstance(obj, (float, int)):
        return FloatObject(obj)
    if isinstance(obj, list):
        return ArrayObject(_pdf_objectify(i) for i in obj)
    raise NotImplementedError(
        f"{type(obj)=} could not be cast to a PdfObject"
    )


def _create_outline_item(
    action_ref: Union[None, IndirectObject],
    title: str,
    color: Union[tuple[float, float, float], str, None],
    italic: bool,
    bold: bool,
) -> TreeObject:
    outline_item = TreeObject()
    if action_ref is not None:
        outline_item[NameObject("/A")] = action_ref
    outline_item.update(
        {
            NameObject("/Title"): create_string_object(title),
        }
    )
    if color:
        if isinstance(color, str):
            color = hex_to_rgb(color)
        outline_item.update(
            {NameObject("/C"): ArrayObject([FloatObject(c) for c in color])}
        )
    if italic or bold:
        format_flag = 0
        if italic:
            format_flag += OutlineFontFlag.italic
        if bold:
            format_flag += OutlineFontFlag.bold
        outline_item.update({NameObject("/F"): NumberObject(format_flag)})
    return outline_item
