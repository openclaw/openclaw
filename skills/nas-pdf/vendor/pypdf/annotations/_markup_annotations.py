import sys
from abc import ABC
from typing import Any, Optional, Union

from ..constants import AnnotationFlag
from ..generic import ArrayObject, DictionaryObject
from ..generic._base import (
    BooleanObject,
    FloatObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from ..generic._rectangle import RectangleObject
from ..generic._utils import hex_to_rgb
from ._base import NO_FLAGS, AnnotationDictionary

if sys.version_info[:2] >= (3, 10):
    from typing import TypeAlias
else:
    # PEP 613 introduced typing.TypeAlias with Python 3.10
    # For older Python versions, the backport typing_extensions is necessary:
    from typing_extensions import TypeAlias


Vertex: TypeAlias = tuple[float, float]


def _get_bounding_rectangle(vertices: list[Vertex]) -> RectangleObject:
    x_min, y_min = vertices[0][0], vertices[0][1]
    x_max, y_max = vertices[0][0], vertices[0][1]
    for x, y in vertices:
        x_min = min(x_min, x)
        y_min = min(y_min, y)
        x_max = max(x_max, x)
        y_max = max(y_max, y)
    return RectangleObject((x_min, y_min, x_max, y_max))


class MarkupAnnotation(AnnotationDictionary, ABC):
    """
    Base class for all markup annotations.

    Args:
        title_bar: Text to be displayed in the title bar of the annotation;
            by convention this is the name of the author

    """

    def __init__(self, *, title_bar: Optional[str] = None) -> None:
        if title_bar is not None:
            self[NameObject("/T")] = TextStringObject(title_bar)


class Text(MarkupAnnotation):
    """
    A text annotation.

    Args:
        rect: array of four integers ``[xLL, yLL, xUR, yUR]``
            specifying the clickable rectangular area
        text: The text that is added to the document
        open:
        flags:

    """

    def __init__(
        self,
        *,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        text: str,
        open: bool = False,
        flags: int = NO_FLAGS,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self[NameObject("/Subtype")] = NameObject("/Text")
        self[NameObject("/Rect")] = RectangleObject(rect)
        self[NameObject("/Contents")] = TextStringObject(text)
        self[NameObject("/Open")] = BooleanObject(open)
        self[NameObject("/Flags")] = NumberObject(flags)


class FreeText(MarkupAnnotation):
    """A FreeText annotation"""

    def __init__(
        self,
        *,
        text: str,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        font: str = "Helvetica",
        bold: bool = False,
        italic: bool = False,
        font_size: str = "14pt",
        font_color: str = "000000",
        border_color: Optional[str] = "000000",
        background_color: Optional[str] = "ffffff",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self[NameObject("/Subtype")] = NameObject("/FreeText")
        self[NameObject("/Rect")] = RectangleObject(rect)

        # Table 225 of the 1.7 reference ("CSS2 style attributes used in rich text strings")
        font_str = "font: "
        if italic:
            font_str = f"{font_str}italic "
        else:
            font_str = f"{font_str}normal "
        if bold:
            font_str = f"{font_str}bold "
        else:
            font_str = f"{font_str}normal "
        font_str = f"{font_str}{font_size} {font}"
        font_str = f"{font_str};text-align:left;color:#{font_color}"

        default_appearance_string = ""
        if border_color:
            for st in hex_to_rgb(border_color):
                default_appearance_string = f"{default_appearance_string}{st} "
            default_appearance_string = f"{default_appearance_string}rg"

        self.update(
            {
                NameObject("/Subtype"): NameObject("/FreeText"),
                NameObject("/Rect"): RectangleObject(rect),
                NameObject("/Contents"): TextStringObject(text),
                # font size color
                NameObject("/DS"): TextStringObject(font_str),
                NameObject("/DA"): TextStringObject(default_appearance_string),
            }
        )
        if border_color is None:
            # Border Style
            self[NameObject("/BS")] = DictionaryObject(
                {
                    # width of 0 means no border
                    NameObject("/W"): NumberObject(0)
                }
            )
        if background_color is not None:
            self[NameObject("/C")] = ArrayObject(
                [FloatObject(n) for n in hex_to_rgb(background_color)]
            )


class Line(MarkupAnnotation):
    def __init__(
        self,
        p1: Vertex,
        p2: Vertex,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        text: str = "",
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.update(
            {
                NameObject("/Subtype"): NameObject("/Line"),
                NameObject("/Rect"): RectangleObject(rect),
                NameObject("/L"): ArrayObject(
                    [
                        FloatObject(p1[0]),
                        FloatObject(p1[1]),
                        FloatObject(p2[0]),
                        FloatObject(p2[1]),
                    ]
                ),
                NameObject("/LE"): ArrayObject(
                    [
                        NameObject("/None"),
                        NameObject("/None"),
                    ]
                ),
                NameObject("/IC"): ArrayObject(
                    [
                        FloatObject(0.5),
                        FloatObject(0.5),
                        FloatObject(0.5),
                    ]
                ),
                NameObject("/Contents"): TextStringObject(text),
            }
        )


class PolyLine(MarkupAnnotation):
    def __init__(
        self,
        vertices: list[Vertex],
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if len(vertices) == 0:
            raise ValueError("A polyline needs at least 1 vertex with two coordinates")
        coord_list = []
        for x, y in vertices:
            coord_list.append(NumberObject(x))
            coord_list.append(NumberObject(y))
        self.update(
            {
                NameObject("/Subtype"): NameObject("/PolyLine"),
                NameObject("/Vertices"): ArrayObject(coord_list),
                NameObject("/Rect"): RectangleObject(_get_bounding_rectangle(vertices)),
            }
        )


class Rectangle(MarkupAnnotation):
    def __init__(
        self,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        *,
        interior_color: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.update(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Square"),
                NameObject("/Rect"): RectangleObject(rect),
            }
        )

        if interior_color:
            self[NameObject("/IC")] = ArrayObject(
                [FloatObject(n) for n in hex_to_rgb(interior_color)]
            )


class Highlight(MarkupAnnotation):
    def __init__(
        self,
        *,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        quad_points: ArrayObject,
        highlight_color: str = "ff0000",
        printing: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.update(
            {
                NameObject("/Subtype"): NameObject("/Highlight"),
                NameObject("/Rect"): RectangleObject(rect),
                NameObject("/QuadPoints"): quad_points,
                NameObject("/C"): ArrayObject(
                    [FloatObject(n) for n in hex_to_rgb(highlight_color)]
                ),
            }
        )
        if printing:
            self.flags = AnnotationFlag.PRINT


class Ellipse(MarkupAnnotation):
    def __init__(
        self,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        *,
        interior_color: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)

        self.update(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Circle"),
                NameObject("/Rect"): RectangleObject(rect),
            }
        )

        if interior_color:
            self[NameObject("/IC")] = ArrayObject(
                [FloatObject(n) for n in hex_to_rgb(interior_color)]
            )


class Polygon(MarkupAnnotation):
    def __init__(
        self,
        vertices: list[tuple[float, float]],
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if len(vertices) == 0:
            raise ValueError("A polygon needs at least 1 vertex with two coordinates")

        coord_list = []
        for x, y in vertices:
            coord_list.append(NumberObject(x))
            coord_list.append(NumberObject(y))
        self.update(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Polygon"),
                NameObject("/Vertices"): ArrayObject(coord_list),
                NameObject("/IT"): NameObject("/PolygonCloud"),
                NameObject("/Rect"): RectangleObject(_get_bounding_rectangle(vertices)),
            }
        )
