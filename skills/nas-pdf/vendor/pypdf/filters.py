# Copyright (c) 2006, Mathieu Fenniak
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are
# met:
#
# * Redistributions of source code must retain the above copyright notice,
# this list of conditions and the following disclaimer.
# * Redistributions in binary form must reproduce the above copyright notice,
# this list of conditions and the following disclaimer in the documentation
# and/or other materials provided with the distribution.
# * The name of the author may not be used to endorse or promote products
# derived from this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.


"""
Implementation of stream filters; §7.4 Filters of the PDF 2.0 specification.

§8.9.7 Inline images of the PDF 2.0 specification has abbreviations that can be
used for the names of filters in an inline image object.
"""
__author__ = "Mathieu Fenniak"
__author_email__ = "biziqe@mathieu.fenniak.net"

import binascii
import math
import os
import shutil
import struct
import subprocess
import zlib
from base64 import a85decode
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Optional, Union, cast

from ._codecs._codecs import LzwCodec as _LzwCodec
from ._utils import (
    WHITESPACES_AS_BYTES,
    deprecate,
    deprecation_with_replacement,
    logger_warning,
)
from .constants import CcittFaxDecodeParameters as CCITT
from .constants import FilterTypeAbbreviations as FTA
from .constants import FilterTypes as FT
from .constants import ImageAttributes as IA
from .constants import LzwFilterParameters as LZW
from .constants import StreamAttributes as SA
from .errors import DependencyError, LimitReachedError, PdfReadError, PdfStreamError
from .generic import (
    ArrayObject,
    DictionaryObject,
    IndirectObject,
    NullObject,
    NumberObject,
    StreamObject,
    is_null_or_none,
)

JBIG2_MAX_OUTPUT_LENGTH = 75_000_000
LZW_MAX_OUTPUT_LENGTH = 75_000_000
RUN_LENGTH_MAX_OUTPUT_LENGTH = 75_000_000
ZLIB_MAX_OUTPUT_LENGTH = 75_000_000
ZLIB_MAX_RECOVERY_INPUT_LENGTH = 5_000_000

# Reuse cached 1-byte values in the fallback loop to avoid per-byte allocations.
_SINGLE_BYTES = tuple(bytes((i,)) for i in range(256))


def _decompress_with_limit(data: bytes) -> bytes:
    decompressor = zlib.decompressobj()
    result = decompressor.decompress(data, max_length=ZLIB_MAX_OUTPUT_LENGTH)
    if decompressor.unconsumed_tail:
        raise LimitReachedError(
            f"Limit reached while decompressing. {len(decompressor.unconsumed_tail)} bytes remaining."
        )
    return result


def decompress(data: bytes) -> bytes:
    """
    Decompress the given data using zlib.

    Attempts to decompress the input data using zlib.
    If the decompression fails due to a zlib error, it falls back
    to using a decompression object with a larger window size.

    Please note that the output length is limited to avoid memory
    issues. If you need to process larger content streams, consider
    adapting ``pypdf.filters.ZLIB_MAX_OUTPUT_LENGTH``. In case you
    are only dealing with trusted inputs and/or want to disable these
    limits, set the value to `0`.

    Args:
        data: The input data to be decompressed.

    Returns:
        The decompressed data.

    """
    try:
        return _decompress_with_limit(data)
    except zlib.error:
        # First quick approach: There are known issues with faulty added bytes to the
        # tail of the encoded stream from early Adobe Distiller or Pitstop versions
        # with CR char as the default line separator (assumed by reverse engineering)
        # that breaks the decoding process in the end.
        #
        # Try first to cut off some of the tail byte by byte, but limited to not
        # iterate through too many loops and kill the performance for large streams,
        # to then allow the final fallback to run. Added this intermediate attempt,
        # because starting from the head of the stream byte by byte kills completely
        # the performance for large streams (e.g., 6 MB) with the tail-byte-issue
        # and takes ages. This solution is really fast:
        max_tail_cut_off_bytes: int = 8
        for i in range(1, min(max_tail_cut_off_bytes + 1, len(data))):
            try:
                return _decompress_with_limit(data[:-i])
            except zlib.error:
                pass

        # If still failing, then try with increased window size.
        decompressor = zlib.decompressobj(zlib.MAX_WBITS | 32)
        result_str = b""
        remaining_limit = ZLIB_MAX_OUTPUT_LENGTH
        data_length = len(data)
        known_errors = set()
        for index in range(data_length):
            chunk = _SINGLE_BYTES[data[index]]
            try:
                decompressed = decompressor.decompress(chunk, max_length=remaining_limit)
                result_str += decompressed
                remaining_limit -= len(decompressed)
                if remaining_limit <= 0:
                    raise LimitReachedError(
                        f"Limit reached while decompressing. {data_length - index} bytes remaining."
                    )
            except zlib.error as error:
                if index > ZLIB_MAX_RECOVERY_INPUT_LENGTH:
                    raise LimitReachedError(
                        f"Recovery limit reached while decompressing. {data_length - index} bytes remaining."
                    )
                error_str = str(error)
                if error_str in known_errors:
                    continue
                logger_warning(error_str, __name__)
                known_errors.add(error_str)
        return result_str


class FlateDecode:
    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decode data which is flate-encoded.

        Args:
          data: Flate-encoded data.
          decode_parms: Additional decoding parameters.

        Returns:
          The flate-decoded data.

        Raises:
          PdfReadError: Unsupported parameters have been found.

        """
        str_data = decompress(data)

        if isinstance(decode_parms, DictionaryObject):
            parameters = decode_parms
        else:
            parameters = DictionaryObject()

        predictor = parameters.get("/Predictor", 1)

        # predictor 1 == no predictor
        if predictor != 1:
            columns, colors, bits_per_component = FlateDecode._get_parameters(parameters)

            # PNG predictor can vary by row and so is the lead byte on each row
            rowlength = (
                math.ceil(columns * colors * bits_per_component / 8) + 1
            )  # number of bytes

            # TIFF prediction:
            if predictor == 2:
                rowlength -= 1  # remove the predictor byte
                bpp = rowlength // columns
                str_data = bytearray(str_data)
                for i in range(len(str_data)):
                    if i % rowlength >= bpp:
                        str_data[i] = (str_data[i] + str_data[i - bpp]) % 256
                str_data = bytes(str_data)
            # PNG prediction:
            elif 10 <= predictor <= 15:
                str_data = FlateDecode._decode_png_prediction(
                    str_data, columns, rowlength
                )
            else:
                raise PdfReadError(f"Unsupported flatedecode predictor {predictor!r}")
        return str_data

    @staticmethod
    def _get_parameters(parameters: DictionaryObject) -> tuple[int, int, int]:
        # For details, see table 8 of ISO 32000-2:2020.
        def get(key: str, default: int) -> int:
            _value = parameters.get(key, NumberObject(default)).get_object()
            if not isinstance(_value, int) or _value < 1:
                raise PdfReadError(f"Expected positive number for {key}, got {_value}!")
            return _value

        columns = get(key=LZW.COLUMNS, default=1)
        colors = get(key=LZW.COLORS, default=1)
        bits_per_component = get(key=LZW.BITS_PER_COMPONENT, default=8)
        return columns, colors, bits_per_component

    @staticmethod
    def _decode_png_prediction(data: bytes, columns: int, rowlength: int) -> bytes:
        # PNG prediction can vary from row to row
        if (remainder := len(data) % rowlength) != 0:
            logger_warning("Image data is not rectangular. Adding padding.", __name__)
            data += b"\x00" * (rowlength - remainder)
            assert len(data) % rowlength == 0
        output = []
        prev_rowdata = (0,) * rowlength
        bpp = (rowlength - 1) // columns  # recomputed locally to not change params
        for row in range(0, len(data), rowlength):
            rowdata: list[int] = list(data[row : row + rowlength])
            filter_byte = rowdata[0]

            if filter_byte == 0:
                # PNG None Predictor
                pass
            elif filter_byte == 1:
                # PNG Sub Predictor
                for i in range(bpp + 1, rowlength):
                    rowdata[i] = (rowdata[i] + rowdata[i - bpp]) % 256
            elif filter_byte == 2:
                # PNG Up Predictor
                for i in range(1, rowlength):
                    rowdata[i] = (rowdata[i] + prev_rowdata[i]) % 256
            elif filter_byte == 3:
                # PNG Average Predictor
                for i in range(1, bpp + 1):
                    floor = prev_rowdata[i] // 2
                    rowdata[i] = (rowdata[i] + floor) % 256
                for i in range(bpp + 1, rowlength):
                    left = rowdata[i - bpp]
                    floor = (left + prev_rowdata[i]) // 2
                    rowdata[i] = (rowdata[i] + floor) % 256
            elif filter_byte == 4:
                # PNG Paeth Predictor
                for i in range(1, bpp + 1):
                    rowdata[i] = (rowdata[i] + prev_rowdata[i]) % 256
                for i in range(bpp + 1, rowlength):
                    left = rowdata[i - bpp]
                    up = prev_rowdata[i]
                    up_left = prev_rowdata[i - bpp]

                    p = left + up - up_left
                    dist_left = abs(p - left)
                    dist_up = abs(p - up)
                    dist_up_left = abs(p - up_left)

                    if dist_left <= dist_up and dist_left <= dist_up_left:
                        paeth = left
                    elif dist_up <= dist_up_left:
                        paeth = up
                    else:
                        paeth = up_left

                    rowdata[i] = (rowdata[i] + paeth) % 256
            else:
                raise PdfReadError(
                    f"Unsupported PNG filter {filter_byte!r}"
                )  # pragma: no cover
            prev_rowdata = tuple(rowdata)
            output.extend(rowdata[1:])
        return bytes(output)

    @staticmethod
    def encode(data: bytes, level: int = -1) -> bytes:
        """
        Compress the input data using zlib.

        Args:
            data: The data to be compressed.
            level: See https://docs.python.org/3/library/zlib.html#zlib.compress

        Returns:
            The compressed data.

        """
        return zlib.compress(data, level)


class ASCIIHexDecode:
    """
    The ASCIIHexDecode filter decodes data that has been encoded in ASCII
    hexadecimal form into a base-7 ASCII format.
    """

    @staticmethod
    def decode(
        data: Union[str, bytes],
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decode an ASCII-Hex encoded data stream.

        Args:
          data: a str sequence of hexadecimal-encoded values to be
            converted into a base-7 ASCII string
          decode_parms: this filter does not use parameters.

        Returns:
          A string conversion in base-7 ASCII, where each of its values
          v is such that 0 <= ord(v) <= 127.

        Raises:
          PdfStreamError:

        """
        if isinstance(data, str):
            data = data.encode()

        # Stop at EOD
        eod = data.find(b">")
        if eod == -1:
            logger_warning(
                "missing EOD in ASCIIHexDecode, check if output is OK",
                __name__,
            )
            hex_data = data
        else:
            hex_data = data[:eod]

        # Remove whitespace
        hex_data = b"".join(hex_data.split())

        # Pad if odd length
        if len(hex_data) % 2 == 1:
            hex_data += b"0"

        return binascii.unhexlify(hex_data)


class RunLengthDecode:
    """
    The RunLengthDecode filter decodes data that has been encoded in a
    simple byte-oriented format based on run length.
    The encoded data is a sequence of runs, where each run consists of
    a length byte followed by 1 to 128 bytes of data. If the length byte is
    in the range 0 to 127,
    the following length + 1 (1 to 128) bytes are copied literally during
    decompression.
    If length is in the range 129 to 255, the following single byte is to be
    copied 257 − length (2 to 128) times during decompression. A length value
    of 128 denotes EOD.
    """

    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decode a run length encoded data stream.

        Args:
          data: a bytes sequence of length/data
          decode_parms: this filter does not use parameters.

        Returns:
          A bytes decompressed sequence.

        Raises:
          PdfStreamError:

        """
        lst = []
        index = 0
        data_length = len(data)
        total_length = 0
        while True:
            if index >= data_length:
                logger_warning(
                    "missing EOD in RunLengthDecode, check if output is OK", __name__
                )
                break  # Reached end of string without an EOD
            length = data[index]
            index += 1
            if length == 128:
                if index < data_length:
                    # We should first check, if we have an inner stream from a multi-encoded
                    # stream with a faulty trailing newline that we can decode properly.
                    # We will just ignore the last byte and raise a warning ...
                    if (index == data_length - 1) and (data[index : index + 1] == b"\n"):
                        logger_warning(
                            "Found trailing newline in stream data, check if output is OK", __name__
                        )
                        break
                    # Raising an exception here breaks all image extraction for this file, which might
                    # not be desirable. For this reason, indicate that the output is most likely wrong,
                    # as processing stopped after the first EOD marker. See issue #3517.
                    logger_warning(
                        "Early EOD in RunLengthDecode, check if output is OK", __name__
                    )
                break
            if length < 128:
                length += 1
                lst.append(data[index : (index + length)])
                index += length
            else:  # >128
                length = 257 - length
                lst.append(bytes((data[index],)) * length)
                index += 1
            total_length += length
            if total_length > RUN_LENGTH_MAX_OUTPUT_LENGTH:
                raise LimitReachedError("Limit reached while decompressing.")
        return b"".join(lst)


class LZWDecode:
    class Decoder:
        STOP = 257
        CLEARDICT = 256

        def __init__(self, data: bytes) -> None:
            self.data = data

        def decode(self) -> bytes:
            return _LzwCodec(max_output_length=LZW_MAX_OUTPUT_LENGTH).decode(self.data)

    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decode an LZW encoded data stream.

        Args:
          data: ``bytes`` or ``str`` text to decode.
          decode_parms: a dictionary of parameter values.

        Returns:
          decoded data.

        """
        # decode_parms is unused here
        return LZWDecode.Decoder(data).decode()


class ASCII85Decode:
    """Decodes string ASCII85-encoded data into a byte format."""

    @staticmethod
    def decode(
        data: Union[str, bytes],
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decode an Ascii85 encoded data stream.

        Args:
          data: ``bytes`` or ``str`` text to decode.
          decode_parms: this filter does not use parameters.

        Returns:
          decoded data.

        """
        if isinstance(data, str):
            data = data.encode()
        data = data.strip(WHITESPACES_AS_BYTES)
        if len(data) > 2 and data.endswith(b">"):
            data = data[:-1].rstrip(WHITESPACES_AS_BYTES) + data[-1:]
        try:
            return a85decode(data, adobe=True, ignorechars=WHITESPACES_AS_BYTES)
        except ValueError as error:
            if error.args[0] == "Ascii85 encoded byte sequences must end with b'~>'":
                logger_warning("Ignoring missing Ascii85 end marker.", __name__)
                return a85decode(data, adobe=False, ignorechars=WHITESPACES_AS_BYTES)
            raise


class DCTDecode:
    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decompresses data encoded using a DCT (discrete cosine transform)
        technique based on the JPEG standard (IS0/IEC 10918),
        reproducing image sample data that approximates the original data.

        Args:
          data: text to decode.
          decode_parms: this filter does not use parameters.

        Returns:
          decoded data.

        """
        return data


class JPXDecode:
    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        """
        Decompresses data encoded using the wavelet-based JPEG 2000 standard,
        reproducing the original image data.

        Args:
          data: text to decode.
          decode_parms: this filter does not use parameters.

        Returns:
          decoded data.

        """
        return data


@dataclass
class CCITTParameters:
    """§7.4.6, optional parameters for the CCITTFaxDecode filter."""

    K: int = 0
    columns: int = 1728
    rows: int = 0
    EndOfLine: Union[bool, None] = False
    EncodedByteAlign: Union[bool, None] = False
    EndOfBlock: Union[bool, None] = True
    BlackIs1: bool = False
    DamagedRowsBeforeError: Union[int, None] = 0

    @property
    def group(self) -> int:
        if self.K < 0:
            # Pure two-dimensional encoding (Group 4)
            CCITTgroup = 4
        else:
            # K == 0: Pure one-dimensional encoding (Group 3, 1-D)
            # K > 0: Mixed one- and two-dimensional encoding (Group 3, 2-D)
            CCITTgroup = 3
        return CCITTgroup


def __create_old_class_instance(
    K: int = 0,
    columns: int = 0,
    rows: int = 0
) -> CCITTParameters:
    deprecation_with_replacement("CCITParameters", "CCITTParameters", "6.0.0")
    return CCITTParameters(K, columns, rows)


# Create an alias for the old class name
CCITParameters = __create_old_class_instance


class CCITTFaxDecode:
    """
    §7.4.6, CCITTFaxDecode filter (ISO 32000).

    Either Group 3 or Group 4 CCITT facsimile (fax) encoding.
    CCITT encoding is bit-oriented, not byte-oriented.

    §7.4.6, optional parameters for the CCITTFaxDecode filter.
    """

    @staticmethod
    def _get_parameters(
        parameters: Union[None, ArrayObject, DictionaryObject, IndirectObject],
        rows: Union[int, IndirectObject],
    ) -> CCITTParameters:
        ccitt_parameters = CCITTParameters(rows=int(rows))
        if parameters:
            parameters_unwrapped = cast(
                Union[ArrayObject, DictionaryObject], parameters.get_object()
            )
            if isinstance(parameters_unwrapped, ArrayObject):
                for decode_parm in parameters_unwrapped:
                    if CCITT.K in decode_parm:
                        ccitt_parameters.K = decode_parm[CCITT.K].get_object()
                    if CCITT.COLUMNS in decode_parm:
                        ccitt_parameters.columns = decode_parm[CCITT.COLUMNS].get_object()
                    if CCITT.BLACK_IS_1 in decode_parm:
                        ccitt_parameters.BlackIs1 = decode_parm[CCITT.BLACK_IS_1].get_object().value
            else:
                if CCITT.K in parameters_unwrapped:
                    ccitt_parameters.K = parameters_unwrapped[CCITT.K].get_object()  # type: ignore
                if CCITT.COLUMNS in parameters_unwrapped:
                    ccitt_parameters.columns = parameters_unwrapped[CCITT.COLUMNS].get_object()  # type: ignore
                if CCITT.BLACK_IS_1 in parameters_unwrapped:
                    ccitt_parameters.BlackIs1 = parameters_unwrapped[CCITT.BLACK_IS_1].get_object().value  # type: ignore
        return ccitt_parameters

    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        height: int = 0,
        **kwargs: Any,
    ) -> bytes:
        params = CCITTFaxDecode._get_parameters(decode_parms, height)

        img_size = len(data)
        tiff_header_struct = "<2shlh" + "hhll" * 8 + "h"
        tiff_header = struct.pack(
            tiff_header_struct,
            b"II",  # Byte order indication: Little endian
            42,     # Version number (always 42)
            8,      # Offset to the first image file directory (IFD)
            8,      # Number of tags in IFD
            256,    # ImageWidth, LONG, 1, width
            4,
            1,
            params.columns,
            257,    # ImageLength, LONG, 1, length
            4,
            1,
            params.rows,
            258,    # BitsPerSample, SHORT, 1, 1
            3,
            1,
            1,
            259,    # Compression, SHORT, 1, compression Type
            3,
            1,
            params.group,
            262,    # Thresholding, SHORT, 1, 0 = BlackIs1
            3,
            1,
            int(params.BlackIs1),
            273,    # StripOffsets, LONG, 1, length of header
            4,
            1,
              struct.calcsize(
                tiff_header_struct
            ),
            278,    # RowsPerStrip, LONG, 1, length
            4,
            1,
            params.rows,
            279,    # StripByteCounts, LONG, 1, size of image
            4,
            1,
            img_size,
            0,      # last IFD
        )

        return tiff_header + data


JBIG2DEC_BINARY = shutil.which("jbig2dec")


class JBIG2Decode:
    @staticmethod
    def decode(
        data: bytes,
        decode_parms: Optional[DictionaryObject] = None,
        **kwargs: Any,
    ) -> bytes:
        if JBIG2DEC_BINARY is None:
            raise DependencyError("jbig2dec binary is not available.")

        with TemporaryDirectory() as tempdir:
            directory = Path(tempdir)
            paths: list[Path] = []

            if decode_parms and "/JBIG2Globals" in decode_parms:
                jbig2_globals = decode_parms["/JBIG2Globals"]
                if not is_null_or_none(jbig2_globals) and not is_null_or_none(pointer := jbig2_globals.get_object()):
                    assert pointer is not None, "mypy"
                    if isinstance(pointer, StreamObject):
                        path = directory.joinpath("globals.jbig2")
                        path.write_bytes(pointer.get_data())
                        paths.append(path)

            path = directory.joinpath("image.jbig2")
            path.write_bytes(data)
            paths.append(path)

            environment = os.environ.copy()
            environment["LC_ALL"] = "C"
            result = subprocess.run(  # noqa: S603
                [
                    JBIG2DEC_BINARY,
                    "--embedded",
                    "--format", "png",
                    "--output", "-",
                    "-M", str(JBIG2_MAX_OUTPUT_LENGTH),
                    *paths
                ],
                capture_output=True,
                env=environment,
            )
            if b"unrecognized option '--embedded'" in result.stderr or b"unrecognized option '-M'" in result.stderr:
                raise DependencyError("jbig2dec>=0.19 is required.")
            if b"FATAL ERROR failed to allocate image data buffer" in result.stderr:
                raise LimitReachedError(
                    f"Memory limit reached while reading JBIG2 data:\n{result.stderr.decode('utf-8')}"
                )
            if result.stderr:
                for line in result.stderr.decode("utf-8").splitlines():
                    logger_warning(line, __name__)
            if result.returncode != 0:
                raise PdfStreamError(f"Unable to decode JBIG2 data. Exit code: {result.returncode}")
        return result.stdout

    @staticmethod
    def _is_binary_compatible() -> bool:
        if not JBIG2DEC_BINARY:  # pragma: no cover
            return False
        result = subprocess.run(  # noqa: S603
            [JBIG2DEC_BINARY, "--version"],
            capture_output=True,
            text=True,
        )
        version = result.stdout.split(" ", maxsplit=1)[1]

        from ._utils import Version  # noqa: PLC0415
        return Version(version) >= Version("0.19")


def _deprecate_inline_image_filters(filter_name: str, old_name: str, new_name: str) -> None:
    if filter_name != old_name:
        return
    deprecate(
        f"The filter name {old_name} is deprecated and will be removed in pypdf 7.0.0. Use {new_name} instead.",
        4,
    )


def decode_stream_data(stream: StreamObject) -> bytes:
    """
    Decode the stream data based on the specified filters.

    This function decodes the stream data using the filters provided in the
    stream.

    Args:
        stream: The input stream object containing the data and filters.

    Returns:
        The decoded stream data.

    Raises:
        NotImplementedError: If an unsupported filter type is encountered.

    """
    filters = stream.get(SA.FILTER, ())
    if isinstance(filters, IndirectObject):
        filters = cast(ArrayObject, filters.get_object())
    if not isinstance(filters, ArrayObject):
        # We have a single filter instance
        filters = (filters,)
    decode_parms = stream.get(SA.DECODE_PARMS, ({},) * len(filters))
    if not isinstance(decode_parms, (list, tuple)):
        decode_parms = (decode_parms,)
    data: bytes = stream._data
    # If there is no data to decode, we should not try to decode it.
    if not data:
        return data
    for filter_name, params in zip(filters, decode_parms):
        if isinstance(params, NullObject):
            params = {}
        if filter_name in (FT.ASCII_HEX_DECODE, FTA.AHx):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.AHx, new_name=FT.ASCII_HEX_DECODE)
            data = ASCIIHexDecode.decode(data)
        elif filter_name in (FT.ASCII_85_DECODE, FTA.A85):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.A85, new_name=FT.ASCII_85_DECODE)
            data = ASCII85Decode.decode(data)
        elif filter_name in (FT.LZW_DECODE, FTA.LZW):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.LZW, new_name=FT.LZW_DECODE)
            data = LZWDecode.decode(data, params)
        elif filter_name in (FT.FLATE_DECODE, FTA.FL):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.FL, new_name=FT.FLATE_DECODE)
            data = FlateDecode.decode(data, params)
        elif filter_name in (FT.RUN_LENGTH_DECODE, FTA.RL):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.RL, new_name=FT.RUN_LENGTH_DECODE)
            data = RunLengthDecode.decode(data)
        elif filter_name in (FT.CCITT_FAX_DECODE, FTA.CCF):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.CCF, new_name=FT.CCITT_FAX_DECODE)
            height = stream.get(IA.HEIGHT, ())
            data = CCITTFaxDecode.decode(data, params, height)
        elif filter_name in (FT.DCT_DECODE, FTA.DCT):
            _deprecate_inline_image_filters(filter_name=filter_name, old_name=FTA.DCT, new_name=FT.DCT_DECODE)
            data = DCTDecode.decode(data)
        elif filter_name == FT.JPX_DECODE:
            data = JPXDecode.decode(data)
        elif filter_name == FT.JBIG2_DECODE:
            data = JBIG2Decode.decode(data, params)
        elif filter_name == "/Crypt":
            if "/Name" in params or "/Type" in params:
                raise NotImplementedError(
                    "/Crypt filter with /Name or /Type not supported yet"
                )
        else:
            raise NotImplementedError(f"Unsupported filter {filter_name}")
    return data
