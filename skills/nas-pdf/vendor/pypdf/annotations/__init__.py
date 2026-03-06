"""
PDF specifies several annotation types which pypdf makes available here.

The names of the annotations and their attributes do not reflect the names in
the specification in all cases. For example, the PDF standard defines a
'Square' annotation that does not actually need to be square. For this reason,
pypdf calls it 'Rectangle'.

At their core, all annotation types are DictionaryObjects. That means if pypdf
does not implement a feature, users can easily extend the given functionality.
"""


from ._base import NO_FLAGS, AnnotationDictionary
from ._markup_annotations import (
    Ellipse,
    FreeText,
    Highlight,
    Line,
    MarkupAnnotation,
    Polygon,
    PolyLine,
    Rectangle,
    Text,
)
from ._non_markup_annotations import Link, Popup

__all__ = [
    "NO_FLAGS",
    "AnnotationDictionary",
    "Ellipse",
    "FreeText",
    "Highlight",
    "Line",
    "Link",
    "MarkupAnnotation",
    "PolyLine",
    "Polygon",
    "Popup",
    "Rectangle",
    "Text",
]
