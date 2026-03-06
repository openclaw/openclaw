from typing import Any, Optional, Union

from ._base import is_null_or_none


class Fit:
    def __init__(
        self, fit_type: str, fit_args: tuple[Union[None, float, Any], ...] = ()
    ) -> None:
        from ._base import FloatObject, NameObject, NullObject, NumberObject  # noqa: PLC0415

        self.fit_type = NameObject(fit_type)
        self.fit_args: list[Union[NullObject, FloatObject, NumberObject]] = [
            NullObject() if is_null_or_none(a) else FloatObject(a) for a in fit_args
        ]

    @classmethod
    def xyz(
        cls,
        left: Optional[float] = None,
        top: Optional[float] = None,
        zoom: Optional[float] = None,
    ) -> "Fit":
        """
        Display the page designated by page, with the coordinates (left, top)
        positioned at the upper-left corner of the window and the contents
        of the page magnified by the factor zoom.

        A null value for any of the parameters left, top, or zoom specifies
        that the current value of that parameter is to be retained unchanged.

        A zoom value of 0 has the same meaning as a null value.

        Args:
            left:
            top:
            zoom:

        Returns:
            The created fit object.

        """
        return Fit(fit_type="/XYZ", fit_args=(left, top, zoom))

    @classmethod
    def fit(cls) -> "Fit":
        """
        Display the page designated by page, with its contents magnified just
        enough to fit the entire page within the window both horizontally and
        vertically.

        If the required horizontal and vertical magnification factors are
        different, use the smaller of the two, centering the page within the
        window in the other dimension.
        """
        return Fit(fit_type="/Fit")

    @classmethod
    def fit_horizontally(cls, top: Optional[float] = None) -> "Fit":
        """
        Display the page designated by page, with the vertical coordinate top
        positioned at the top edge of the window and the contents of the page
        magnified just enough to fit the entire width of the page within the
        window.

        A null value for ``top`` specifies that the current value of that
        parameter is to be retained unchanged.

        Args:
            top:

        Returns:
            The created fit object.

        """
        return Fit(fit_type="/FitH", fit_args=(top,))

    @classmethod
    def fit_vertically(cls, left: Optional[float] = None) -> "Fit":
        return Fit(fit_type="/FitV", fit_args=(left,))

    @classmethod
    def fit_rectangle(
        cls,
        left: Optional[float] = None,
        bottom: Optional[float] = None,
        right: Optional[float] = None,
        top: Optional[float] = None,
    ) -> "Fit":
        """
        Display the page designated by page, with its contents magnified
        just enough to fit the rectangle specified by the coordinates
        left, bottom, right, and top entirely within the window
        both horizontally and vertically.

        If the required horizontal and vertical magnification factors are
        different, use the smaller of the two, centering the rectangle within
        the window in the other dimension.

        A null value for any of the parameters may result in unpredictable
        behavior.

        Args:
            left:
            bottom:
            right:
            top:

        Returns:
            The created fit object.

        """
        return Fit(fit_type="/FitR", fit_args=(left, bottom, right, top))

    @classmethod
    def fit_box(cls) -> "Fit":
        """
        Display the page designated by page, with its contents magnified just
        enough to fit its bounding box entirely within the window both
        horizontally and vertically.

        If the required horizontal and vertical magnification factors are
        different, use the smaller of the two, centering the bounding box
        within the window in the other dimension.
        """
        return Fit(fit_type="/FitB")

    @classmethod
    def fit_box_horizontally(cls, top: Optional[float] = None) -> "Fit":
        """
        Display the page designated by page, with the vertical coordinate top
        positioned at the top edge of the window and the contents of the page
        magnified just enough to fit the entire width of its bounding box
        within the window.

        A null value for top specifies that the current value of that parameter
        is to be retained unchanged.

        Args:
            top:

        Returns:
            The created fit object.

        """
        return Fit(fit_type="/FitBH", fit_args=(top,))

    @classmethod
    def fit_box_vertically(cls, left: Optional[float] = None) -> "Fit":
        """
        Display the page designated by page, with the horizontal coordinate
        left positioned at the left edge of the window and the contents of the
        page magnified just enough to fit the entire height of its bounding box
        within the window.

        A null value for left specifies that the current value of that
        parameter is to be retained unchanged.

        Args:
            left:

        Returns:
            The created fit object.

        """
        return Fit(fit_type="/FitBV", fit_args=(left,))

    def __str__(self) -> str:
        if not self.fit_args:
            return f"Fit({self.fit_type})"
        return f"Fit({self.fit_type}, {self.fit_args})"


DEFAULT_FIT = Fit.fit()
