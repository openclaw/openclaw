"""Functions to convert an image XObject to an image"""

import sys
from io import BytesIO
from typing import Any, Literal, Optional, Union, cast

from ._utils import check_if_whitespace_only, logger_warning
from .constants import ColorSpaces, StreamAttributes
from .constants import FilterTypes as FT
from .constants import ImageAttributes as IA
from .errors import EmptyImageDataError, PdfReadError
from .generic import (
    ArrayObject,
    DecodedStreamObject,
    EncodedStreamObject,
    NullObject,
    TextStringObject,
    is_null_or_none,
)

if sys.version_info[:2] >= (3, 10):
    from typing import TypeAlias
else:
    from typing_extensions import TypeAlias


try:
    from PIL import Image, UnidentifiedImageError
except ImportError:
    raise ImportError(
        "pillow is required to do image extraction. "
        "It can be installed via 'pip install pypdf[image]'"
    )

mode_str_type: TypeAlias = Literal[
    "", "1", "RGB", "2bits", "4bits", "P", "L", "RGBA", "CMYK"
]

MAX_IMAGE_MODE_NESTING_DEPTH: int = 10


def _get_image_mode(
    color_space: Union[str, list[Any], Any],
    color_components: int,
    prev_mode: mode_str_type,
    depth: int = 0,
) -> tuple[mode_str_type, bool]:
    """
    Returns:
        Image mode, not taking into account mask (transparency).
        ColorInversion is required (like for some DeviceCMYK).

    """
    if depth > MAX_IMAGE_MODE_NESTING_DEPTH:
        raise PdfReadError(
            "Color spaces nested too deeply. If required, consider increasing MAX_IMAGE_MODE_NESTING_DEPTH."
        )
    if is_null_or_none(color_space):
        return "", False
    color_space_str: str = ""
    if isinstance(color_space, str):
        color_space_str = color_space
    elif not isinstance(color_space, list):
        raise PdfReadError(
            "Cannot interpret color space", color_space
        )  # pragma: no cover
    elif not color_space:
        return "", False
    elif color_space[0].startswith("/Cal"):  # /CalRGB or /CalGray
        color_space_str = "/Device" + color_space[0][4:]
    elif color_space[0] == "/ICCBased":
        icc_profile = color_space[1].get_object()
        color_components = cast(int, icc_profile["/N"])
        color_space_str = icc_profile.get("/Alternate", "")
    elif color_space[0] == "/Indexed":
        color_space_str = color_space[1].get_object()
        mode, invert_color = _get_image_mode(
            color_space_str, color_components, prev_mode, depth + 1
        )
        if mode in ("RGB", "CMYK"):
            mode = "P"
        return mode, invert_color
    elif color_space[0] == "/Separation":
        color_space_str = color_space[2].get_object()
        mode, invert_color = _get_image_mode(
            color_space_str, color_components, prev_mode, depth + 1
        )
        return mode, True
    elif color_space[0] == "/DeviceN":
        original_color_space = color_space
        color_components = len(color_space[1])
        color_space_str = color_space[2].get_object()
        if color_space_str == "/DeviceCMYK" and color_components == 1:
            if original_color_space[1][0] != "/Black":
                logger_warning(
                    f"Color {original_color_space[1][0]} converted to Gray. Please share PDF with pypdf dev team",
                    __name__,
                )
            return "L", True
        mode, invert_color = _get_image_mode(
            color_space_str, color_components, prev_mode, depth + 1
        )
        return mode, invert_color

    mode_map: dict[str, mode_str_type] = {
        "1bit": "1",  # must be zeroth position: color_components may index the values
        "/DeviceGray": "L",  # must be first position: color_components may index the values
        "palette": "P",  # must be second position: color_components may index the values
        "/DeviceRGB": "RGB",  # must be third position: color_components may index the values
        "/DeviceCMYK": "CMYK",  # must be fourth position: color_components may index the values
        "2bit": "2bits",
        "4bit": "4bits",
    }

    mode = (
        mode_map.get(color_space_str)
        or list(mode_map.values())[color_components]
        or prev_mode
    )

    return mode, mode == "CMYK"


def bits2byte(data: bytes, size: tuple[int, int], bits: int) -> bytes:
    mask = (1 << bits) - 1
    byte_buffer = bytearray(size[0] * size[1])
    data_index = 0
    bit = 8 - bits
    for y in range(size[1]):
        if bit != 8 - bits:
            data_index += 1
            bit = 8 - bits
        for x in range(size[0]):
            byte_buffer[x + y * size[0]] = (data[data_index] >> bit) & mask
            bit -= bits
            if bit < 0:
                data_index += 1
                bit = 8 - bits
    return bytes(byte_buffer)


def _extended_image_from_bytes(
    mode: str, size: tuple[int, int], data: bytes
) -> Image.Image:
    try:
        img = Image.frombytes(mode, size, data)
    except ValueError as exc:
        nb_pix = size[0] * size[1]
        data_length = len(data)
        if data_length == 0:
            raise EmptyImageDataError(
                "Data is 0 bytes, cannot process an image from empty data."
            ) from exc
        if data_length % nb_pix != 0:
            raise exc
        k = nb_pix * len(mode) / data_length
        data = b"".join(bytes((x,) * int(k)) for x in data)
        img = Image.frombytes(mode, size, data)
    return img


def __handle_flate__indexed(color_space: ArrayObject) -> tuple[Any, Any, Any, Any]:
    count = len(color_space)
    if count == 4:
        color_space, base, hival, lookup = (value.get_object() for value in color_space)
        return color_space, base, hival, lookup

    # Deal with strange AutoDesk files where `base` and `hival` look like this:
    #   /DeviceRGB\x00255
    element1 = color_space[1]
    element1 = element1 if isinstance(element1, str) else element1.get_object()
    if count == 3 and "\x00" in element1:
        color_space, lookup = color_space[0].get_object(), color_space[2].get_object()
        base, hival = element1.split("\x00")
        hival = int(hival)
        return color_space, base, hival, lookup
    raise PdfReadError(f"Expected color space with 4 values, got {count}: {color_space}")


def _handle_flate(
    size: tuple[int, int],
    data: bytes,
    mode: mode_str_type,
    color_space: str,
    colors: int,
    obj_as_text: str,
) -> tuple[Image.Image, str, str, bool]:
    """
    Process image encoded in flateEncode
    Returns img, image_format, extension, color inversion
    """
    extension = ".png"  # mime_type: "image/png"
    image_format = "PNG"
    lookup: Any
    base: Any
    hival: Any
    if isinstance(color_space, ArrayObject) and color_space[0] == "/Indexed":
        color_space, base, hival, lookup = __handle_flate__indexed(color_space)
    if mode == "2bits":
        mode = "P"
        data = bits2byte(data, size, 2)
    elif mode == "4bits":
        mode = "P"
        data = bits2byte(data, size, 4)
    img = _extended_image_from_bytes(mode, size, data)
    if color_space == "/Indexed":
        if isinstance(lookup, (EncodedStreamObject, DecodedStreamObject)):
            lookup = lookup.get_data()
        if isinstance(lookup, TextStringObject):
            lookup = lookup.original_bytes
        if isinstance(lookup, str):
            lookup = lookup.encode()
        try:
            nb, conv, mode = {  # type: ignore
                "1": (0, "", ""),
                "L": (1, "P", "L"),
                "P": (0, "", ""),
                "RGB": (3, "P", "RGB"),
                "CMYK": (4, "P", "CMYK"),
            }[_get_image_mode(base, 0, "")[0]]
        except KeyError:  # pragma: no cover
            logger_warning(
                f"Base {base} not coded please share the pdf file with pypdf dev team",
                __name__,
            )
            lookup = None
        else:
            if img.mode == "1":
                # Two values ("high" and "low").
                expected_count = 2 * nb
                actual_count = len(lookup)
                if actual_count != expected_count:
                    if actual_count < expected_count:
                        logger_warning(
                            f"Not enough lookup values: Expected {expected_count}, got {actual_count}.",
                            __name__
                        )
                        lookup += bytes([0] * (expected_count - actual_count))
                    elif not check_if_whitespace_only(lookup[expected_count:]):
                        logger_warning(
                            f"Too many lookup values: Expected {expected_count}, got {actual_count}.",
                            __name__
                        )
                    lookup = lookup[:expected_count]
                colors_arr = [lookup[:nb], lookup[nb:]]
                arr = b"".join(
                    b"".join(
                        colors_arr[1 if img.getpixel((x, y)) > 127 else 0]  # type: ignore[operator,unused-ignore]  # TODO: Remove unused-ignore on Python 3.10
                        for x in range(img.size[0])
                    )
                    for y in range(img.size[1])
                )
                img = Image.frombytes(mode, img.size, arr)
            else:
                img = img.convert(conv)
                if len(lookup) != (hival + 1) * nb:
                    logger_warning(f"Invalid Lookup Table in {obj_as_text}", __name__)
                    lookup = None
                elif mode == "L":
                    # gray lookup does not work: it is converted to a similar RGB lookup
                    lookup = b"".join([bytes([b, b, b]) for b in lookup])
                    mode = "RGB"
                # TODO: https://github.com/py-pdf/pypdf/pull/2039
                # this is a work around until PIL is able to process CMYK images
                elif mode == "CMYK":
                    _rgb = []
                    for _c, _m, _y, _k in (
                        lookup[n : n + 4] for n in range(0, 4 * (len(lookup) // 4), 4)
                    ):
                        _r = int(255 * (1 - _c / 255) * (1 - _k / 255))
                        _g = int(255 * (1 - _m / 255) * (1 - _k / 255))
                        _b = int(255 * (1 - _y / 255) * (1 - _k / 255))
                        _rgb.append(bytes((_r, _g, _b)))
                    lookup = b"".join(_rgb)
                    mode = "RGB"
                if lookup is not None:
                    img.putpalette(lookup, rawmode=mode)
            img = img.convert("L" if base == ColorSpaces.DEVICE_GRAY else "RGB")
    elif not is_null_or_none(color_space) and color_space[0] == "/ICCBased":
        # Exclude pure black-and-white images.
        # TODO: The remaining code still does not look correct. Shouldn't the proper way be
        #       to use the original image and apply the ICC transformation on it?
        #       For now, this just loads the original image with a different color space.
        if mode != "1":
            # Table 65 - Additional Entries Specific to an ICC Profile Stream Dictionary
            mode2 = _get_image_mode(color_space, colors, mode)[0]
            if mode != mode2:
                img = Image.frombytes(mode, size, data)  # reloaded as mode may have changed
    if mode == "CMYK":
        extension = ".tif"
        image_format = "TIFF"
    return img, image_format, extension, False


def _handle_jpx(
    size: tuple[int, int],
    data: bytes,
    mode: mode_str_type,
    color_space: str,
    colors: int,
) -> tuple[Image.Image, str, str, bool]:
    """
    Process image encoded as JPX/JPEG2000
    Returns img, image_format, extension, inversion
    """
    extension = ".jp2"  # mime_type: "image/x-jp2"
    img1: Image.Image = Image.open(BytesIO(data), formats=("JPEG2000",))
    mode, invert_color = _get_image_mode(color_space, colors, mode)
    if mode == "":
        mode = cast(mode_str_type, img1.mode)
        invert_color = mode == "CMYK"
    if img1.mode == "RGBA" and mode == "RGB":
        mode = "RGBA"
    # we need to convert to the good mode
    if img1.mode == mode or {img1.mode, mode} == {"L", "P"}:  # compare (unordered) sets
        # L and P are indexed modes which should not be changed.
        img = img1
    elif {img1.mode, mode} == {"RGBA", "CMYK"}:
        # RGBA / CMYK are 4bytes encoding where
        # the encoding should be corrected
        img = Image.frombytes(mode, img1.size, img1.tobytes())
    else:  # pragma: no cover
        img = img1.convert(mode)
    # CMYK conversion
    # https://stackverflow.com/questions/38855022/
    if img.mode == "CMYK" and color_space == "/ICCBased":
        img = img.convert("RGB")
    image_format = "JPEG2000"
    return img, image_format, extension, invert_color


def _apply_decode(
    img: Image.Image,
    x_object_obj: dict[str, Any],
    lfilters: FT,
    color_space: Union[str, list[Any], Any],
    invert_color: bool,
) -> Image.Image:
    # CMYK image and other color spaces without decode
    # requires reverting scale (cf p243,2§ last sentence)
    if IA.DECODE in x_object_obj:
        decode = x_object_obj[IA.DECODE]
        # if invert_color and lfilters == FT.DCT_DECODE:
        #     decode = list(reversed(decode))
    elif img.mode == "CMYK" and lfilters == FT.JPX_DECODE:
        decode = [1.0, 0.0] if not invert_color else [0.0, 1.0]
        decode = decode * len(img.getbands())
    elif (img.mode == "CMYK" and lfilters == FT.DCT_DECODE) or (invert_color and img.mode == "L"):
        decode = [1.0, 0.0] * len(img.getbands())
    else:
        decode = None

    if (
        isinstance(color_space, ArrayObject)
        and color_space[0].get_object() == "/Indexed"
    ):
        decode = None  # decode is meaningless if Indexed
    if (
        isinstance(color_space, ArrayObject)
        and color_space[0].get_object() == "/Separation"
    ):
        decode = [1.0, 0.0] * len(img.getbands())
    if decode is not None and not all(decode[i] == i % 2 for i in range(len(decode))):
        lut: list[int] = []
        for i in range(0, len(decode), 2):
            dmin = decode[i]
            dmax = decode[i + 1]
            lut.extend(
                round(255.0 * (j / 255.0 * (dmax - dmin) + dmin)) for j in range(256)
            )
        img = img.point(lut)
    return img


def _get_mode_and_invert_color(
    x_object_obj: dict[str, Any], colors: int, color_space: Union[str, list[Any], Any]
) -> tuple[mode_str_type, bool]:
    if (
        IA.COLOR_SPACE in x_object_obj
        and x_object_obj[IA.COLOR_SPACE] == ColorSpaces.DEVICE_RGB
    ):
        # https://pillow.readthedocs.io/en/stable/handbook/concepts.html#modes
        mode: mode_str_type = "RGB"
    if x_object_obj.get("/BitsPerComponent", 8) < 8:
        mode, invert_color = _get_image_mode(
            f"{x_object_obj.get('/BitsPerComponent', 8)}bit", 0, ""
        )
    else:
        mode, invert_color = _get_image_mode(
            color_space,
            2
            if (
                colors == 1
                and (
                    not is_null_or_none(color_space)
                    and "Gray" not in color_space
                )
            )
            else colors,
            "",
        )
    return mode, invert_color


def _xobj_to_image(
        x_object: dict[str, Any],
        pillow_parameters: Union[dict[str, Any], None] = None
) -> tuple[Optional[str], bytes, Any]:
    """
    Users need to have the pillow package installed.

    It's unclear if pypdf will keep this function here, hence it's private.
    It might get removed at any point.

    Args:
        x_object:
        pillow_parameters: parameters provided to Pillow Image.save() method,
            cf. <https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.Image.save>

    Returns:
        Tuple[file extension, bytes, PIL.Image.Image]

    """
    def _apply_alpha(
        img: Image.Image,
        x_object: dict[str, Any],
        obj_as_text: str,
        image_format: str,
        extension: str,
    ) -> tuple[Image.Image, str, str]:
        alpha = None
        if IA.S_MASK in x_object:  # add alpha channel
            alpha = _xobj_to_image(x_object[IA.S_MASK])[2]
            if img.size != alpha.size:
                logger_warning(
                    f"image and mask size not matching: {obj_as_text}", __name__
                )
            else:
                # TODO: implement mask
                if alpha.mode != "L":
                    alpha = alpha.convert("L")
                if img.mode == "P":
                    img = img.convert("RGB")
                elif img.mode == "1":
                    img = img.convert("L")
                img.putalpha(alpha)
            if "JPEG" in image_format:
                image_format = "JPEG2000"
                extension = ".jp2"
            else:
                image_format = "PNG"
                extension = ".png"
        return img, extension, image_format

    # For error reporting
    obj_as_text = (
        x_object.indirect_reference.__repr__()
        if x_object is None  # pragma: no cover
        else x_object.__repr__()
    )

    # Get size and data
    size = (cast(int, x_object[IA.WIDTH]), cast(int, x_object[IA.HEIGHT]))
    data = x_object.get_data()  # type: ignore
    if isinstance(data, str):  # pragma: no cover
        data = data.encode()
    if len(data) % (size[0] * size[1]) == 1 and data[-1] == 0x0A:  # ie. '\n'
        data = data[:-1]

    # Get color properties
    colors = x_object.get("/Colors", 1)
    color_space: Any = x_object.get("/ColorSpace", NullObject()).get_object()
    if isinstance(color_space, list) and len(color_space) == 1:
        color_space = color_space[0].get_object()

    mode, invert_color = _get_mode_and_invert_color(x_object, colors, color_space)

    # Get filters
    filters = x_object.get(StreamAttributes.FILTER, NullObject()).get_object()
    lfilters = filters[-1] if isinstance(filters, list) else filters
    decode_parms = x_object.get(StreamAttributes.DECODE_PARMS)
    if decode_parms and isinstance(decode_parms, (tuple, list)):
        decode_parms = decode_parms[0]
    else:
        decode_parms = {}
    if not isinstance(decode_parms, dict):
        decode_parms = {}

    extension = None
    if lfilters in (FT.FLATE_DECODE, FT.RUN_LENGTH_DECODE):
        img, image_format, extension, _ = _handle_flate(
            size,
            data,
            mode,
            color_space,
            colors,
            obj_as_text,
        )
    elif lfilters in (FT.LZW_DECODE, FT.ASCII_85_DECODE):
        # I'm not sure if the following logic is correct.
        # There might not be any relationship between the filters and the
        # extension
        if lfilters == FT.LZW_DECODE:
            image_format = "TIFF"
            extension = ".tiff"  # mime_type = "image/tiff"
        else:
            image_format = "PNG"
            extension = ".png"  # mime_type = "image/png"
        try:
            img = Image.open(BytesIO(data), formats=("TIFF", "PNG"))
        except UnidentifiedImageError:
            img = _extended_image_from_bytes(mode, size, data)
    elif lfilters == FT.DCT_DECODE:
        img, image_format, extension = Image.open(BytesIO(data)), "JPEG", ".jpg"
        # invert_color kept unchanged
    elif lfilters == FT.JPX_DECODE:
        img, image_format, extension, invert_color = _handle_jpx(
            size, data, mode, color_space, colors
        )
    elif lfilters == FT.CCITT_FAX_DECODE:
        img, image_format, extension, invert_color = (
            Image.open(BytesIO(data), formats=("TIFF",)),
            "TIFF",
            ".tiff",
            False,
        )
    elif lfilters == FT.JBIG2_DECODE:
        img, image_format, extension, invert_color = (
            Image.open(BytesIO(data), formats=("PNG", "PPM")),
            "PNG",
            ".png",
            False,
        )
    elif mode == "CMYK":
        img, image_format, extension, invert_color = (
            _extended_image_from_bytes(mode, size, data),
            "TIFF",
            ".tif",
            False,
        )
    elif mode == "":
        raise PdfReadError(f"ColorSpace field not found in {x_object}")
    else:
        img, image_format, extension, invert_color = (
            _extended_image_from_bytes(mode, size, data),
            "PNG",
            ".png",
            False,
        )

    img = _apply_decode(img, x_object, lfilters, color_space, invert_color)
    img, extension, image_format = _apply_alpha(
        img, x_object, obj_as_text, image_format, extension
    )

    if pillow_parameters is None:
        pillow_parameters = {}
    # Preserve JPEG image quality - see issue #3515.
    if image_format == "JPEG":
        # This prevents: Cannot use 'keep' when original image is not a JPEG:
        # "JPEG" is the value of PIL.JpegImagePlugin.JpegImageFile.format
        img.format = "JPEG"
        if "quality" not in pillow_parameters:
            pillow_parameters["quality"] = "keep"

    # Save image to bytes
    img_byte_arr = BytesIO()
    try:
        img.save(img_byte_arr, format=image_format, **pillow_parameters)
    except OSError:  # pragma: no cover  # covered with pillow 10.3
        # in case of we convert to RGBA and then to PNG
        img1 = img.convert("RGBA")
        image_format = "PNG"
        extension = ".png"
        img_byte_arr = BytesIO()
        img1.save(img_byte_arr, format=image_format)
    data = img_byte_arr.getvalue()

    try:  # temporary try/except until other fixes of images
        img = Image.open(BytesIO(data))
    except Exception as exception:
        logger_warning(f"Failed loading image: {exception}", __name__)
        img = None  # type: ignore[assignment,unused-ignore]  # TODO: Remove unused-ignore on Python 3.10
    return extension, data, img
