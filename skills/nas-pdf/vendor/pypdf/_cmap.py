import binascii
from binascii import Error as BinasciiError
from binascii import unhexlify
from math import ceil
from typing import Any, Union, cast

from ._codecs import adobe_glyphs, charset_encoding
from ._utils import logger_error, logger_warning
from .errors import LimitReachedError
from .generic import (
    DecodedStreamObject,
    DictionaryObject,
    NullObject,
    StreamObject,
    is_null_or_none,
)

_predefined_cmap: dict[str, str] = {
    "/Identity-H": "utf-16-be",
    "/Identity-V": "utf-16-be",
    "/GB-EUC-H": "gbk",
    "/GB-EUC-V": "gbk",
    "/GBpc-EUC-H": "gb2312",
    "/GBpc-EUC-V": "gb2312",
    "/GBK-EUC-H": "gbk",
    "/GBK-EUC-V": "gbk",
    "/GBK2K-H": "gb18030",
    "/GBK2K-V": "gb18030",
    "/ETen-B5-H": "cp950",
    "/ETen-B5-V": "cp950",
    "/ETenms-B5-H": "cp950",
    "/ETenms-B5-V": "cp950",
    "/UniCNS-UTF16-H": "utf-16-be",
    "/UniCNS-UTF16-V": "utf-16-be",
    "/UniGB-UTF16-H": "gb18030",
    "/UniGB-UTF16-V": "gb18030",
    # UCS2 in code
}


def get_encoding(
    ft: DictionaryObject
) -> tuple[Union[str, dict[int, str]], dict[Any, Any]]:
    encoding = _parse_encoding(ft)
    map_dict, int_entry = _parse_to_unicode(ft)

    # Apply rule from PDF ref 1.7 §5.9.1, 1st bullet:
    #   if cmap not empty encoding should be discarded
    #   (here transformed into identity for those characters)
    # If encoding is a string, it is expected to be an identity translation.
    if isinstance(encoding, dict):
        for x in int_entry:
            if x <= 255:
                encoding[x] = chr(x)

    return encoding, map_dict


def _parse_encoding(
    ft: DictionaryObject
) -> Union[str, dict[int, str]]:
    encoding: Union[str, list[str], dict[int, str]] = []
    if "/Encoding" not in ft:
        if "/BaseFont" in ft and cast(str, ft["/BaseFont"]) in charset_encoding:
            encoding = dict(
                zip(range(256), charset_encoding[cast(str, ft["/BaseFont"])])
            )
        else:
            encoding = "charmap"
        return encoding
    enc: Union[str, DictionaryObject, NullObject] = cast(
        Union[str, DictionaryObject, NullObject], ft["/Encoding"].get_object()
    )
    if isinstance(enc, str):
        try:
            # already done : enc = NameObject.unnumber(enc.encode()).decode()
            # for #xx decoding
            if enc in charset_encoding:
                encoding = charset_encoding[enc].copy()
            elif enc in _predefined_cmap:
                encoding = _predefined_cmap[enc]
            elif "-UCS2-" in enc:
                encoding = "utf-16-be"
            else:
                raise Exception("not found")
        except Exception:
            logger_error(f"Advanced encoding {enc} not implemented yet", __name__)
            encoding = enc
    elif isinstance(enc, DictionaryObject) and "/BaseEncoding" in enc:
        try:
            encoding = charset_encoding[cast(str, enc["/BaseEncoding"])].copy()
        except Exception:
            logger_error(
                f"Advanced encoding {encoding} not implemented yet",
                __name__,
            )
            encoding = charset_encoding["/StandardEncoding"].copy()
    else:
        encoding = charset_encoding["/StandardEncoding"].copy()
    if isinstance(enc, DictionaryObject) and "/Differences" in enc:
        x: int = 0
        o: Union[int, str]
        for o in cast(DictionaryObject, enc["/Differences"]):
            if isinstance(o, int):
                x = o
            else:  # isinstance(o, str):
                try:
                    if x < len(encoding):
                        encoding[x] = adobe_glyphs[o]  # type: ignore
                except Exception:
                    encoding[x] = o  # type: ignore
                x += 1
    if isinstance(encoding, list):
        encoding = dict(zip(range(256), encoding))
    return encoding


def _parse_to_unicode(
    ft: DictionaryObject
) -> tuple[dict[Any, Any], list[int]]:
    # will store all translation code
    # and map_dict[-1] we will have the number of bytes to convert
    map_dict: dict[Any, Any] = {}

    # will provide the list of cmap keys as int to correct encoding
    int_entry: list[int] = []

    if "/ToUnicode" not in ft:
        if ft.get("/Subtype", "") == "/Type1":
            return _type1_alternative(ft, map_dict, int_entry)
        return {}, []
    process_rg: bool = False
    process_char: bool = False
    multiline_rg: Union[
        None, tuple[int, int]
    ] = None  # tuple = (current_char, remaining size) ; cf #1285 for example of file
    cm = prepare_cm(ft)
    for line in cm.split(b"\n"):
        process_rg, process_char, multiline_rg = process_cm_line(
            line.strip(b" \t"),
            process_rg,
            process_char,
            multiline_rg,
            map_dict,
            int_entry,
        )

    return map_dict, int_entry


def prepare_cm(ft: DictionaryObject) -> bytes:
    tu = ft["/ToUnicode"]
    cm: bytes
    if isinstance(tu, StreamObject):
        cm = cast(DecodedStreamObject, ft["/ToUnicode"]).get_data()
    else:  # if (tu is None) or cast(str, tu).startswith("/Identity"):
        # the full range 0000-FFFF will be processed
        cm = b"beginbfrange\n<0000> <0001> <0000>\nendbfrange"
    if isinstance(cm, str):
        cm = cm.encode()
    # we need to prepare cm before due to missing return line in pdf printed
    # to pdf from word
    cm = (
        cm.strip()
        .replace(b"beginbfchar", b"\nbeginbfchar\n")
        .replace(b"endbfchar", b"\nendbfchar\n")
        .replace(b"beginbfrange", b"\nbeginbfrange\n")
        .replace(b"endbfrange", b"\nendbfrange\n")
        .replace(b"<<", b"\n{\n")  # text between << and >> not used but
        .replace(b">>", b"\n}\n")  # some solution to find it back
    )
    ll = cm.split(b"<")
    for i in range(len(ll)):
        j = ll[i].find(b">")
        if j >= 0:
            if j == 0:
                # string is empty: stash a placeholder here (see below)
                # see https://github.com/py-pdf/pypdf/issues/1111
                content = b"."
            else:
                content = ll[i][:j].replace(b" ", b"")
            ll[i] = content + b" " + ll[i][j + 1 :]
    cm = (
        (b" ".join(ll))
        .replace(b"[", b" [ ")
        .replace(b"]", b" ]\n ")
        .replace(b"\r", b"\n")
    )
    return cm


def process_cm_line(
    line: bytes,
    process_rg: bool,
    process_char: bool,
    multiline_rg: Union[None, tuple[int, int]],
    map_dict: dict[Any, Any],
    int_entry: list[int],
) -> tuple[bool, bool, Union[None, tuple[int, int]]]:
    if line == b"" or line[0] == 37:  # 37 = %
        return process_rg, process_char, multiline_rg
    line = line.replace(b"\t", b" ")
    if b"beginbfrange" in line:
        process_rg = True
    elif b"endbfrange" in line:
        process_rg = False
    elif b"beginbfchar" in line:
        process_char = True
    elif b"endbfchar" in line:
        process_char = False
    elif process_rg:
        try:
            multiline_rg = parse_bfrange(line, map_dict, int_entry, multiline_rg)
        except binascii.Error as error:
            logger_warning(f"Skipping broken line {line!r}: {error}", __name__)
    elif process_char:
        parse_bfchar(line, map_dict, int_entry)
    return process_rg, process_char, multiline_rg


# Usual values should be up to 65_536.
MAPPING_DICTIONARY_SIZE_LIMIT = 100_000


def _check_mapping_size(size: int) -> None:
    if size > MAPPING_DICTIONARY_SIZE_LIMIT:
        raise LimitReachedError(f"Maximum /ToUnicode size limit reached: {size} > {MAPPING_DICTIONARY_SIZE_LIMIT}.")


def parse_bfrange(
    line: bytes,
    map_dict: dict[Any, Any],
    int_entry: list[int],
    multiline_rg: Union[None, tuple[int, int]],
) -> Union[None, tuple[int, int]]:
    lst = [x for x in line.split(b" ") if x]
    closure_found = False
    entry_count = len(int_entry)
    _check_mapping_size(entry_count)
    if multiline_rg is not None:
        fmt = b"%%0%dX" % (map_dict[-1] * 2)
        a = multiline_rg[0]  # a, b not in the current line
        b = multiline_rg[1]
        for sq in lst:
            if sq == b"]":
                closure_found = True
                break
            entry_count += 1
            _check_mapping_size(entry_count)
            map_dict[
                unhexlify(fmt % a).decode(
                    "charmap" if map_dict[-1] == 1 else "utf-16-be",
                    "surrogatepass",
                )
            ] = unhexlify(sq).decode("utf-16-be", "surrogatepass")
            int_entry.append(a)
            a += 1
    else:
        a = int(lst[0], 16)
        b = int(lst[1], 16)
        nbi = max(len(lst[0]), len(lst[1]))
        map_dict[-1] = ceil(nbi / 2)
        fmt = b"%%0%dX" % (map_dict[-1] * 2)
        if lst[2] == b"[":
            for sq in lst[3:]:
                if sq == b"]":
                    closure_found = True
                    break
                entry_count += 1
                _check_mapping_size(entry_count)
                map_dict[
                    unhexlify(fmt % a).decode(
                        "charmap" if map_dict[-1] == 1 else "utf-16-be",
                        "surrogatepass",
                    )
                ] = unhexlify(sq).decode("utf-16-be", "surrogatepass")
                int_entry.append(a)
                a += 1
        else:  # case without list
            c = int(lst[2], 16)
            fmt2 = b"%%0%dX" % max(4, len(lst[2]))
            closure_found = True
            range_size = max(0, b - a + 1)
            _check_mapping_size(entry_count + range_size)  # This can be checked beforehand.
            while a <= b:
                map_dict[
                    unhexlify(fmt % a).decode(
                        "charmap" if map_dict[-1] == 1 else "utf-16-be",
                        "surrogatepass",
                    )
                ] = unhexlify(fmt2 % c).decode("utf-16-be", "surrogatepass")
                int_entry.append(a)
                a += 1
                c += 1
    return None if closure_found else (a, b)


def parse_bfchar(line: bytes, map_dict: dict[Any, Any], int_entry: list[int]) -> None:
    lst = [x for x in line.split(b" ") if x]
    new_count = len(lst) // 2
    _check_mapping_size(len(int_entry) + new_count)  # This can be checked beforehand.
    map_dict[-1] = len(lst[0]) // 2
    while len(lst) > 1:
        map_to = ""
        # placeholder (see above) means empty string
        if lst[1] != b".":
            try:
                map_to = unhexlify(lst[1]).decode(
                    "charmap" if len(lst[1]) < 4 else "utf-16-be", "surrogatepass"
                )  # join is here as some cases where the code was split
            except BinasciiError as exception:
                logger_warning(f"Got invalid hex string: {exception!s} ({lst[1]!r})", __name__)
        map_dict[
            unhexlify(lst[0]).decode(
                "charmap" if map_dict[-1] == 1 else "utf-16-be", "surrogatepass"
            )
        ] = map_to
        int_entry.append(int(lst[0], 16))
        lst = lst[2:]


def _type1_alternative(
    ft: DictionaryObject,
    map_dict: dict[Any, Any],
    int_entry: list[int],
) -> tuple[dict[Any, Any], list[int]]:
    if "/FontDescriptor" not in ft:
        return map_dict, int_entry
    ft_desc = cast(DictionaryObject, ft["/FontDescriptor"]).get("/FontFile")
    if is_null_or_none(ft_desc):
        return map_dict, int_entry
    assert ft_desc is not None, "mypy"
    txt = ft_desc.get_object().get_data()
    txt = txt.split(b"eexec\n")[0]  # only clear part
    txt = txt.split(b"/Encoding")[1]  # to get the encoding part
    lines = txt.replace(b"\r", b"\n").split(b"\n")
    for li in lines:
        if li.startswith(b"dup"):
            words = [_w for _w in li.split(b" ") if _w != b""]
            if len(words) > 3 and words[3] != b"put":
                continue
            try:
                i = int(words[1])
            except ValueError:  # pragma: no cover
                continue
            try:
                v = adobe_glyphs[words[2].decode()]
            except KeyError:
                if words[2].startswith(b"/uni"):
                    try:
                        v = chr(int(words[2][4:], 16))
                    except ValueError:  # pragma: no cover
                        continue
                else:
                    continue
            map_dict[chr(i)] = v
            int_entry.append(i)
    return map_dict, int_entry
