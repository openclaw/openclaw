"""Derive static Instrument Sans faces for GPUI's discrete font matching."""

from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


DESTINATION = Path(__file__).resolve().parent
SOURCE = DESTINATION.parents[3] / "ui/public/fonts"
WEIGHTS = {400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold"}


for italic in (False, True):
    suffix = "-italic" if italic else ""
    source = SOURCE / f"instrument-sans{suffix}-latin.woff2"
    for weight, weight_name in WEIGHTS.items():
        font = instantiateVariableFont(
            TTFont(source), {"wdth": 100, "wght": weight}, inplace=True
        )
        font.flavor = None
        style = (
            "Italic" if weight == 400 else f"{weight_name} Italic"
        ) if italic else weight_name
        postscript_name = f"InstrumentSans-{style.replace(' ', '')}"
        names = {
            1: "Instrument Sans",
            2: style,
            3: f"Instrument Sans static Latin: {postscript_name}",
            4: f"Instrument Sans {style}",
            6: postscript_name,
            16: "Instrument Sans",
            17: style,
        }
        for name_id, value in names.items():
            font["name"].removeNames(nameID=name_id)
            font["name"].setName(value, name_id, 3, 1, 0x409)
            font["name"].setName(value, name_id, 1, 0, 0)
        bold = weight == 700
        font["OS/2"].usWeightClass = weight
        font["OS/2"].fsSelection &= ~((1 << 0) | (1 << 5) | (1 << 6))
        font["OS/2"].fsSelection |= int(italic) | (int(bold) << 5)
        if not italic and not bold:
            font["OS/2"].fsSelection |= 1 << 6
        font["head"].macStyle = int(bold) | (int(italic) << 1)
        font.save(DESTINATION / f"instrument-sans-{weight}{suffix}.ttf")
