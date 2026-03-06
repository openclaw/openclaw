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

import math
from collections.abc import Iterable, Iterator, Sequence
from copy import deepcopy
from dataclasses import asdict, dataclass
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import (
    Any,
    Callable,
    Literal,
    Optional,
    Union,
    cast,
    overload,
)

from ._font import Font
from ._protocols import PdfCommonDocProtocol
from ._text_extraction import (
    _layout_mode,
)
from ._text_extraction._text_extractor import TextExtraction
from ._utils import (
    CompressedTransformationMatrix,
    TransformationMatrixType,
    _human_readable_bytes,
    deprecate,
    logger_warning,
    matrix_multiply,
)
from .constants import _INLINE_IMAGE_KEY_MAPPING, _INLINE_IMAGE_VALUE_MAPPING
from .constants import AnnotationDictionaryAttributes as ADA
from .constants import ImageAttributes as IA
from .constants import PageAttributes as PG
from .constants import Resources as RES
from .errors import PageSizeNotDefinedError, PdfReadError
from .generic import (
    ArrayObject,
    ContentStream,
    DictionaryObject,
    EncodedStreamObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NullObject,
    NumberObject,
    PdfObject,
    RectangleObject,
    StreamObject,
    is_null_or_none,
)

try:
    from PIL.Image import Image

    pil_not_imported = False
except ImportError:
    Image = object  # type: ignore[assignment,misc,unused-ignore]  # TODO: Remove unused-ignore on Python 3.10
    pil_not_imported = True  # error will be raised only when using images

MERGE_CROP_BOX = "cropbox"  # pypdf <= 3.4.0 used "trimbox"


def _get_rectangle(self: Any, name: str, defaults: Iterable[str]) -> RectangleObject:
    retval: Union[None, RectangleObject, ArrayObject, IndirectObject] = self.get(name)
    if isinstance(retval, RectangleObject):
        return retval
    if is_null_or_none(retval):
        for d in defaults:
            retval = self.get(d)
            if retval is not None:
                break
    if isinstance(retval, IndirectObject):
        retval = self.pdf.get_object(retval)
    if isinstance(retval, ArrayObject) and (length := len(retval)) > 4:
        logger_warning(f"Expected four values, got {length}: {retval}", __name__)
        retval = RectangleObject(tuple(retval[:4]))
    else:
        retval = RectangleObject(retval)  # type: ignore
    _set_rectangle(self, name, retval)
    return retval


def _set_rectangle(self: Any, name: str, value: Union[RectangleObject, float]) -> None:
    self[NameObject(name)] = value


def _delete_rectangle(self: Any, name: str) -> None:
    del self[name]


def _create_rectangle_accessor(name: str, fallback: Iterable[str]) -> property:
    return property(
        lambda self: _get_rectangle(self, name, fallback),
        lambda self, value: _set_rectangle(self, name, value),
        lambda self: _delete_rectangle(self, name),
    )


class Transformation:
    """
    Represent a 2D transformation.

    The transformation between two coordinate systems is represented by a 3-by-3
    transformation matrix with the following form::

        a b 0
        c d 0
        e f 1

    Because a transformation matrix has only six elements that can be changed,
    it is usually specified in PDF as the six-element array [ a b c d e f ].

    Coordinate transformations are expressed as matrix multiplications::

                                 a b 0
     [ x′ y′ 1 ] = [ x y 1 ] ×   c d 0
                                 e f 1


    Example:
        >>> from pypdf import PdfWriter, Transformation
        >>> page = PdfWriter().add_blank_page(800, 600)
        >>> op = Transformation().scale(sx=2, sy=3).translate(tx=10, ty=20)
        >>> page.add_transformation(op)

    """

    def __init__(self, ctm: CompressedTransformationMatrix = (1, 0, 0, 1, 0, 0)) -> None:
        self.ctm = ctm

    @property
    def matrix(self) -> TransformationMatrixType:
        """
        Return the transformation matrix as a tuple of tuples in the form:

        ((a, b, 0), (c, d, 0), (e, f, 1))
        """
        return (
            (self.ctm[0], self.ctm[1], 0),
            (self.ctm[2], self.ctm[3], 0),
            (self.ctm[4], self.ctm[5], 1),
        )

    @staticmethod
    def compress(matrix: TransformationMatrixType) -> CompressedTransformationMatrix:
        """
        Compresses the transformation matrix into a tuple of (a, b, c, d, e, f).

        Args:
            matrix: The transformation matrix as a tuple of tuples.

        Returns:
            A tuple representing the transformation matrix as (a, b, c, d, e, f)

        """
        return (
            matrix[0][0],
            matrix[0][1],
            matrix[1][0],
            matrix[1][1],
            matrix[2][0],
            matrix[2][1],
        )

    def _to_cm(self) -> str:
        # Returns the cm operation string for the given transformation matrix
        return (
            f"{self.ctm[0]:.4f} {self.ctm[1]:.4f} {self.ctm[2]:.4f} "
            f"{self.ctm[3]:.4f} {self.ctm[4]:.4f} {self.ctm[5]:.4f} cm"
        )

    def transform(self, m: "Transformation") -> "Transformation":
        """
        Apply one transformation to another.

        Args:
            m: a Transformation to apply.

        Returns:
            A new ``Transformation`` instance

        Example:
            >>> from pypdf import PdfWriter, Transformation
            >>> height, width = 40, 50
            >>> page = PdfWriter().add_blank_page(800, 600)
            >>> op = Transformation((1, 0, 0, -1, 0, height)) # vertical mirror
            >>> op = Transformation().transform(Transformation((-1, 0, 0, 1, width, 0)))  # horizontal mirror
            >>> page.add_transformation(op)

        """
        ctm = Transformation.compress(matrix_multiply(self.matrix, m.matrix))
        return Transformation(ctm)

    def translate(self, tx: float = 0, ty: float = 0) -> "Transformation":
        """
        Translate the contents of a page.

        Args:
            tx: The translation along the x-axis.
            ty: The translation along the y-axis.

        Returns:
            A new ``Transformation`` instance

        """
        m = self.ctm
        return Transformation(ctm=(m[0], m[1], m[2], m[3], m[4] + tx, m[5] + ty))

    def scale(
        self, sx: Optional[float] = None, sy: Optional[float] = None
    ) -> "Transformation":
        """
        Scale the contents of a page towards the origin of the coordinate system.

        Typically, that is the lower-left corner of the page. That can be
        changed by translating the contents / the page boxes.

        Args:
            sx: The scale factor along the x-axis.
            sy: The scale factor along the y-axis.

        Returns:
            A new Transformation instance with the scaled matrix.

        """
        if sx is None and sy is None:
            raise ValueError("Either sx or sy must be specified")
        if sx is None:
            sx = sy
        if sy is None:
            sy = sx
        assert sx is not None
        assert sy is not None
        op: TransformationMatrixType = ((sx, 0, 0), (0, sy, 0), (0, 0, 1))
        ctm = Transformation.compress(matrix_multiply(self.matrix, op))
        return Transformation(ctm)

    def rotate(self, rotation: float) -> "Transformation":
        """
        Rotate the contents of a page.

        Args:
            rotation: The angle of rotation in degrees.

        Returns:
            A new ``Transformation`` instance with the rotated matrix.

        """
        rotation = math.radians(rotation)
        op: TransformationMatrixType = (
            (math.cos(rotation), math.sin(rotation), 0),
            (-math.sin(rotation), math.cos(rotation), 0),
            (0, 0, 1),
        )
        ctm = Transformation.compress(matrix_multiply(self.matrix, op))
        return Transformation(ctm)

    def __repr__(self) -> str:
        return f"Transformation(ctm={self.ctm})"

    @overload
    def apply_on(self, pt: list[float], as_object: bool = False) -> list[float]:
        ...

    @overload
    def apply_on(
        self, pt: tuple[float, float], as_object: bool = False
    ) -> tuple[float, float]:
        ...

    def apply_on(
        self,
        pt: Union[tuple[float, float], list[float]],
        as_object: bool = False,
    ) -> Union[tuple[float, float], list[float]]:
        """
        Apply the transformation matrix on the given point.

        Args:
            pt: A tuple or list representing the point in the form (x, y).
            as_object: If True, return items as FloatObject, otherwise as plain floats.

        Returns:
            A tuple or list representing the transformed point in the form (x', y')

        """
        typ = FloatObject if as_object else float
        pt1 = (
            typ(float(pt[0]) * self.ctm[0] + float(pt[1]) * self.ctm[2] + self.ctm[4]),
            typ(float(pt[0]) * self.ctm[1] + float(pt[1]) * self.ctm[3] + self.ctm[5]),
        )
        return list(pt1) if isinstance(pt, list) else pt1


@dataclass
class ImageFile:
    """
    Image within the PDF file. *This object is not designed to be built.*

    This object should not be modified except using :func:`ImageFile.replace` to replace the image with a new one.
    """

    name: str = ""
    """
    Filename as identified within the PDF file.
    """

    data: bytes = b""
    """
    Data as bytes.
    """

    image: Optional[Image] = None
    """
    Data as PIL image.
    """

    indirect_reference: Optional[IndirectObject] = None
    """
    Reference to the object storing the stream.
    """

    def replace(self, new_image: Image, **kwargs: Any) -> None:
        """
        Replace the image with a new PIL image.

        Args:
            new_image (PIL.Image.Image): The new PIL image to replace the existing image.
            **kwargs: Additional keyword arguments to pass to `Image.save()`.

        Raises:
            TypeError: If the image is inline or in a PdfReader.
            TypeError: If the image does not belong to a PdfWriter.
            TypeError: If `new_image` is not a PIL Image.

        Note:
            This method replaces the existing image with a new image.
            It is not allowed for inline images or images within a PdfReader.
            The `kwargs` parameter allows passing additional parameters
            to `Image.save()`, such as quality.

        """
        if pil_not_imported:
            raise ImportError(
                "pillow is required to do image extraction. "
                "It can be installed via 'pip install pypdf[image]'"
            )

        from ._reader import PdfReader  # noqa: PLC0415

        # to prevent circular import
        from ._xobj_image_helpers import _xobj_to_image  # noqa: PLC0415
        from .generic import DictionaryObject, PdfObject  # noqa: PLC0415

        if self.indirect_reference is None:
            raise TypeError("Cannot update an inline image.")
        if not hasattr(self.indirect_reference.pdf, "_id_translated"):
            raise TypeError("Cannot update an image not belonging to a PdfWriter.")
        if not isinstance(new_image, Image):
            raise TypeError("new_image shall be a PIL Image")
        b = BytesIO()
        new_image.save(b, "PDF", **kwargs)
        reader = PdfReader(b)
        page_image = reader.pages[0].images[0]
        assert page_image.indirect_reference is not None
        self.indirect_reference.pdf._objects[self.indirect_reference.idnum - 1] = (
            page_image.indirect_reference.get_object()
        )
        cast(
            PdfObject, self.indirect_reference.get_object()
        ).indirect_reference = self.indirect_reference
        # change the object attributes
        extension, byte_stream, img = _xobj_to_image(
            cast(DictionaryObject, self.indirect_reference.get_object()),
            pillow_parameters=kwargs,
        )
        assert extension is not None
        self.name = self.name[: self.name.rfind(".")] + extension
        self.data = byte_stream
        self.image = img

    def __str__(self) -> str:
        return f"{self.__class__.__name__}(name={self.name}, data: {_human_readable_bytes(len(self.data))})"

    def __repr__(self) -> str:
        return self.__str__()[:-1] + f", hash: {hash(self.data)})"


class VirtualListImages(Sequence[ImageFile]):
    """
    Provides access to images referenced within a page.
    Only one copy will be returned if the usage is used on the same page multiple times.
    See :func:`PageObject.images` for more details.
    """

    def __init__(
        self,
        ids_function: Callable[[], list[Union[str, list[str]]]],
        get_function: Callable[[Union[str, list[str], tuple[str]]], ImageFile],
    ) -> None:
        self.ids_function = ids_function
        self.get_function = get_function
        self.current = -1

    def __len__(self) -> int:
        return len(self.ids_function())

    def keys(self) -> list[Union[str, list[str]]]:
        return self.ids_function()

    def items(self) -> list[tuple[Union[str, list[str]], ImageFile]]:
        return [(x, self[x]) for x in self.ids_function()]

    @overload
    def __getitem__(self, index: Union[int, str, list[str]]) -> ImageFile:
        ...

    @overload
    def __getitem__(self, index: slice) -> Sequence[ImageFile]:
        ...

    def __getitem__(
        self, index: Union[int, slice, str, list[str], tuple[str]]
    ) -> Union[ImageFile, Sequence[ImageFile]]:
        lst = self.ids_function()
        if isinstance(index, slice):
            indices = range(*index.indices(len(self)))
            lst = [lst[x] for x in indices]
            cls = type(self)
            return cls((lambda: lst), self.get_function)
        if isinstance(index, (str, list, tuple)):
            return self.get_function(index)
        if not isinstance(index, int):
            raise TypeError("Invalid sequence indices type")
        len_self = len(lst)
        if index < 0:
            # support negative indexes
            index += len_self
        if not (0 <= index < len_self):
            raise IndexError("Sequence index out of range")
        return self.get_function(lst[index])

    def __iter__(self) -> Iterator[ImageFile]:
        for i in range(len(self)):
            yield self[i]

    def __str__(self) -> str:
        p = [f"Image_{i}={n}" for i, n in enumerate(self.ids_function())]
        return f"[{', '.join(p)}]"


class PageObject(DictionaryObject):
    """
    PageObject represents a single page within a PDF file.

    Typically these objects will be created by accessing the
    :attr:`pages<pypdf.PdfReader.pages>` property of the
    :class:`PdfReader<pypdf.PdfReader>` class, but it is
    also possible to create an empty page with the
    :meth:`create_blank_page()<pypdf._page.PageObject.create_blank_page>` static method.

    Args:
        pdf: PDF file the page belongs to.
        indirect_reference: Stores the original indirect reference to
            this object in its source PDF

    """

    original_page: "PageObject"  # very local use in writer when appending

    def __init__(
        self,
        pdf: Optional[PdfCommonDocProtocol] = None,
        indirect_reference: Optional[IndirectObject] = None,
    ) -> None:
        DictionaryObject.__init__(self)
        self.pdf = pdf
        self.inline_images: Optional[dict[str, ImageFile]] = None
        self.indirect_reference = indirect_reference
        if not is_null_or_none(indirect_reference):
            assert indirect_reference is not None, "mypy"
            self.update(cast(DictionaryObject, indirect_reference.get_object()))
        self._font_width_maps: dict[str, tuple[dict[str, float], str, float]] = {}

    def hash_bin(self) -> int:
        """
        Used to detect modified object.

        Note: this function is overloaded to return the same results
        as a DictionaryObject.

        Returns:
            Hash considering type and value.

        """
        return hash(
            (DictionaryObject, tuple(((k, v.hash_bin()) for k, v in self.items())))
        )

    def hash_value_data(self) -> bytes:
        data = super().hash_value_data()
        data += f"{id(self)}".encode()
        return data

    @property
    def user_unit(self) -> float:
        """
        A read-only positive number giving the size of user space units.

        It is in multiples of 1/72 inch. Hence a value of 1 means a user
        space unit is 1/72 inch, and a value of 3 means that a user
        space unit is 3/72 inch.
        """
        return self.get(PG.USER_UNIT, 1)

    @staticmethod
    def create_blank_page(
        pdf: Optional[PdfCommonDocProtocol] = None,
        width: Union[float, Decimal, None] = None,
        height: Union[float, Decimal, None] = None,
    ) -> "PageObject":
        """
        Return a new blank page.

        If ``width`` or ``height`` is ``None``, try to get the page size
        from the last page of *pdf*.

        Args:
            pdf: PDF file the page is within.
            width: The width of the new page expressed in default user
                space units.
            height: The height of the new page expressed in default user
                space units.

        Returns:
            The new blank page

        Raises:
            PageSizeNotDefinedError: if ``pdf`` is ``None`` or contains
                no page

        """
        page = PageObject(pdf)

        # Creates a new page (cf PDF Reference §7.7.3.3)
        page.__setitem__(NameObject(PG.TYPE), NameObject("/Page"))
        page.__setitem__(NameObject(PG.PARENT), NullObject())
        page.__setitem__(NameObject(PG.RESOURCES), DictionaryObject())
        if width is None or height is None:
            if pdf is not None and len(pdf.pages) > 0:
                lastpage = pdf.pages[len(pdf.pages) - 1]
                width = lastpage.mediabox.width
                height = lastpage.mediabox.height
            else:
                raise PageSizeNotDefinedError
        page.__setitem__(
            NameObject(PG.MEDIABOX), RectangleObject((0, 0, width, height))  # type: ignore
        )

        return page

    def _get_ids_image(
        self,
        obj: Optional[DictionaryObject] = None,
        ancest: Optional[list[str]] = None,
        call_stack: Optional[list[Any]] = None,
    ) -> list[Union[str, list[str]]]:
        if call_stack is None:
            call_stack = []
        _i = getattr(obj, "indirect_reference", None)
        if _i in call_stack:
            return []
        call_stack.append(_i)
        if self.inline_images is None:
            self.inline_images = self._get_inline_images()
        if obj is None:
            obj = self
        if ancest is None:
            ancest = []
        lst: list[Union[str, list[str]]] = []
        if (
                PG.RESOURCES not in obj or
                is_null_or_none(resources := obj[PG.RESOURCES]) or
                RES.XOBJECT not in cast(DictionaryObject, resources)
        ):
            return [] if self.inline_images is None else list(self.inline_images.keys())

        x_object = resources[RES.XOBJECT].get_object()  # type: ignore
        for o in x_object:
            if not isinstance(x_object[o], StreamObject):
                continue
            if x_object[o][IA.SUBTYPE] == "/Image":
                lst.append(o if len(ancest) == 0 else [*ancest, o])
            else:  # is a form with possible images inside
                lst.extend(self._get_ids_image(x_object[o], [*ancest, o], call_stack))
        assert self.inline_images is not None
        lst.extend(list(self.inline_images.keys()))
        return lst

    def _get_image(
        self,
        id: Union[str, list[str], tuple[str]],
        obj: Optional[DictionaryObject] = None,
    ) -> ImageFile:
        if obj is None:
            obj = cast(DictionaryObject, self)
        if isinstance(id, tuple):
            id = list(id)
        if isinstance(id, list) and len(id) == 1:
            id = id[0]
        try:
            xobjs = cast(
                DictionaryObject, cast(DictionaryObject, obj[PG.RESOURCES])[RES.XOBJECT]
            )
        except KeyError:
            if not (id[0] == "~" and id[-1] == "~"):
                raise
        if isinstance(id, str):
            if id[0] == "~" and id[-1] == "~":
                if self.inline_images is None:
                    self.inline_images = self._get_inline_images()
                if self.inline_images is None:  # pragma: no cover
                    raise KeyError("No inline image can be found")
                return self.inline_images[id]

            from ._xobj_image_helpers import _xobj_to_image  # noqa: PLC0415
            imgd = _xobj_to_image(cast(DictionaryObject, xobjs[id]))
            extension, byte_stream = imgd[:2]
            return ImageFile(
                name=f"{id[1:]}{extension}",
                data=byte_stream,
                image=imgd[2],
                indirect_reference=xobjs[id].indirect_reference,
            )
        # in a subobject
        ids = id[1:]
        return self._get_image(ids, cast(DictionaryObject, xobjs[id[0]]))

    @property
    def images(self) -> VirtualListImages:
        """
        Read-only property emulating a list of images on a page.

        Get a list of all images on the page. The key can be:
        - A string (for the top object)
        - A tuple (for images within XObject forms)
        - An integer

        Examples:
            * `reader.pages[0].images[0]`        # return first image
            * `reader.pages[0].images['/I0']`    # return image '/I0'
            * `reader.pages[0].images['/TP1','/Image1']` # return image '/Image1' within '/TP1' XObject form
            * `for img in reader.pages[0].images:` # loops through all objects

        images.keys() and images.items() can be used.

        The ImageFile has the following properties:

            * `.name` : name of the object
            * `.data` : bytes of the object
            * `.image` : PIL Image Object
            * `.indirect_reference` : object reference

        and the following methods:
            `.replace(new_image: PIL.Image.Image, **kwargs)` :
                replace the image in the pdf with the new image
                applying the saving parameters indicated (such as quality)

        Example usage:

            reader.pages[0].images[0].replace(Image.open("new_image.jpg"), quality=20)

        Inline images are extracted and named ~0~, ~1~, ..., with the
        indirect_reference set to None.

        """
        return VirtualListImages(self._get_ids_image, self._get_image)

    def _translate_value_inline_image(self, k: str, v: PdfObject) -> PdfObject:
        """Translate values used in inline image"""
        try:
            v = NameObject(_INLINE_IMAGE_VALUE_MAPPING[cast(str, v)])
        except (TypeError, KeyError):
            if isinstance(v, NameObject):
                # It is a custom name, thus we have to look in resources.
                # The only applicable case is for ColorSpace.
                try:
                    res = cast(DictionaryObject, self["/Resources"])["/ColorSpace"]
                    v = cast(DictionaryObject, res)[v]
                except KeyError:  # for res and v
                    raise PdfReadError(f"Cannot find resource entry {v} for {k}")
        return v

    def _get_inline_images(self) -> dict[str, ImageFile]:
        """Load inline images. Entries will be identified as `~1~`."""
        content = self.get_contents()
        if is_null_or_none(content):
            return {}
        imgs_data = []
        assert content is not None, "mypy"
        for param, ope in content.operations:
            if ope == b"INLINE IMAGE":
                imgs_data.append(
                    {"settings": param["settings"], "__streamdata__": param["data"]}
                )
            elif ope in (b"BI", b"EI", b"ID"):  # pragma: no cover
                raise PdfReadError(
                    f"{ope!r} operator met whereas not expected, "
                    "please share use case with pypdf dev team"
                )
        files = {}
        for num, ii in enumerate(imgs_data):
            init = {
                "__streamdata__": ii["__streamdata__"],
                "/Length": len(ii["__streamdata__"]),
            }
            for k, v in ii["settings"].items():
                if k in {"/Length", "/L"}:  # no length is expected
                    continue
                if isinstance(v, list):
                    v = ArrayObject(
                        [self._translate_value_inline_image(k, x) for x in v]
                    )
                else:
                    v = self._translate_value_inline_image(k, v)
                k = NameObject(_INLINE_IMAGE_KEY_MAPPING[k])
                if k not in init:
                    init[k] = v
            ii["object"] = EncodedStreamObject.initialize_from_dictionary(init)
            from ._xobj_image_helpers import _xobj_to_image  # noqa: PLC0415
            extension, byte_stream, img = _xobj_to_image(ii["object"])
            files[f"~{num}~"] = ImageFile(
                name=f"~{num}~{extension}",
                data=byte_stream,
                image=img,
                indirect_reference=None,
            )
        return files

    @property
    def rotation(self) -> int:
        """
        The visual rotation of the page.

        This number has to be a multiple of 90 degrees: 0, 90, 180, or 270 are
        valid values. This property does not affect ``/Contents``.
        """
        rotate_obj = self.get(PG.ROTATE, 0)
        return rotate_obj if isinstance(rotate_obj, int) else rotate_obj.get_object()

    @rotation.setter
    def rotation(self, r: float) -> None:
        self[NameObject(PG.ROTATE)] = NumberObject((((int(r) + 45) // 90) * 90) % 360)

    def transfer_rotation_to_content(self) -> None:
        """
        Apply the rotation of the page to the content and the media/crop/...
        boxes.

        It is recommended to apply this function before page merging.
        """
        r = -self.rotation  # rotation to apply is in the otherway
        self.rotation = 0
        mb = RectangleObject(self.mediabox)
        trsf = (
            Transformation()
            .translate(
                -float(mb.left + mb.width / 2), -float(mb.bottom + mb.height / 2)
            )
            .rotate(r)
        )
        pt1 = trsf.apply_on(mb.lower_left)
        pt2 = trsf.apply_on(mb.upper_right)
        trsf = trsf.translate(-min(pt1[0], pt2[0]), -min(pt1[1], pt2[1]))
        self.add_transformation(trsf, False)
        for b in ["/MediaBox", "/CropBox", "/BleedBox", "/TrimBox", "/ArtBox"]:
            if b in self:
                rr = RectangleObject(self[b])  # type: ignore
                pt1 = trsf.apply_on(rr.lower_left)
                pt2 = trsf.apply_on(rr.upper_right)
                self[NameObject(b)] = RectangleObject(
                    (
                        min(pt1[0], pt2[0]),
                        min(pt1[1], pt2[1]),
                        max(pt1[0], pt2[0]),
                        max(pt1[1], pt2[1]),
                    )
                )

    def rotate(self, angle: int) -> "PageObject":
        """
        Rotate a page clockwise by increments of 90 degrees.

        Args:
            angle: Angle to rotate the page. Must be an increment of 90 deg.

        Returns:
            The rotated PageObject

        """
        if angle % 90 != 0:
            raise ValueError("Rotation angle must be a multiple of 90")
        self[NameObject(PG.ROTATE)] = NumberObject(self.rotation + angle)
        return self

    def _merge_resources(
        self,
        res1: DictionaryObject,
        res2: DictionaryObject,
        resource: Any,
        new_res1: bool = True,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        try:
            assert isinstance(self.indirect_reference, IndirectObject)
            pdf = self.indirect_reference.pdf
            is_pdf_writer = hasattr(
                pdf, "_add_object"
            )  # expect isinstance(pdf, PdfWriter)
        except (AssertionError, AttributeError):
            pdf = None
            is_pdf_writer = False

        def compute_unique_key(base_key: str) -> tuple[str, bool]:
            """
            Find a key that either doesn't already exist or has the same value
            (indicated by the bool)

            Args:
                base_key: An index is added to this to get the computed key

            Returns:
                A tuple (computed key, bool) where the boolean indicates
                if there is a resource of the given computed_key with the same
                value.

            """
            value = page2res.raw_get(base_key)
            # TODO: a possible improvement for writer, the indirect_reference
            # cannot be found because translated

            # try the current key first (e.g. "foo"), but otherwise iterate
            # through "foo-0", "foo-1", etc. new_res can contain only finitely
            # many keys, thus this'll eventually end, even if it's been crafted
            # to be maximally annoying.
            computed_key = base_key
            idx = 0
            while computed_key in new_res:
                if new_res.raw_get(computed_key) == value:
                    # there's already a resource of this name, with the exact
                    # same value
                    return computed_key, True
                computed_key = f"{base_key}-{idx}"
                idx += 1
            return computed_key, False

        if new_res1:
            new_res = DictionaryObject()
            new_res.update(res1.get(resource, DictionaryObject()).get_object())
        else:
            new_res = cast(DictionaryObject, res1[resource])
        page2res = cast(
            DictionaryObject, res2.get(resource, DictionaryObject()).get_object()
        )
        rename_res = {}
        for key in page2res:
            unique_key, same_value = compute_unique_key(key)
            newname = NameObject(unique_key)
            if key != unique_key:
                # we have to use a different name for this
                rename_res[key] = newname

            if not same_value:
                if is_pdf_writer:
                    new_res[newname] = page2res.raw_get(key).clone(pdf)
                    try:
                        new_res[newname] = new_res[newname].indirect_reference
                    except AttributeError:
                        pass
                else:
                    new_res[newname] = page2res.raw_get(key)
            lst = sorted(new_res.items())
            new_res.clear()
            for el in lst:
                new_res[el[0]] = el[1]
        return new_res, rename_res

    @staticmethod
    def _content_stream_rename(
        stream: ContentStream,
        rename: dict[Any, Any],
        pdf: Optional[PdfCommonDocProtocol],
    ) -> ContentStream:
        if not rename:
            return stream
        stream = ContentStream(stream, pdf)
        for operands, _operator in stream.operations:
            if isinstance(operands, list):
                for i, op in enumerate(operands):
                    if isinstance(op, NameObject):
                        operands[i] = rename.get(op, op)
            elif isinstance(operands, dict):
                for i, op in operands.items():
                    if isinstance(op, NameObject):
                        operands[i] = rename.get(op, op)
            else:
                raise KeyError(f"Type of operands is {type(operands)}")
        return stream

    @staticmethod
    def _add_transformation_matrix(
        contents: Any,
        pdf: Optional[PdfCommonDocProtocol],
        ctm: CompressedTransformationMatrix,
    ) -> ContentStream:
        """Add transformation matrix at the beginning of the given contents stream."""
        contents = ContentStream(contents, pdf)
        contents.operations.insert(
            0,
            [
                [FloatObject(x) for x in ctm],
                b"cm",
            ],
        )
        return contents

    def _get_contents_as_bytes(self) -> Optional[bytes]:
        """
        Return the page contents as bytes.

        Returns:
            The ``/Contents`` object as bytes, or ``None`` if it doesn't exist.

        """
        if PG.CONTENTS in self:
            obj = self[PG.CONTENTS].get_object()
            if isinstance(obj, list):
                return b"".join(x.get_object().get_data() for x in obj)
            return cast(EncodedStreamObject, obj).get_data()
        return None

    def get_contents(self) -> Optional[ContentStream]:
        """
        Access the page contents.

        Returns:
            The ``/Contents`` object, or ``None`` if it does not exist.
            ``/Contents`` is optional, as described in §7.7.3.3 of the PDF Reference.

        """
        if PG.CONTENTS in self:
            try:
                pdf = cast(IndirectObject, self.indirect_reference).pdf
            except AttributeError:
                pdf = None
            obj = self[PG.CONTENTS]
            if is_null_or_none(obj):
                return None
            resolved_object = obj.get_object()
            return ContentStream(resolved_object, pdf)
        return None

    def replace_contents(
        self, content: Union[None, ContentStream, EncodedStreamObject, ArrayObject]
    ) -> None:
        """
        Replace the page contents with the new content and nullify old objects
        Args:
            content: new content; if None delete the content field.
        """
        if not hasattr(self, "indirect_reference") or self.indirect_reference is None:
            # the page is not attached : the content is directly attached.
            self[NameObject(PG.CONTENTS)] = content
            return

        from pypdf._writer import PdfWriter  # noqa: PLC0415
        if not isinstance(self.indirect_reference.pdf, PdfWriter):
            deprecate(
                "Calling `PageObject.replace_contents()` for pages not assigned to a writer is deprecated "
                "and will be removed in pypdf 7.0.0. Attach the page to the writer first or use "
                "`PdfWriter(clone_from=...)` directly. The existing approach has proved being unreliable."
            )

        writer = self.indirect_reference.pdf
        if isinstance(self.get(PG.CONTENTS, None), ArrayObject):
            content_array = cast(ArrayObject, self[PG.CONTENTS])
            for reference in content_array:
                try:
                    writer._replace_object(indirect_reference=reference.indirect_reference, obj=NullObject())
                except ValueError:
                    # Occurs when called on PdfReader.
                    pass

        if isinstance(content, ArrayObject):
            content = ArrayObject(writer._add_object(obj) for obj in content)

        if is_null_or_none(content):
            if PG.CONTENTS not in self:
                return
            assert self[PG.CONTENTS].indirect_reference is not None
            writer._replace_object(indirect_reference=self[PG.CONTENTS].indirect_reference, obj=NullObject())
            del self[PG.CONTENTS]
        elif not hasattr(self.get(PG.CONTENTS, None), "indirect_reference"):
            try:
                self[NameObject(PG.CONTENTS)] = writer._add_object(content)
            except AttributeError:
                # applies at least for page not in writer
                # as a backup solution, we put content as an object although not in accordance with pdf ref
                # this will be fixed with the _add_object
                self[NameObject(PG.CONTENTS)] = content
        else:
            assert content is not None, "mypy"
            content.indirect_reference = self[
                PG.CONTENTS
            ].indirect_reference  # TODO: in the future may require generation management
            try:
                writer._replace_object(indirect_reference=content.indirect_reference, obj=content)
            except AttributeError:
                # applies at least for page not in writer
                # as a backup solution, we put content as an object although not in accordance with pdf ref
                # this will be fixed with the _add_object
                self[NameObject(PG.CONTENTS)] = content
        # forces recalculation of inline_images
        self.inline_images = None

    def merge_page(
        self, page2: "PageObject", expand: bool = False, over: bool = True
    ) -> None:
        """
        Merge the content streams of two pages into one.

        Resource references (e.g. fonts) are maintained from both pages.
        The mediabox, cropbox, etc of this page are not altered.
        The parameter page's content stream will
        be added to the end of this page's content stream,
        meaning that it will be drawn after, or "on top" of this page.

        Args:
            page2: The page to be merged into this one. Should be
                an instance of :class:`PageObject<PageObject>`.
            over: set the page2 content over page1 if True (default) else under
            expand: If True, the current page dimensions will be
                expanded to accommodate the dimensions of the page to be merged.

        """
        self._merge_page(page2, over=over, expand=expand)

    def _merge_page(
        self,
        page2: "PageObject",
        page2transformation: Optional[Callable[[Any], ContentStream]] = None,
        ctm: Optional[CompressedTransformationMatrix] = None,
        over: bool = True,
        expand: bool = False,
    ) -> None:
        # First we work on merging the resource dictionaries. This allows us
        # to find out what symbols in the content streams we might need to
        # rename.
        try:
            assert isinstance(self.indirect_reference, IndirectObject)
            if hasattr(
                self.indirect_reference.pdf, "_add_object"
            ):  # to detect PdfWriter
                return self._merge_page_writer(
                    page2, page2transformation, ctm, over, expand
                )
        except (AssertionError, AttributeError):
            pass

        new_resources = DictionaryObject()
        rename = {}
        original_resources = cast(DictionaryObject, self.get(PG.RESOURCES, DictionaryObject()).get_object())
        page2resources = cast(DictionaryObject, page2.get(PG.RESOURCES, DictionaryObject()).get_object())
        new_annots = ArrayObject()

        for page in (self, page2):
            if PG.ANNOTS in page:
                annots = page[PG.ANNOTS]
                if isinstance(annots, ArrayObject):
                    new_annots.extend(annots)

        for res in (
            RES.EXT_G_STATE,
            RES.FONT,
            RES.XOBJECT,
            RES.COLOR_SPACE,
            RES.PATTERN,
            RES.SHADING,
            RES.PROPERTIES,
        ):
            new, newrename = self._merge_resources(
                original_resources, page2resources, res
            )
            if new:
                new_resources[NameObject(res)] = new
                rename.update(newrename)

        # Combine /ProcSet sets, making sure there's a consistent order
        new_resources[NameObject(RES.PROC_SET)] = ArrayObject(
            sorted(
                set(
                    original_resources.get(RES.PROC_SET, ArrayObject()).get_object()
                ).union(
                    set(page2resources.get(RES.PROC_SET, ArrayObject()).get_object())
                )
            )
        )

        new_content_array = ArrayObject()
        original_content = self.get_contents()
        if original_content is not None:
            original_content.isolate_graphics_state()
            new_content_array.append(original_content)

        page2content = page2.get_contents()
        if page2content is not None:
            rect = getattr(page2, MERGE_CROP_BOX)
            page2content.operations.insert(
                0,
                (
                    map(
                        FloatObject,
                        [
                            rect.left,
                            rect.bottom,
                            rect.width,
                            rect.height,
                        ],
                    ),
                    b"re",
                ),
            )
            page2content.operations.insert(1, ([], b"W"))
            page2content.operations.insert(2, ([], b"n"))
            if page2transformation is not None:
                page2content = page2transformation(page2content)
            page2content = PageObject._content_stream_rename(
                page2content, rename, self.pdf
            )
            page2content.isolate_graphics_state()
            if over:
                new_content_array.append(page2content)
            else:
                new_content_array.insert(0, page2content)

        # if expanding the page to fit a new page, calculate the new media box size
        if expand:
            self._expand_mediabox(page2, ctm)

        self.replace_contents(ContentStream(new_content_array, self.pdf))
        self[NameObject(PG.RESOURCES)] = new_resources
        self[NameObject(PG.ANNOTS)] = new_annots
        return None

    def _merge_page_writer(
        self,
        page2: "PageObject",
        page2transformation: Optional[Callable[[Any], ContentStream]] = None,
        ctm: Optional[CompressedTransformationMatrix] = None,
        over: bool = True,
        expand: bool = False,
    ) -> None:
        # First we work on merging the resource dictionaries. This allows us
        # to find which symbols in the content streams we might need to
        # rename.
        assert isinstance(self.indirect_reference, IndirectObject)
        pdf = self.indirect_reference.pdf

        rename = {}
        if PG.RESOURCES not in self:
            self[NameObject(PG.RESOURCES)] = DictionaryObject()
        original_resources = cast(DictionaryObject, self[PG.RESOURCES].get_object())
        if PG.RESOURCES not in page2:
            page2resources = DictionaryObject()
        else:
            page2resources = cast(DictionaryObject, page2[PG.RESOURCES].get_object())

        for res in (
            RES.EXT_G_STATE,
            RES.FONT,
            RES.XOBJECT,
            RES.COLOR_SPACE,
            RES.PATTERN,
            RES.SHADING,
            RES.PROPERTIES,
        ):
            if res in page2resources:
                if res not in original_resources:
                    original_resources[NameObject(res)] = DictionaryObject()
                _, newrename = self._merge_resources(
                    original_resources, page2resources, res, False
                )
                rename.update(newrename)
        # Combine /ProcSet sets.
        if RES.PROC_SET in page2resources:
            if RES.PROC_SET not in original_resources:
                original_resources[NameObject(RES.PROC_SET)] = ArrayObject()
            arr = cast(ArrayObject, original_resources[RES.PROC_SET])
            for x in cast(ArrayObject, page2resources[RES.PROC_SET]):
                if x not in arr:
                    arr.append(x)
            arr.sort()

        if PG.ANNOTS in page2:
            if PG.ANNOTS not in self:
                self[NameObject(PG.ANNOTS)] = ArrayObject()
            annots = cast(ArrayObject, self[PG.ANNOTS].get_object())
            if ctm is None:
                trsf = Transformation()
            else:
                trsf = Transformation(ctm)
            # Ensure we are working on a copy of the list. Otherwise, if both pages
            # are the same object, we might run into an infinite loop.
            for a in cast(ArrayObject, deepcopy(page2[PG.ANNOTS])):
                a = a.get_object()
                aa = a.clone(
                    pdf,
                    ignore_fields=("/P", "/StructParent", "/Parent"),
                    force_duplicate=True,
                )
                r = cast(ArrayObject, a["/Rect"])
                pt1 = trsf.apply_on((r[0], r[1]), True)
                pt2 = trsf.apply_on((r[2], r[3]), True)
                aa[NameObject("/Rect")] = ArrayObject(
                    (
                        min(pt1[0], pt2[0]),
                        min(pt1[1], pt2[1]),
                        max(pt1[0], pt2[0]),
                        max(pt1[1], pt2[1]),
                    )
                )
                if "/QuadPoints" in a:
                    q = cast(ArrayObject, a["/QuadPoints"])
                    aa[NameObject("/QuadPoints")] = ArrayObject(
                        trsf.apply_on((q[0], q[1]), True)
                        + trsf.apply_on((q[2], q[3]), True)
                        + trsf.apply_on((q[4], q[5]), True)
                        + trsf.apply_on((q[6], q[7]), True)
                    )
                try:
                    aa["/Popup"][NameObject("/Parent")] = aa.indirect_reference
                except KeyError:
                    pass
                try:
                    aa[NameObject("/P")] = self.indirect_reference
                    annots.append(aa.indirect_reference)
                except AttributeError:
                    pass

        new_content_array = ArrayObject()
        original_content = self.get_contents()
        if original_content is not None:
            original_content.isolate_graphics_state()
            new_content_array.append(original_content)

        page2content = page2.get_contents()
        if page2content is not None:
            rect = getattr(page2, MERGE_CROP_BOX)
            page2content.operations.insert(
                0,
                (
                    map(
                        FloatObject,
                        [
                            rect.left,
                            rect.bottom,
                            rect.width,
                            rect.height,
                        ],
                    ),
                    b"re",
                ),
            )
            page2content.operations.insert(1, ([], b"W"))
            page2content.operations.insert(2, ([], b"n"))
            if page2transformation is not None:
                page2content = page2transformation(page2content)
            page2content = PageObject._content_stream_rename(
                page2content, rename, self.pdf
            )
            page2content.isolate_graphics_state()
            if over:
                new_content_array.append(page2content)
            else:
                new_content_array.insert(0, page2content)

        # if expanding the page to fit a new page, calculate the new media box size
        if expand:
            self._expand_mediabox(page2, ctm)

        self.replace_contents(new_content_array)

    def _expand_mediabox(
        self, page2: "PageObject", ctm: Optional[CompressedTransformationMatrix]
    ) -> None:
        corners1 = (
            self.mediabox.left.as_numeric(),
            self.mediabox.bottom.as_numeric(),
            self.mediabox.right.as_numeric(),
            self.mediabox.top.as_numeric(),
        )
        corners2 = (
            page2.mediabox.left.as_numeric(),
            page2.mediabox.bottom.as_numeric(),
            page2.mediabox.left.as_numeric(),
            page2.mediabox.top.as_numeric(),
            page2.mediabox.right.as_numeric(),
            page2.mediabox.top.as_numeric(),
            page2.mediabox.right.as_numeric(),
            page2.mediabox.bottom.as_numeric(),
        )
        if ctm is not None:
            ctm = tuple(float(x) for x in ctm)  # type: ignore[assignment]
            new_x = tuple(
                ctm[0] * corners2[i] + ctm[2] * corners2[i + 1] + ctm[4]
                for i in range(0, 8, 2)
            )
            new_y = tuple(
                ctm[1] * corners2[i] + ctm[3] * corners2[i + 1] + ctm[5]
                for i in range(0, 8, 2)
            )
        else:
            new_x = corners2[0:8:2]
            new_y = corners2[1:8:2]
        lowerleft = (min(new_x), min(new_y))
        upperright = (max(new_x), max(new_y))
        lowerleft = (min(corners1[0], lowerleft[0]), min(corners1[1], lowerleft[1]))
        upperright = (
            max(corners1[2], upperright[0]),
            max(corners1[3], upperright[1]),
        )

        self.mediabox.lower_left = lowerleft
        self.mediabox.upper_right = upperright

    def merge_transformed_page(
        self,
        page2: "PageObject",
        ctm: Union[CompressedTransformationMatrix, Transformation],
        over: bool = True,
        expand: bool = False,
    ) -> None:
        """
        Similar to :meth:`~pypdf._page.PageObject.merge_page`, but a transformation
        matrix is applied to the merged stream.

        Args:
          page2: The page to be merged into this one.
          ctm: a 6-element tuple containing the operands of the
                 transformation matrix
          over: set the page2 content over page1 if True (default) else under
          expand: Whether the page should be expanded to fit the dimensions
            of the page to be merged.

        """
        if isinstance(ctm, Transformation):
            ctm = ctm.ctm
        self._merge_page(
            page2,
            lambda page2_content: PageObject._add_transformation_matrix(
                page2_content, page2.pdf, ctm
            ),
            ctm,
            over,
            expand,
        )

    def merge_scaled_page(
        self, page2: "PageObject", scale: float, over: bool = True, expand: bool = False
    ) -> None:
        """
        Similar to :meth:`~pypdf._page.PageObject.merge_page`, but the stream to be merged
        is scaled by applying a transformation matrix.

        Args:
          page2: The page to be merged into this one.
          scale: The scaling factor
          over: set the page2 content over page1 if True (default) else under
          expand: Whether the page should be expanded to fit the
            dimensions of the page to be merged.

        """
        op = Transformation().scale(scale, scale)
        self.merge_transformed_page(page2, op, over, expand)

    def merge_rotated_page(
        self,
        page2: "PageObject",
        rotation: float,
        over: bool = True,
        expand: bool = False,
    ) -> None:
        """
        Similar to :meth:`~pypdf._page.PageObject.merge_page`, but the stream to be merged
        is rotated by applying a transformation matrix.

        Args:
          page2: The page to be merged into this one.
          rotation: The angle of the rotation, in degrees
          over: set the page2 content over page1 if True (default) else under
          expand: Whether the page should be expanded to fit the
            dimensions of the page to be merged.

        """
        op = Transformation().rotate(rotation)
        self.merge_transformed_page(page2, op, over, expand)

    def merge_translated_page(
        self,
        page2: "PageObject",
        tx: float,
        ty: float,
        over: bool = True,
        expand: bool = False,
    ) -> None:
        """
        Similar to :meth:`~pypdf._page.PageObject.merge_page`, but the stream to be
        merged is translated by applying a transformation matrix.

        Args:
          page2: the page to be merged into this one.
          tx: The translation on X axis
          ty: The translation on Y axis
          over: set the page2 content over page1 if True (default) else under
          expand: Whether the page should be expanded to fit the
            dimensions of the page to be merged.

        """
        op = Transformation().translate(tx, ty)
        self.merge_transformed_page(page2, op, over, expand)

    def add_transformation(
        self,
        ctm: Union[Transformation, CompressedTransformationMatrix],
        expand: bool = False,
    ) -> None:
        """
        Apply a transformation matrix to the page.

        Args:
            ctm: A 6-element tuple containing the operands of the
                transformation matrix. Alternatively, a
                :py:class:`Transformation<pypdf.Transformation>`
                object can be passed.

        See :doc:`/user/cropping-and-transforming`.

        """
        if isinstance(ctm, Transformation):
            ctm = ctm.ctm
        content = self.get_contents()
        if content is not None:
            content = PageObject._add_transformation_matrix(content, self.pdf, ctm)
            content.isolate_graphics_state()
            self.replace_contents(content)
        # if expanding the page to fit a new page, calculate the new media box size
        if expand:
            corners = [
                self.mediabox.left.as_numeric(),
                self.mediabox.bottom.as_numeric(),
                self.mediabox.left.as_numeric(),
                self.mediabox.top.as_numeric(),
                self.mediabox.right.as_numeric(),
                self.mediabox.top.as_numeric(),
                self.mediabox.right.as_numeric(),
                self.mediabox.bottom.as_numeric(),
            ]

            ctm = tuple(float(x) for x in ctm)  # type: ignore[assignment]
            new_x = [
                ctm[0] * corners[i] + ctm[2] * corners[i + 1] + ctm[4]
                for i in range(0, 8, 2)
            ]
            new_y = [
                ctm[1] * corners[i] + ctm[3] * corners[i + 1] + ctm[5]
                for i in range(0, 8, 2)
            ]

            self.mediabox.lower_left = (min(new_x), min(new_y))
            self.mediabox.upper_right = (max(new_x), max(new_y))

    def scale(self, sx: float, sy: float) -> None:
        """
        Scale a page by the given factors by applying a transformation matrix
        to its content and updating the page size.

        This updates the various page boundaries (bleedbox, trimbox, etc.)
        and the contents of the page.

        Args:
            sx: The scaling factor on horizontal axis.
            sy: The scaling factor on vertical axis.

        """
        self.add_transformation((sx, 0, 0, sy, 0, 0))
        self.bleedbox = self.bleedbox.scale(sx, sy)
        self.trimbox = self.trimbox.scale(sx, sy)
        self.artbox = self.artbox.scale(sx, sy)
        self.cropbox = self.cropbox.scale(sx, sy)
        self.mediabox = self.mediabox.scale(sx, sy)

        if PG.ANNOTS in self:
            annotations = self[PG.ANNOTS]
            if isinstance(annotations, ArrayObject):
                for annotation in annotations:
                    annotation_obj = annotation.get_object()
                    if ADA.Rect in annotation_obj:
                        rectangle = annotation_obj[ADA.Rect]
                        if isinstance(rectangle, ArrayObject):
                            rectangle[0] = FloatObject(float(rectangle[0]) * sx)
                            rectangle[1] = FloatObject(float(rectangle[1]) * sy)
                            rectangle[2] = FloatObject(float(rectangle[2]) * sx)
                            rectangle[3] = FloatObject(float(rectangle[3]) * sy)

        if PG.VP in self:
            viewport = self[PG.VP]
            if isinstance(viewport, ArrayObject):
                bbox = viewport[0]["/BBox"]
            else:
                bbox = viewport["/BBox"]  # type: ignore
            scaled_bbox = RectangleObject(
                (
                    float(bbox[0]) * sx,
                    float(bbox[1]) * sy,
                    float(bbox[2]) * sx,
                    float(bbox[3]) * sy,
                )
            )
            if isinstance(viewport, ArrayObject):
                self[NameObject(PG.VP)][NumberObject(0)][  # type: ignore
                    NameObject("/BBox")
                ] = scaled_bbox
            else:
                self[NameObject(PG.VP)][NameObject("/BBox")] = scaled_bbox  # type: ignore

    def scale_by(self, factor: float) -> None:
        """
        Scale a page by the given factor by applying a transformation matrix to
        its content and updating the page size.

        Args:
            factor: The scaling factor (for both X and Y axis).

        """
        self.scale(factor, factor)

    def scale_to(self, width: float, height: float) -> None:
        """
        Scale a page to the specified dimensions by applying a transformation
        matrix to its content and updating the page size.

        Args:
            width: The new width.
            height: The new height.

        """
        sx = width / float(self.mediabox.width)
        sy = height / float(self.mediabox.height)
        self.scale(sx, sy)

    def compress_content_streams(self, level: int = -1) -> None:
        """
        Compress the size of this page by joining all content streams and
        applying a FlateDecode filter.

        However, it is possible that this function will perform no action if
        content stream compression becomes "automatic".
        """
        content = self.get_contents()
        if content is not None:
            content_obj = content.flate_encode(level)
            try:
                content.indirect_reference.pdf._objects[  # type: ignore
                    content.indirect_reference.idnum - 1  # type: ignore
                ] = content_obj
            except AttributeError:
                if self.indirect_reference is not None and hasattr(
                    self.indirect_reference.pdf, "_add_object"
                ):
                    self.replace_contents(content_obj)
                else:
                    raise ValueError("Page must be part of a PdfWriter")

    @property
    def page_number(self) -> Optional[int]:
        """
        Read-only property which returns the page number within the PDF file.

        Returns:
            Page number; None if the page is not attached to a PDF.

        """
        if self.indirect_reference is None:
            return None
        try:
            lst = self.indirect_reference.pdf.pages
            return lst.index(self)
        except ValueError:
            return None

    def _debug_for_extract(self) -> str:  # pragma: no cover
        out = ""
        for ope, op in ContentStream(
            self["/Contents"].get_object(), self.pdf, "bytes"
        ).operations:
            if op == b"TJ":
                s = [x for x in ope[0] if isinstance(x, str)]
            else:
                s = []
            out += op.decode("utf-8") + " " + "".join(s) + ope.__repr__() + "\n"
        out += "\n=============================\n"
        try:
            for fo in self[PG.RESOURCES]["/Font"]:  # type:ignore
                out += fo + "\n"
                out += self[PG.RESOURCES]["/Font"][fo].__repr__() + "\n"  # type:ignore
                try:
                    enc_repr = self[PG.RESOURCES]["/Font"][fo][  # type:ignore
                        "/Encoding"
                    ].__repr__()
                    out += enc_repr + "\n"
                except Exception:
                    pass
                try:
                    out += (
                        self[PG.RESOURCES]["/Font"][fo][  # type:ignore
                            "/ToUnicode"
                        ]
                        .get_data()
                        .decode()
                        + "\n"
                    )
                except Exception:
                    pass

        except KeyError:
            out += "No Font\n"
        return out

    def _extract_text(
        self,
        obj: Any,
        pdf: Any,
        orientations: tuple[int, ...] = (0, 90, 180, 270),
        space_width: float = 200.0,
        content_key: Optional[str] = PG.CONTENTS,
        visitor_operand_before: Optional[Callable[[Any, Any, Any, Any], None]] = None,
        visitor_operand_after: Optional[Callable[[Any, Any, Any, Any], None]] = None,
        visitor_text: Optional[Callable[[Any, Any, Any, Any, Any], None]] = None,
    ) -> str:
        """
        See extract_text for most arguments.

        Args:
            content_key: indicate the default key where to extract data
                None = the object; this allows reusing the function on an XObject
                default = "/Content"

        """
        extractor = TextExtraction()
        font_resources: dict[str, DictionaryObject] = {}
        fonts: dict[str, Font] = {}

        try:
            objr = obj
            while NameObject(PG.RESOURCES) not in objr:
                # /Resources can be inherited so we look to parents
                objr = objr["/Parent"].get_object()
                # If no parents then no /Resources will be available,
                # so an exception will be raised
            resources_dict = cast(DictionaryObject, objr[PG.RESOURCES])
        except Exception:
            # No resources means no text is possible (no font); we consider the
            # file as not damaged, no need to check for TJ or Tj
            return ""

        if (
            not is_null_or_none(resources_dict)
            and "/Font" in resources_dict
            and (font_resources_dict := cast(DictionaryObject, resources_dict["/Font"]))
        ):
            for font_resource in font_resources_dict:
                try:
                    font_resource_object = cast(DictionaryObject, font_resources_dict[font_resource].get_object())
                    font_resources[font_resource] = font_resource_object
                    fonts[font_resource] = Font.from_font_resource(font_resource_object)
                    # Override space width, if applicable
                    if fonts[font_resource].character_widths.get(" ", 0) == 0:
                        fonts[font_resource].space_width = space_width
                except (AttributeError, TypeError):
                    pass

        try:
            content = (
                obj[content_key].get_object() if isinstance(content_key, str) else obj
            )
            if not isinstance(content, ContentStream):
                content = ContentStream(content, pdf, "bytes")
        except (AttributeError, KeyError):  # no content can be extracted (certainly empty page)
            return ""
        # We check all strings are TextStringObjects. ByteStringObjects
        # are strings where the byte->string encoding was unknown, so adding
        # them to the text here would be gibberish.

        # Initialize the extractor with the necessary parameters
        extractor.initialize_extraction(orientations, visitor_text, font_resources, fonts)

        for operands, operator in content.operations:
            if visitor_operand_before is not None:
                visitor_operand_before(operator, operands, extractor.cm_matrix, extractor.tm_matrix)
            # Multiple operators are handled here
            if operator == b"'":
                extractor.process_operation(b"T*", [])
                extractor.process_operation(b"Tj", operands)
            elif operator == b'"':
                extractor.process_operation(b"Tw", [operands[0]])
                extractor.process_operation(b"Tc", [operands[1]])
                extractor.process_operation(b"T*", [])
                extractor.process_operation(b"Tj", operands[2:])
            elif operator == b"TJ":
                # The space width may be smaller than the font width, so the width should be 95%.
                _confirm_space_width = extractor._space_width * 0.95
                if operands:
                    for op in operands[0]:
                        if isinstance(op, (str, bytes)):
                            extractor.process_operation(b"Tj", [op])
                        if isinstance(op, (int, float, NumberObject, FloatObject)) and (
                            abs(float(op)) >= _confirm_space_width
                            and extractor.text
                            and extractor.text[-1] != " "
                        ):
                            extractor.process_operation(b"Tj", [" "])
            elif operator == b"TD":
                extractor.process_operation(b"TL", [-operands[1]])
                extractor.process_operation(b"Td", operands)
            elif operator == b"Do":
                extractor.output += extractor.text
                if visitor_text is not None:
                    visitor_text(
                        extractor.text,
                        extractor.memo_cm,
                        extractor.memo_tm,
                        extractor.font_resource,
                        extractor.font_size,
                    )
                try:
                    if extractor.output[-1] != "\n":
                        extractor.output += "\n"
                        if visitor_text is not None:
                            visitor_text(
                                "\n",
                                extractor.memo_cm,
                                extractor.memo_tm,
                                extractor.font_resource,
                                extractor.font_size,
                            )
                except IndexError:
                    pass
                try:
                    xobj = resources_dict["/XObject"]
                    if xobj[operands[0]]["/Subtype"] != "/Image":  # type: ignore
                        text = self.extract_xform_text(
                            xobj[operands[0]],  # type: ignore
                            orientations,
                            space_width,
                            visitor_operand_before,
                            visitor_operand_after,
                            visitor_text,
                        )
                        extractor.output += text
                        if visitor_text is not None:
                            visitor_text(
                                text,
                                extractor.memo_cm,
                                extractor.memo_tm,
                                extractor.font_resource,
                                extractor.font_size,
                            )
                except Exception as exception:
                    logger_warning(
                        f"Impossible to decode XFormObject {operands[0]}: {exception}",
                        __name__,
                    )
                finally:
                    extractor.text = ""
                    extractor.memo_cm = extractor.cm_matrix.copy()
                    extractor.memo_tm = extractor.tm_matrix.copy()
            else:
                extractor.process_operation(operator, operands)
            if visitor_operand_after is not None:
                visitor_operand_after(operator, operands, extractor.cm_matrix, extractor.tm_matrix)
        extractor.output += extractor.text  # just in case
        if extractor.text != "" and visitor_text is not None:
            visitor_text(
                extractor.text,
                extractor.memo_cm,
                extractor.memo_tm,
                extractor.font_resource,
                extractor.font_size,
            )
        return extractor.output

    def _layout_mode_fonts(self) -> dict[str, Font]:
        """
        Get fonts formatted for "layout" mode text extraction.

        Returns:
            Dict[str, Font]: dictionary of Font instances keyed by font name

        """
        # Font retrieval logic adapted from pypdf.PageObject._extract_text()
        objr: Any = self
        fonts: dict[str, Font] = {}
        while objr is not None:
            try:
                resources_dict: Any = objr[PG.RESOURCES]
            except KeyError:
                resources_dict = {}
            if "/Font" in resources_dict and self.pdf is not None:
                for font_name in resources_dict["/Font"]:
                    fonts[font_name] = Font.from_font_resource(resources_dict["/Font"][font_name])
            try:
                objr = objr["/Parent"].get_object()
            except KeyError:
                objr = None

        return fonts

    def _layout_mode_text(
        self,
        space_vertically: bool = True,
        scale_weight: float = 1.25,
        strip_rotated: bool = True,
        debug_path: Optional[Path] = None,
        font_height_weight: float = 1,
    ) -> str:
        """
        Get text preserving fidelity to source PDF text layout.

        Args:
            space_vertically: include blank lines inferred from y distance + font
                height. Defaults to True.
            scale_weight: multiplier for string length when calculating weighted
                average character width. Defaults to 1.25.
            strip_rotated: Removes text that is rotated w.r.t. to the page from
                layout mode output. Defaults to True.
            debug_path (Path | None): if supplied, must target a directory.
                creates the following files with debug information for layout mode
                functions if supplied:
                  - fonts.json: output of self._layout_mode_fonts
                  - tjs.json: individual text render ops with corresponding transform matrices
                  - bts.json: text render ops left justified and grouped by BT/ET operators
                  - bt_groups.json: BT/ET operations grouped by rendered y-coord (aka lines)
                Defaults to None.
            font_height_weight: multiplier for font height when calculating
                blank lines. Defaults to 1.

        Returns:
            str: multiline string containing page text in a fixed width format that
                closely adheres to the rendered layout in the source pdf.

        """
        fonts = self._layout_mode_fonts()
        if debug_path:  # pragma: no cover
            import json  # noqa: PLC0415

            debug_path.joinpath("fonts.json").write_text(
                json.dumps(fonts, indent=2, default=asdict),
                "utf-8"
            )

        ops = iter(
            ContentStream(self["/Contents"].get_object(), self.pdf, "bytes").operations
        )
        bt_groups = _layout_mode.text_show_operations(
            ops, fonts, strip_rotated, debug_path
        )

        if not bt_groups:
            return ""

        ty_groups = _layout_mode.y_coordinate_groups(bt_groups, debug_path)

        char_width = _layout_mode.fixed_char_width(bt_groups, scale_weight)

        return _layout_mode.fixed_width_page(ty_groups, char_width, space_vertically, font_height_weight)

    def extract_text(
        self,
        *args: Any,
        orientations: Union[int, tuple[int, ...]] = (0, 90, 180, 270),
        space_width: float = 200.0,
        visitor_operand_before: Optional[Callable[[Any, Any, Any, Any], None]] = None,
        visitor_operand_after: Optional[Callable[[Any, Any, Any, Any], None]] = None,
        visitor_text: Optional[Callable[[Any, Any, Any, Any, Any], None]] = None,
        extraction_mode: Literal["plain", "layout"] = "plain",
        **kwargs: Any,
    ) -> str:
        """
        Locate all text drawing commands, in the order they are provided in the
        content stream, and extract the text.

        This works well for some PDF files, but poorly for others, depending on
        the generator used. This will be refined in the future.

        Do not rely on the order of text coming out of this function, as it
        will change if this function is made more sophisticated.

        Arabic and Hebrew are extracted in the correct order.
        If required a custom RTL range of characters can be defined;
        see function set_custom_rtl.

        Additionally you can provide visitor methods to get informed on all
        operations and all text objects.
        For example in some PDF files this can be useful to parse tables.

        Args:
            orientations: list of orientations extract_text will look for
                default = (0, 90, 180, 270)
                note: currently only 0 (up),90 (turned left), 180 (upside down),
                270 (turned right)
                Silently ignored in "layout" mode.
            space_width: force default space width
                if not extracted from font (default: 200)
                Silently ignored in "layout" mode.
            visitor_operand_before: function to be called before processing an operation.
                It has four arguments: operator, operand-arguments,
                current transformation matrix and text matrix.
                Ignored with a warning in "layout" mode.
            visitor_operand_after: function to be called after processing an operation.
                It has four arguments: operator, operand-arguments,
                current transformation matrix and text matrix.
                Ignored with a warning in "layout" mode.
            visitor_text: function to be called when extracting some text at some position.
                It has five arguments: text, current transformation matrix,
                text matrix, font-dictionary and font-size.
                The font-dictionary may be None in case of unknown fonts.
                If not None it may e.g. contain key "/BaseFont" with value "/Arial,Bold".
                Ignored with a warning in "layout" mode.
            extraction_mode (Literal["plain", "layout"]): "plain" for legacy functionality,
                "layout" for experimental layout mode functionality.
                NOTE: orientations, space_width, and visitor_* parameters are NOT respected
                in "layout" mode.

        kwargs:
            layout_mode_space_vertically (bool): include blank lines inferred from
                y distance + font height. Defaults to True.
            layout_mode_scale_weight (float): multiplier for string length when calculating
                weighted average character width. Defaults to 1.25.
            layout_mode_strip_rotated (bool): layout mode does not support rotated text.
                Set to False to include rotated text anyway. If rotated text is discovered,
                layout will be degraded and a warning will result. Defaults to True.
            layout_mode_debug_path (Path | None): if supplied, must target a directory.
                creates the following files with debug information for layout mode
                functions if supplied:

                  - fonts.json: output of self._layout_mode_fonts
                  - tjs.json: individual text render ops with corresponding transform matrices
                  - bts.json: text render ops left justified and grouped by BT/ET operators
                  - bt_groups.json: BT/ET operations grouped by rendered y-coord (aka lines)
            layout_mode_font_height_weight (float): multiplier for font height when calculating
                blank lines. Defaults to 1.

        Returns:
            The extracted text

        """
        if extraction_mode not in ["plain", "layout"]:
            raise ValueError(f"Invalid text extraction mode '{extraction_mode}'")
        if extraction_mode == "layout":
            for visitor in (
                "visitor_operand_before",
                "visitor_operand_after",
                "visitor_text",
            ):
                if locals()[visitor]:
                    logger_warning(
                        f"Argument {visitor} is ignored in layout mode",
                        __name__,
                    )
            return self._layout_mode_text(
                space_vertically=kwargs.get("layout_mode_space_vertically", True),
                scale_weight=kwargs.get("layout_mode_scale_weight", 1.25),
                strip_rotated=kwargs.get("layout_mode_strip_rotated", True),
                debug_path=kwargs.get("layout_mode_debug_path"),
                font_height_weight=kwargs.get("layout_mode_font_height_weight", 1)
            )
        if len(args) >= 1:
            if isinstance(args[0], str):
                if len(args) >= 3:
                    if isinstance(args[2], (tuple, int)):
                        orientations = args[2]
                    else:
                        raise TypeError(f"Invalid positional parameter {args[2]}")
                if len(args) >= 4:
                    if isinstance(args[3], (float, int)):
                        space_width = args[3]
                    else:
                        raise TypeError(f"Invalid positional parameter {args[3]}")
            elif isinstance(args[0], (tuple, int)):
                orientations = args[0]
                if len(args) >= 2:
                    if isinstance(args[1], (float, int)):
                        space_width = args[1]
                    else:
                        raise TypeError(f"Invalid positional parameter {args[1]}")
            else:
                raise TypeError(f"Invalid positional parameter {args[0]}")

        if isinstance(orientations, int):
            orientations = (orientations,)

        return self._extract_text(
            self,
            self.pdf,
            orientations,
            space_width,
            PG.CONTENTS,
            visitor_operand_before,
            visitor_operand_after,
            visitor_text,
        )

    def extract_xform_text(
        self,
        xform: EncodedStreamObject,
        orientations: tuple[int, ...] = (0, 90, 270, 360),
        space_width: float = 200.0,
        visitor_operand_before: Optional[Callable[[Any, Any, Any, Any], None]] = None,
        visitor_operand_after: Optional[Callable[[Any, Any, Any, Any], None]] = None,
        visitor_text: Optional[Callable[[Any, Any, Any, Any, Any], None]] = None,
    ) -> str:
        """
        Extract text from an XObject.

        Args:
            xform:
            orientations:
            space_width:  force default space width (if not extracted from font (default 200)
            visitor_operand_before:
            visitor_operand_after:
            visitor_text:

        Returns:
            The extracted text

        """
        return self._extract_text(
            xform,
            self.pdf,
            orientations,
            space_width,
            None,
            visitor_operand_before,
            visitor_operand_after,
            visitor_text,
        )

    def _get_fonts(self) -> tuple[set[str], set[str]]:
        """
        Get the names of embedded fonts and unembedded fonts.

        Returns:
            A tuple (set of embedded fonts, set of unembedded fonts)

        """
        obj = self.get_object()
        assert isinstance(obj, DictionaryObject)
        fonts: set[str] = set()
        embedded: set[str] = set()
        fonts, embedded = _get_fonts_walk(obj, fonts, embedded)
        unembedded = fonts - embedded
        return embedded, unembedded

    mediabox = _create_rectangle_accessor(PG.MEDIABOX, ())
    """A :class:`RectangleObject<pypdf.generic.RectangleObject>`, expressed in
    default user space units, defining the boundaries of the physical medium on
    which the page is intended to be displayed or printed."""

    cropbox = _create_rectangle_accessor("/CropBox", (PG.MEDIABOX,))
    """
    A :class:`RectangleObject<pypdf.generic.RectangleObject>`, expressed in
    default user space units, defining the visible region of default user
    space.

    When the page is displayed or printed, its contents are to be clipped
    (cropped) to this rectangle and then imposed on the output medium in some
    implementation-defined manner. Default value: same as
    :attr:`mediabox<mediabox>`.
    """

    bleedbox = _create_rectangle_accessor("/BleedBox", ("/CropBox", PG.MEDIABOX))
    """A :class:`RectangleObject<pypdf.generic.RectangleObject>`, expressed in
    default user space units, defining the region to which the contents of the
    page should be clipped when output in a production environment."""

    trimbox = _create_rectangle_accessor("/TrimBox", ("/CropBox", PG.MEDIABOX))
    """A :class:`RectangleObject<pypdf.generic.RectangleObject>`, expressed in
    default user space units, defining the intended dimensions of the finished
    page after trimming."""

    artbox = _create_rectangle_accessor("/ArtBox", ("/CropBox", PG.MEDIABOX))
    """A :class:`RectangleObject<pypdf.generic.RectangleObject>`, expressed in
    default user space units, defining the extent of the page's meaningful
    content as intended by the page's creator."""

    @property
    def annotations(self) -> Optional[ArrayObject]:
        if "/Annots" not in self:
            return None
        return cast(ArrayObject, self["/Annots"])

    @annotations.setter
    def annotations(self, value: Optional[ArrayObject]) -> None:
        """
        Set the annotations array of the page.

        Typically you do not want to set this value, but append to it.
        If you append to it, remember to add the object first to the writer
        and only add the indirect object.
        """
        if value is None:
            if "/Annots" not in self:
                return
            del self[NameObject("/Annots")]
        else:
            self[NameObject("/Annots")] = value


class _VirtualList(Sequence[PageObject]):
    def __init__(
        self,
        length_function: Callable[[], int],
        get_function: Callable[[int], PageObject],
    ) -> None:
        self.length_function = length_function
        self.get_function = get_function
        self.current = -1

    def __len__(self) -> int:
        return self.length_function()

    @overload
    def __getitem__(self, index: int) -> PageObject:
        ...

    @overload
    def __getitem__(self, index: slice) -> Sequence[PageObject]:
        ...

    def __getitem__(
        self, index: Union[int, slice]
    ) -> Union[PageObject, Sequence[PageObject]]:
        if isinstance(index, slice):
            indices = range(*index.indices(len(self)))
            cls = type(self)
            return cls(indices.__len__, lambda idx: self[indices[idx]])
        if not isinstance(index, int):
            raise TypeError("Sequence indices must be integers")
        len_self = len(self)
        if index < 0:
            # support negative indexes
            index += len_self
        if not (0 <= index < len_self):
            raise IndexError("Sequence index out of range")
        return self.get_function(index)

    def __delitem__(self, index: Union[int, slice]) -> None:
        if isinstance(index, slice):
            r = list(range(*index.indices(len(self))))
            # pages have to be deleted from last to first
            r.sort()
            r.reverse()
            for p in r:
                del self[p]  # recursive call
            return
        if not isinstance(index, int):
            raise TypeError("Index must be integers")
        len_self = len(self)
        if index < 0:
            # support negative indexes
            index += len_self
        if not (0 <= index < len_self):
            raise IndexError("Index out of range")
        ind = self[index].indirect_reference
        assert ind is not None
        parent: Optional[PdfObject] = cast(DictionaryObject, ind.get_object()).get(
            "/Parent", None
        )
        first = True
        while parent is not None:
            parent = cast(DictionaryObject, parent.get_object())
            try:
                i = cast(ArrayObject, parent["/Kids"]).index(ind)
                del cast(ArrayObject, parent["/Kids"])[i]
                first = False
                try:
                    assert ind is not None
                    del ind.pdf.flattened_pages[index]  # case of page in a Reader
                except Exception:  # pragma: no cover
                    pass
                if "/Count" in parent:
                    parent[NameObject("/Count")] = NumberObject(
                        cast(int, parent["/Count"]) - 1
                    )
                if len(cast(ArrayObject, parent["/Kids"])) == 0:
                    # No more objects in this part of this subtree
                    ind = parent.indirect_reference
                parent = parent.get("/Parent", None)
            except ValueError:  # from index
                if first:
                    raise PdfReadError(f"Page not found in page tree: {ind}")
                break

    def __iter__(self) -> Iterator[PageObject]:
        for i in range(len(self)):
            yield self[i]

    def __str__(self) -> str:
        p = [f"PageObject({i})" for i in range(self.length_function())]
        return f"[{', '.join(p)}]"


def _get_fonts_walk(
    obj: DictionaryObject,
    fnt: set[str],
    emb: set[str],
) -> tuple[set[str], set[str]]:
    """
    Get the set of all fonts and all embedded fonts.

    Args:
        obj: Page resources dictionary
        fnt: font
        emb: embedded fonts

    Returns:
        A tuple (fnt, emb)

    If there is a key called 'BaseFont', that is a font that is used in the document.
    If there is a key called 'FontName' and another key in the same dictionary object
    that is called 'FontFilex' (where x is null, 2, or 3), then that fontname is
    embedded.

    We create and add to two sets, fnt = fonts used and emb = fonts embedded.

    """
    fontkeys = ("/FontFile", "/FontFile2", "/FontFile3")

    def process_font(f: DictionaryObject) -> None:
        nonlocal fnt, emb
        f = cast(DictionaryObject, f.get_object())  # to be sure
        if "/BaseFont" in f:
            fnt.add(cast(str, f["/BaseFont"]))

        if (
            ("/CharProcs" in f)
            or (
                "/FontDescriptor" in f
                and any(
                    x in cast(DictionaryObject, f["/FontDescriptor"]) for x in fontkeys
                )
            )
            or (
                "/DescendantFonts" in f
                and "/FontDescriptor"
                in cast(
                    DictionaryObject,
                    cast(ArrayObject, f["/DescendantFonts"])[0].get_object(),
                )
                and any(
                    x
                    in cast(
                        DictionaryObject,
                        cast(
                            DictionaryObject,
                            cast(ArrayObject, f["/DescendantFonts"])[0].get_object(),
                        )["/FontDescriptor"],
                    )
                    for x in fontkeys
                )
            )
        ):
            # the list comprehension ensures there is FontFile
            try:
                emb.add(cast(str, f["/BaseFont"]))
            except KeyError:
                emb.add("(" + cast(str, f["/Subtype"]) + ")")

    if "/DR" in obj and "/Font" in cast(DictionaryObject, obj["/DR"]):
        for f in cast(DictionaryObject, cast(DictionaryObject, obj["/DR"])["/Font"]):
            process_font(f)
    if "/Resources" in obj:
        if "/Font" in cast(DictionaryObject, obj["/Resources"]):
            for f in cast(
                DictionaryObject, cast(DictionaryObject, obj["/Resources"])["/Font"]
            ).values():
                process_font(f)
        if "/XObject" in cast(DictionaryObject, obj["/Resources"]):
            for x in cast(
                DictionaryObject, cast(DictionaryObject, obj["/Resources"])["/XObject"]
            ).values():
                _get_fonts_walk(cast(DictionaryObject, x.get_object()), fnt, emb)
    if "/Annots" in obj:
        for a in cast(ArrayObject, obj["/Annots"]):
            _get_fonts_walk(cast(DictionaryObject, a.get_object()), fnt, emb)
    if "/AP" in obj:
        if (
            cast(DictionaryObject, cast(DictionaryObject, obj["/AP"])["/N"]).get(
                "/Type"
            )
            == "/XObject"
        ):
            _get_fonts_walk(
                cast(DictionaryObject, cast(DictionaryObject, obj["/AP"])["/N"]),
                fnt,
                emb,
            )
        else:
            for a in cast(DictionaryObject, cast(DictionaryObject, obj["/AP"])["/N"]):
                _get_fonts_walk(cast(DictionaryObject, a), fnt, emb)
    return fnt, emb  # return the sets for each page
