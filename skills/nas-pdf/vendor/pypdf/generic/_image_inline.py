# Copyright (c) 2024, pypdf contributors
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

import logging
from io import BytesIO
from typing import IO

from .._utils import (
    WHITESPACES,
    WHITESPACES_AS_BYTES,
    StreamType,
    logger_warning,
    read_non_whitespace,
)
from ..errors import PdfReadError

logger = logging.getLogger(__name__)

# An inline image should be used only for small images (4096 bytes or less),
# but allow twice this for cases where this has been exceeded.
BUFFER_SIZE = 8192


def _check_end_image_marker(stream: StreamType) -> bool:
    ei_tok = read_non_whitespace(stream)
    ei_tok += stream.read(2)
    stream.seek(-3, 1)
    return ei_tok[:2] == b"EI" and (ei_tok[2:3] == b"" or ei_tok[2:3] in WHITESPACES)


def extract_inline__ascii_hex_decode(stream: StreamType) -> bytes:
    """
    Extract HexEncoded stream from inline image.
    The stream will be moved onto the EI.
    """
    data_out: bytes = b""
    # Read data until delimiter > and EI as backup.
    while True:
        data_buffered = read_non_whitespace(stream) + stream.read(BUFFER_SIZE)
        if not data_buffered:
            raise PdfReadError("Unexpected end of stream")
        pos_tok = data_buffered.find(b">")
        if pos_tok >= 0:  # found >
            data_out += data_buffered[: pos_tok + 1]
            stream.seek(-len(data_buffered) + pos_tok + 1, 1)
            break
        pos_ei = data_buffered.find(b"EI")
        if pos_ei >= 0:  # found EI
            stream.seek(-len(data_buffered) + pos_ei - 1, 1)
            c = stream.read(1)
            while c in WHITESPACES:
                stream.seek(-2, 1)
                c = stream.read(1)
                pos_ei -= 1
            data_out += data_buffered[:pos_ei]
            break
        if len(data_buffered) == 2:
            data_out += data_buffered
            raise PdfReadError("Unexpected end of stream")
        # Neither > nor EI found
        data_out += data_buffered[:-2]
        stream.seek(-2, 1)

    if not _check_end_image_marker(stream):
        raise PdfReadError("EI stream not found")
    return data_out


def extract_inline__ascii85_decode(stream: StreamType) -> bytes:
    """
    Extract A85 stream from inline image.
    The stream will be moved onto the EI.
    """
    data_out: bytes = b""
    # Read data until delimiter ~>
    while True:
        data_buffered = read_non_whitespace(stream) + stream.read(BUFFER_SIZE)
        if not data_buffered:
            raise PdfReadError("Unexpected end of stream")
        pos_tok = data_buffered.find(b"~>")
        if pos_tok >= 0:  # found!
            data_out += data_buffered[: pos_tok + 2]
            stream.seek(-len(data_buffered) + pos_tok + 2, 1)
            break
        if len(data_buffered) == 2:  # end of buffer
            data_out += data_buffered
            raise PdfReadError("Unexpected end of stream")
        data_out += data_buffered[
            :-2
        ]  # back by one char in case of in the middle of ~>
        stream.seek(-2, 1)

    if not _check_end_image_marker(stream):
        raise PdfReadError("EI stream not found")
    return data_out


def extract_inline__run_length_decode(stream: StreamType) -> bytes:
    """
    Extract RL (RunLengthDecode) stream from inline image.
    The stream will be moved onto the EI.
    """
    data_out: bytes = b""
    # Read data until delimiter 128
    while True:
        data_buffered = stream.read(BUFFER_SIZE)
        if not data_buffered:
            raise PdfReadError("Unexpected end of stream")
        pos_tok = data_buffered.find(b"\x80")
        if pos_tok >= 0:  # found
            # Ideally, we could just use plain run-length decoding here, where 80_16 = 128_10
            # marks the EOD. But there apparently are cases like in issue #3517, where we have
            # an inline image with up to 51 EOD markers. In these cases, be resilient here and
            # use the default `EI` marker detection instead. Please note that this fallback
            # still omits special `EI` handling within the stream, but for now assume that having
            # both of these cases occur at the same time is very unlikely (and the image stream
            # is broken anyway).
            # For now, do not skip over more than one whitespace character.
            after_token = data_buffered[pos_tok + 1 : pos_tok + 4]
            if after_token.startswith(b"EI") or after_token.endswith(b"EI"):
                data_out += data_buffered[: pos_tok + 1]
                stream.seek(-len(data_buffered) + pos_tok + 1, 1)
            else:
                logger_warning("Early EOD in RunLengthDecode of inline image, using fallback.", __name__)
                ei_marker = data_buffered.find(b"EI")
                if ei_marker > 0:
                    data_out += data_buffered[: ei_marker]
                    stream.seek(-len(data_buffered) + ei_marker - 1, 1)
            break
        data_out += data_buffered

    if not _check_end_image_marker(stream):
        raise PdfReadError("EI stream not found")
    return data_out


def extract_inline__dct_decode(stream: StreamType) -> bytes:
    """
    Extract DCT (JPEG) stream from inline image.
    The stream will be moved onto the EI.
    """
    def read(length: int) -> bytes:
        # If 0 bytes are returned, and *size* was not 0, this indicates end of file.
        # If the object is in non-blocking mode and no bytes are available, `None` is returned.
        _result = stream.read(length)
        if _result is None or len(_result) != length:
            raise PdfReadError("Unexpected end of stream")
        return _result

    data_out: bytes = b""
    # Read Blocks of data (ID/Size/data) up to ID=FF/D9
    # https://www.digicamsoft.com/itu/itu-t81-36.html
    not_first = False
    while True:
        c = read(1)
        if not_first or (c == b"\xff"):
            data_out += c
        if c != b"\xff":
            continue
        not_first = True
        c = read(1)
        data_out += c
        if c == b"\xff":
            stream.seek(-1, 1)  # pragma: no cover
        elif c == b"\x00":  # stuffing
            pass
        elif c == b"\xd9":  # end
            break
        elif c in (
            b"\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc9\xca\xcb\xcc\xcd\xce\xcf"
            b"\xda\xdb\xdc\xdd\xde\xdf"
            b"\xe0\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xeb\xec\xed\xee\xef\xfe"
        ):
            c = read(2)
            data_out += c
            sz = c[0] * 256 + c[1]
            data_out += read(sz - 2)

    if not _check_end_image_marker(stream):
        raise PdfReadError("EI stream not found")
    return data_out


def extract_inline_default(stream: StreamType) -> bytes:
    """Legacy method, used by default"""
    stream_out = BytesIO()
    # Read the inline image, while checking for EI (End Image) operator.
    while True:
        data_buffered = stream.read(BUFFER_SIZE)
        if not data_buffered:
            raise PdfReadError("Unexpected end of stream")
        pos_ei = data_buffered.find(
            b"E"
        )  # We can not look straight for "EI" because it may not have been loaded in the buffer

        if pos_ei == -1:
            stream_out.write(data_buffered)
        else:
            # Write out everything including E (the one from EI to be removed)
            stream_out.write(data_buffered[0 : pos_ei + 1])
            sav_pos_ei = stream_out.tell() - 1
            # Seek back in the stream to read the E next
            stream.seek(pos_ei + 1 - len(data_buffered), 1)
            saved_pos = stream.tell()
            # Check for End Image
            tok2 = stream.read(1)  # I of "EI"
            if tok2 != b"I":
                stream.seek(saved_pos, 0)
                continue
            tok3 = stream.read(1)  # possible space after "EI"
            if tok3 not in WHITESPACES:
                stream.seek(saved_pos, 0)
                continue
            while tok3 in WHITESPACES:
                tok3 = stream.read(1)
            if data_buffered[pos_ei - 1 : pos_ei] not in WHITESPACES and tok3 not in {
                b"Q",
                b"E",
            }:  # for Q or EMC
                stream.seek(saved_pos, 0)
                continue
            if is_followed_by_binary_data(stream):
                # Inline image contains `EI ` sequence usually marking the end of it, but
                # is followed by binary data which does not make sense for the actual end.
                stream.seek(saved_pos, 0)
                continue
            # Data contains [\s]EI[\s](Q|EMC): 4 chars are sufficient
            # remove E(I) wrongly inserted earlier
            stream.seek(saved_pos - 1, 0)
            stream_out.truncate(sav_pos_ei)
            break

    return stream_out.getvalue()


def is_followed_by_binary_data(stream: IO[bytes], length: int = 10) -> bool:
    """
    Check if the next bytes of the stream look like binary image data or regular page content.

    This is just some heuristics due to the PDF specification being too imprecise about
    inline images containing the `EI` marker which would end an image. Starting with PDF 2.0,
    we finally get a mandatory length field, but with (proper) PDF 2.0 support being very limited
    everywhere, we should not expect to be able to remove such hacks in the near future - especially
    considering legacy documents as well.

    The actual implementation draws some inspiration from
    https://github.com/itext/itext-java/blob/9.1.0/kernel/src/main/java/com/itextpdf/kernel/pdf/canvas/parser/util/InlineImageParsingUtils.java
    """
    position = stream.tell()
    data = stream.read(length)
    stream.seek(position)
    if not data:
        return False
    operator_start = None
    operator_end = None

    for index, byte in enumerate(data):
        if byte < 32 and byte not in WHITESPACES_AS_BYTES:
            # This covers all characters not being displayable directly, although omitting whitespace
            # to allow for operator detection.
            return True
        is_whitespace = byte in WHITESPACES_AS_BYTES
        if operator_start is None and not is_whitespace:
            # Interpret all other non-whitespace characters as the start of an operation.
            operator_start = index
        if operator_start is not None and is_whitespace:
            # A whitespace stops an operation.
            # Assume that having an inline image with tons of whitespace is rather unlikely.
            operator_end = index
            break

    if operator_start is None:
        # Inline images should not have tons of whitespaces, which would lead to no operator start.
        return False
    if operator_end is None:
        # We probably are inside an operation.
        operator_end = length
    operator_length = operator_end - operator_start
    operator = data[operator_start:operator_end]
    if operator.startswith(b"/") and operator_length > 1:
        # Name object.
        return False
    if operator.replace(b".", b"").isdigit():
        # Graphics operator, for example a move. A number (integer or float).
        return False
    if operator_length > 3:  # noqa: SIM103
        # Usually, the operators inside a content stream should not have more than three characters,
        # especially after an inline image.
        return True
    return False
