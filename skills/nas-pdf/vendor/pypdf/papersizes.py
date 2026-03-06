"""Helper to get paper sizes."""

from typing import NamedTuple


class Dimensions(NamedTuple):
    width: int
    height: int


class PaperSize:
    """(width, height) of the paper in portrait mode in pixels at 72 ppi."""

    # Notes of how to calculate it:
    # 1. Get the size of the paper in millimeters
    # 2. Convert it to inches (25.4 millimeters is equal to 1 inch)
    # 3. Convert it to pixels at 72dpi (1 inch is equal to 72 pixels)

    # All Din-A paper sizes follow this pattern:
    # 2 x A(n - 1) = A(n)
    # So the height of the next bigger one is the width of the smaller one
    # The ratio is always approximately 1:2**0.5
    # Additionally, A0 is defined to have an area of 1 m**2
    # https://en.wikipedia.org/wiki/ISO_216
    # Be aware of rounding issues!
    A0 = Dimensions(2384, 3370)  # 841mm x 1189mm
    A1 = Dimensions(1684, 2384)
    A2 = Dimensions(1191, 1684)
    A3 = Dimensions(842, 1191)
    A4 = Dimensions(
        595, 842
    )  # Printer paper, documents - this is by far the most common
    A5 = Dimensions(420, 595)  # Paperback books
    A6 = Dimensions(298, 420)  # Postcards
    A7 = Dimensions(210, 298)
    A8 = Dimensions(147, 210)

    # Envelopes
    C4 = Dimensions(649, 918)


_din_a = (
    PaperSize.A0,
    PaperSize.A1,
    PaperSize.A2,
    PaperSize.A3,
    PaperSize.A4,
    PaperSize.A5,
    PaperSize.A6,
    PaperSize.A7,
    PaperSize.A8,
)
