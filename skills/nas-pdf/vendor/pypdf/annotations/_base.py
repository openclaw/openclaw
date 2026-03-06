from abc import ABC

from ..constants import AnnotationFlag
from ..generic import NameObject, NumberObject
from ..generic._data_structures import DictionaryObject


class AnnotationDictionary(DictionaryObject, ABC):
    def __init__(self) -> None:
        super().__init__()

        from ..generic._base import NameObject  # noqa: PLC0415

        # /Rect should not be added here as Polygon and PolyLine can automatically set it
        self[NameObject("/Type")] = NameObject("/Annot")
        # The flags were NOT added to the constructor on purpose:
        # We expect that most users don't want to change the default.
        # If they do, they can use the property. The default is 0.

    @property
    def flags(self) -> AnnotationFlag:
        return self.get(NameObject("/F"), AnnotationFlag(0))

    @flags.setter
    def flags(self, value: AnnotationFlag) -> None:
        self[NameObject("/F")] = NumberObject(value)


NO_FLAGS = AnnotationFlag(0)
