"""manage the PDF transform stack during "layout" mode text extraction"""

from collections import ChainMap, Counter
from collections import ChainMap as ChainMapType
from collections import Counter as CounterType
from collections.abc import MutableMapping
from typing import Any, Union

from ..._font import Font
from ...errors import PdfReadError
from .. import mult
from ._text_state_params import TextStateParams

TextStateManagerChainMapType = ChainMapType[Union[int, str], Union[float, bool]]
TextStateManagerDictType = MutableMapping[Union[int, str], Union[float, bool]]


class TextStateManager:
    """
    Tracks the current text state including cm/tm/trm transformation matrices.

    Attributes:
        transform_stack (ChainMap): ChainMap of cm/tm transformation matrices
        q_queue (Counter[int]): Counter of q operators
        q_depth (List[int]): list of q operator nesting levels
        Tc (float): character spacing
        Tw (float): word spacing
        Tz (int): horizontal scaling
        TL (float): leading
        Ts (float): text rise
        font (Font): font object
        font_size (int | float): font size

    """

    def __init__(self) -> None:
        self.transform_stack: TextStateManagerChainMapType = ChainMap(
            self.new_transform()
        )
        self.q_queue: CounterType[int] = Counter()
        self.q_depth = [0]
        self.Tc: float = 0.0
        self.Tw: float = 0.0
        self.Tz: float = 100.0
        self.TL: float = 0.0
        self.Ts: float = 0.0
        self.font_stack: list[tuple[Union[Font, None], Union[int, float]]] = []
        self.font: Union[Font, None] = None
        self.font_size: Union[int, float] = 0

    def set_state_param(self, op: bytes, value: Union[float, list[Any]]) -> None:
        """
        Set a text state parameter. Supports Tc, Tz, Tw, TL, and Ts operators.

        Args:
            op: operator read from PDF stream as bytes. No action is taken
                for unsupported operators (see supported operators above).
            value (float | List[Any]): new parameter value. If a list,
                value[0] is used.

        """
        if op not in [b"Tc", b"Tz", b"Tw", b"TL", b"Ts"]:
            return
        self.__setattr__(op.decode(), value[0] if isinstance(value, list) else value)

    def set_font(self, font: Font, size: float) -> None:
        """
        Set the current font and font_size.

        Args:
            font (Font): a layout mode Font
            size (float): font size

        """
        self.font = font
        self.font_size = size

    def text_state_params(self, value: Union[bytes, str] = "") -> TextStateParams:
        """
        Create a TextStateParams instance to display a text string. Type[bytes] values
        will be decoded implicitly.

        Args:
            value (str | bytes): text to associate with the captured state.

        Raises:
            PdfReadError: if font not set (no Tf operator in incoming pdf content stream)

        Returns:
            TextStateParams: current text state parameters

        """
        if not isinstance(self.font, Font):
            raise PdfReadError(
                "font not set: is PDF missing a Tf operator?"
            )  # pragma: no cover
        if isinstance(value, bytes):
            try:
                if isinstance(self.font.encoding, str):
                    txt = value.decode(self.font.encoding, "surrogatepass")
                else:
                    txt = "".join(
                        self.font.encoding[x]
                        if x in self.font.encoding
                        else bytes((x,)).decode()
                        for x in value
                    )
            except (UnicodeEncodeError, UnicodeDecodeError):
                txt = value.decode("utf-8", "replace")
            txt = "".join(
                self.font.character_map.get(x, x) for x in txt
            )
        else:
            txt = value
        return TextStateParams(
            txt,
            self.font,
            self.font_size,
            self.Tc,
            self.Tw,
            self.Tz,
            self.TL,
            self.Ts,
            self.effective_transform,
        )

    @staticmethod
    def raw_transform(
        _a: float = 1.0,
        _b: float = 0.0,
        _c: float = 0.0,
        _d: float = 1.0,
        _e: float = 0.0,
        _f: float = 0.0,
    ) -> dict[int, float]:
        """Only a/b/c/d/e/f matrix params"""
        return dict(zip(range(6), map(float, (_a, _b, _c, _d, _e, _f))))

    @staticmethod
    def new_transform(
        _a: float = 1.0,
        _b: float = 0.0,
        _c: float = 0.0,
        _d: float = 1.0,
        _e: float = 0.0,
        _f: float = 0.0,
        is_text: bool = False,
        is_render: bool = False,
    ) -> TextStateManagerDictType:
        """Standard a/b/c/d/e/f matrix params + 'is_text' and 'is_render' keys"""
        result: Any = TextStateManager.raw_transform(_a, _b, _c, _d, _e, _f)
        result.update({"is_text": is_text, "is_render": is_render})
        return result

    def reset_tm(self) -> TextStateManagerChainMapType:
        """Clear all transforms from chainmap having is_text==True or is_render==True"""
        while (
            self.transform_stack.maps[0]["is_text"]
            or self.transform_stack.maps[0]["is_render"]
        ):
            self.transform_stack = self.transform_stack.parents
        return self.transform_stack

    def reset_trm(self) -> TextStateManagerChainMapType:
        """Clear all transforms from chainmap having is_render==True"""
        while self.transform_stack.maps[0]["is_render"]:
            self.transform_stack = self.transform_stack.parents
        return self.transform_stack

    def remove_q(self) -> TextStateManagerChainMapType:
        """Rewind to stack prior state after closing a 'q' with internal 'cm' ops"""
        self.font, self.font_size = self.font_stack.pop(-1)
        self.transform_stack = self.reset_tm()
        self.transform_stack.maps = self.transform_stack.maps[
            self.q_queue.pop(self.q_depth.pop(), 0) :
        ]
        return self.transform_stack

    def add_q(self) -> None:
        """Add another level to q_queue"""
        self.font_stack.append((self.font, self.font_size))
        self.q_depth.append(len(self.q_depth))

    def add_cm(self, *args: Any) -> TextStateManagerChainMapType:
        """Concatenate an additional transform matrix"""
        self.transform_stack = self.reset_tm()
        self.q_queue.update(self.q_depth[-1:])
        self.transform_stack = self.transform_stack.new_child(self.new_transform(*args))
        return self.transform_stack

    def _complete_matrix(self, operands: list[float]) -> list[float]:
        """Adds a, b, c, and d to an "e/f only" operand set (e.g Td)"""
        if len(operands) == 2:  # this is a Td operator or equivalent
            operands = [1.0, 0.0, 0.0, 1.0, *operands]
        return operands

    def add_tm(self, operands: list[float]) -> TextStateManagerChainMapType:
        """Append a text transform matrix"""
        self.transform_stack = self.transform_stack.new_child(
            self.new_transform(  # type: ignore[misc]
                *self._complete_matrix(operands), is_text=True  # type: ignore[arg-type]
            )
        )
        return self.transform_stack

    def add_trm(self, operands: list[float]) -> TextStateManagerChainMapType:
        """Append a text rendering transform matrix"""
        self.transform_stack = self.transform_stack.new_child(
            self.new_transform(  # type: ignore[misc]
                *self._complete_matrix(operands), is_text=True, is_render=True  # type: ignore[arg-type]
            )
        )
        return self.transform_stack

    @property
    def effective_transform(self) -> list[float]:
        """Current effective transform accounting for cm, tm, and trm transforms"""
        eff_transform = [*self.transform_stack.maps[0].values()]
        for transform in self.transform_stack.maps[1:]:
            eff_transform = mult(eff_transform, transform)  # type: ignore[arg-type]  # dict has int keys 0-5
        return eff_transform
