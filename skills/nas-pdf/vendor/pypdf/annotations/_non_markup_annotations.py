from typing import TYPE_CHECKING, Any, Optional, Union

from ..generic._base import (
    BooleanObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from ..generic._data_structures import ArrayObject, DictionaryObject
from ..generic._fit import DEFAULT_FIT, Fit
from ..generic._rectangle import RectangleObject
from ._base import AnnotationDictionary


class Link(AnnotationDictionary):
    def __init__(
        self,
        *,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        border: Optional[ArrayObject] = None,
        url: Optional[str] = None,
        target_page_index: Optional[int] = None,
        fit: Fit = DEFAULT_FIT,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if TYPE_CHECKING:
            from ..types import BorderArrayType  # noqa: PLC0415

        is_external = url is not None
        is_internal = target_page_index is not None
        if not is_external and not is_internal:
            raise ValueError(
                "Either 'url' or 'target_page_index' have to be provided. Both were None."
            )
        if is_external and is_internal:
            raise ValueError(
                "Either 'url' or 'target_page_index' have to be provided. "
                f"{url=}, {target_page_index=}"
            )

        border_arr: BorderArrayType
        if border is not None:
            border_arr = [NumberObject(n) for n in border[:3]]
            if len(border) == 4:
                dash_pattern = ArrayObject([NumberObject(n) for n in border[3]])
                border_arr.append(dash_pattern)
        else:
            border_arr = [NumberObject(0)] * 3

        self.update(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Link"),
                NameObject("/Rect"): RectangleObject(rect),
                NameObject("/Border"): ArrayObject(border_arr),
            }
        )
        if is_external:
            self[NameObject("/A")] = DictionaryObject(
                {
                    NameObject("/S"): NameObject("/URI"),
                    NameObject("/Type"): NameObject("/Action"),
                    NameObject("/URI"): TextStringObject(url),
                }
            )
        if is_internal:
            # This needs to be updated later!
            dest_deferred = DictionaryObject(
                {
                    "target_page_index": NumberObject(target_page_index),
                    "fit": NameObject(fit.fit_type),
                    "fit_args": fit.fit_args,
                }
            )
            self[NameObject("/Dest")] = dest_deferred


class Popup(AnnotationDictionary):
    def __init__(
        self,
        *,
        rect: Union[RectangleObject, tuple[float, float, float, float]],
        parent: Optional[DictionaryObject] = None,
        open: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self.update(
            {
                NameObject("/Subtype"): NameObject("/Popup"),
                NameObject("/Rect"): RectangleObject(rect),
                NameObject("/Open"): BooleanObject(open),
            }
        )
        if parent:
            # This needs to be an indirect object
            try:
                self[NameObject("/Parent")] = parent.indirect_reference
            except AttributeError:
                from .._utils import logger_warning  # noqa: PLC0415

                logger_warning(
                    "Unregistered Parent object : No Parent field set",
                    __name__,
                )
