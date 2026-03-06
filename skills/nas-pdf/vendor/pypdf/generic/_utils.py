import codecs
from typing import Union

from .._codecs import _pdfdoc_encoding
from .._utils import StreamType, logger_warning, read_non_whitespace
from ..errors import STREAM_TRUNCATED_PREMATURELY, PdfStreamError
from ._base import ByteStringObject, TextStringObject


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    return tuple(int(value.lstrip("#")[i : i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore


def read_hex_string_from_stream(
    stream: StreamType,
    forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
) -> Union["TextStringObject", "ByteStringObject"]:
    stream.read(1)
    arr = []
    x = b""
    while True:
        tok = read_non_whitespace(stream)
        if not tok:
            raise PdfStreamError(STREAM_TRUNCATED_PREMATURELY)
        if tok == b">":
            break
        x += tok
        if len(x) == 2:
            arr.append(int(x, base=16))
            x = b""
    if len(x) == 1:
        x += b"0"
    if x != b"":
        arr.append(int(x, base=16))
    return create_string_object(bytes(arr), forced_encoding)


__ESCAPE_DICT__ = {
    b"n": ord(b"\n"),
    b"r": ord(b"\r"),
    b"t": ord(b"\t"),
    b"b": ord(b"\b"),
    b"f": ord(b"\f"),
    b"(": ord(b"("),
    b")": ord(b")"),
    b"/": ord(b"/"),
    b"\\": ord(b"\\"),
    b" ": ord(b" "),
    b"%": ord(b"%"),
    b"<": ord(b"<"),
    b">": ord(b">"),
    b"[": ord(b"["),
    b"]": ord(b"]"),
    b"#": ord(b"#"),
    b"_": ord(b"_"),
    b"&": ord(b"&"),
    b"$": ord(b"$"),
}
__BACKSLASH_CODE__ = 92


def read_string_from_stream(
    stream: StreamType,
    forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
) -> Union["TextStringObject", "ByteStringObject"]:
    tok = stream.read(1)
    parens = 1
    txt = []
    while True:
        tok = stream.read(1)
        if not tok:
            raise PdfStreamError(STREAM_TRUNCATED_PREMATURELY)
        if tok == b"(":
            parens += 1
        elif tok == b")":
            parens -= 1
            if parens == 0:
                break
        elif tok == b"\\":
            tok = stream.read(1)
            try:
                txt.append(__ESCAPE_DICT__[tok])
                continue
            except KeyError:
                if b"0" <= tok <= b"7":
                    # "The number ddd may consist of one, two, or three
                    # octal digits; high-order overflow shall be ignored.
                    # Three octal digits shall be used, with leading zeros
                    # as needed, if the next character of the string is also
                    # a digit." (PDF reference 7.3.4.2, p 16)
                    sav = stream.tell() - 1
                    for _ in range(2):
                        ntok = stream.read(1)
                        if b"0" <= ntok <= b"7":
                            tok += ntok
                        else:
                            stream.seek(-1, 1)  # ntok has to be analyzed
                            break
                    i = int(tok, base=8)
                    if i > 255:
                        txt.append(__BACKSLASH_CODE__)
                        stream.seek(sav)
                    else:
                        txt.append(i)
                    continue
                if tok in b"\n\r":
                    # This case is hit when a backslash followed by a line
                    # break occurs. If it's a multi-char EOL, consume the
                    # second character:
                    tok = stream.read(1)
                    if tok not in b"\n\r":
                        stream.seek(-1, 1)
                    # Then don't add anything to the actual string, since this
                    # line break was escaped:
                    continue
                msg = f"Unexpected escaped string: {tok.decode('utf-8', 'ignore')}"
                logger_warning(msg, __name__)
                txt.append(__BACKSLASH_CODE__)
        txt.append(ord(tok))
    return create_string_object(bytes(txt), forced_encoding)


def create_string_object(
    string: Union[str, bytes],
    forced_encoding: Union[None, str, list[str], dict[int, str]] = None,
) -> Union[TextStringObject, ByteStringObject]:
    """
    Create a ByteStringObject or a TextStringObject from a string to represent the string.

    Args:
        string: The data being used
        forced_encoding: Typically None, or an encoding string

    Returns:
        A ByteStringObject

    Raises:
        TypeError: If string is not of type str or bytes.

    """
    if isinstance(string, str):
        return TextStringObject(string)
    if isinstance(string, bytes):
        if isinstance(forced_encoding, (list, dict)):
            out = ""
            for x in string:
                try:
                    out += forced_encoding[x]
                except Exception:
                    out += bytes((x,)).decode("charmap")
            obj = TextStringObject(out)
            obj._original_bytes = string
            return obj
        if isinstance(forced_encoding, str):
            if forced_encoding == "bytes":
                return ByteStringObject(string)
            obj = TextStringObject(string.decode(forced_encoding))
            obj._original_bytes = string
            return obj
        try:
            if string.startswith((codecs.BOM_UTF16_BE, codecs.BOM_UTF16_LE)):
                retval = TextStringObject(string.decode("utf-16"))
                retval._original_bytes = string
                retval.autodetect_utf16 = True
                retval.utf16_bom = string[:2]
                return retval
            if string.startswith(b"\x00"):
                retval = TextStringObject(string.decode("utf-16be"))
                retval._original_bytes = string
                retval.autodetect_utf16 = True
                retval.utf16_bom = codecs.BOM_UTF16_BE
                return retval
            if string[1:2] == b"\x00":
                retval = TextStringObject(string.decode("utf-16le"))
                retval._original_bytes = string
                retval.autodetect_utf16 = True
                retval.utf16_bom = codecs.BOM_UTF16_LE
                return retval

            # This is probably a big performance hit here, but we need
            # to convert string objects into the text/unicode-aware
            # version if possible... and the only way to check if that's
            # possible is to try.
            # Some strings are strings, some are just byte arrays.
            retval = TextStringObject(decode_pdfdocencoding(string))
            retval._original_bytes = string
            retval.autodetect_pdfdocencoding = True
            return retval
        except UnicodeDecodeError:
            return ByteStringObject(string)
    else:
        raise TypeError("create_string_object should have str or unicode arg")


def decode_pdfdocencoding(byte_array: bytes) -> str:
    retval = ""
    for b in byte_array:
        c = _pdfdoc_encoding[b]
        if c == "\u0000":
            raise UnicodeDecodeError(
                "pdfdocencoding",
                bytearray(b),
                -1,
                -1,
                "does not exist in translation table",
            )
        retval += c
    return retval
