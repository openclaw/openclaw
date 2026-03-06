from typing import Any, Union

from ._base import FloatObject, NumberObject
from ._data_structures import ArrayObject


class RectangleObject(ArrayObject):
    """
    This class is used to represent *page boxes* in pypdf.

    These boxes include:

    * :attr:`artbox <pypdf._page.PageObject.artbox>`
    * :attr:`bleedbox <pypdf._page.PageObject.bleedbox>`
    * :attr:`cropbox <pypdf._page.PageObject.cropbox>`
    * :attr:`mediabox <pypdf._page.PageObject.mediabox>`
    * :attr:`trimbox <pypdf._page.PageObject.trimbox>`
    """

    def __init__(
        self, arr: Union["RectangleObject", tuple[float, float, float, float]]
    ) -> None:
        # must have four points
        assert len(arr) == 4
        # automatically convert arr[x] into NumberObject(arr[x]) if necessary
        ArrayObject.__init__(self, [self._ensure_is_number(x) for x in arr])

    def _ensure_is_number(self, value: Any) -> Union[FloatObject, NumberObject]:
        if not isinstance(value, (FloatObject, NumberObject)):
            value = FloatObject(value)
        return value

    def scale(self, sx: float, sy: float) -> "RectangleObject":
        return RectangleObject(
            (
                float(self.left) * sx,
                float(self.bottom) * sy,
                float(self.right) * sx,
                float(self.top) * sy,
            )
        )

    def __repr__(self) -> str:
        return f"RectangleObject({list(self)!r})"

    @property
    def left(self) -> FloatObject:
        return self[0]

    @left.setter
    def left(self, f: float) -> None:
        self[0] = FloatObject(f)

    @property
    def bottom(self) -> FloatObject:
        return self[1]

    @bottom.setter
    def bottom(self, f: float) -> None:
        self[1] = FloatObject(f)

    @property
    def right(self) -> FloatObject:
        return self[2]

    @right.setter
    def right(self, f: float) -> None:
        self[2] = FloatObject(f)

    @property
    def top(self) -> FloatObject:
        return self[3]

    @top.setter
    def top(self, f: float) -> None:
        self[3] = FloatObject(f)

    @property
    def lower_left(self) -> tuple[float, float]:
        """
        Property to read and modify the lower left coordinate of this box
        in (x,y) form.
        """
        return self.left, self.bottom

    @lower_left.setter
    def lower_left(self, value: tuple[float, float]) -> None:
        self[0], self[1] = (self._ensure_is_number(x) for x in value)

    @property
    def lower_right(self) -> tuple[float, float]:
        """
        Property to read and modify the lower right coordinate of this box
        in (x,y) form.
        """
        return self.right, self.bottom

    @lower_right.setter
    def lower_right(self, value: tuple[float, float]) -> None:
        self[2], self[1] = (self._ensure_is_number(x) for x in value)

    @property
    def upper_left(self) -> tuple[float, float]:
        """
        Property to read and modify the upper left coordinate of this box
        in (x,y) form.
        """
        return self.left, self.top

    @upper_left.setter
    def upper_left(self, value: tuple[float, float]) -> None:
        self[0], self[3] = (self._ensure_is_number(x) for x in value)

    @property
    def upper_right(self) -> tuple[float, float]:
        """
        Property to read and modify the upper right coordinate of this box
        in (x,y) form.
        """
        return self.right, self.top

    @upper_right.setter
    def upper_right(self, value: tuple[float, float]) -> None:
        self[2], self[3] = (self._ensure_is_number(x) for x in value)

    @property
    def width(self) -> float:
        return self.right - self.left

    @property
    def height(self) -> float:
        return self.top - self.bottom
