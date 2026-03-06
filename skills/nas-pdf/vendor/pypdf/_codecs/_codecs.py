"""
This module is for codecs only.

While the codec implementation can contain details of the PDF specification,
the module should not do any PDF parsing.
"""

import io
from abc import ABC, abstractmethod

from pypdf._utils import logger_warning
from pypdf.errors import LimitReachedError


class Codec(ABC):
    """Abstract base class for all codecs."""

    @abstractmethod
    def encode(self, data: bytes) -> bytes:
        """
        Encode the input data.

        Args:
            data: Data to encode.

        Returns:
            Encoded data.

        """

    @abstractmethod
    def decode(self, data: bytes) -> bytes:
        """
        Decode the input data.

        Args:
            data: Data to decode.

        Returns:
            Decoded data.

        """


class LzwCodec(Codec):
    """Lempel-Ziv-Welch (LZW) adaptive compression codec."""

    CLEAR_TABLE_MARKER = 256  # Special code to indicate table reset
    EOD_MARKER = 257  # End-of-data marker
    INITIAL_BITS_PER_CODE = 9  # Initial code bit width
    MAX_BITS_PER_CODE = 12  # Maximum code bit width

    def __init__(self, max_output_length: int = 75_000_000) -> None:
        self.max_output_length = max_output_length

    def _initialize_encoding_table(self) -> None:
        """Initialize the encoding table and state to initial conditions."""
        self.encoding_table: dict[bytes, int] = {bytes([i]): i for i in range(256)}
        self.next_code = self.EOD_MARKER + 1
        self.bits_per_code = self.INITIAL_BITS_PER_CODE
        self.max_code_value = (1 << self.bits_per_code) - 1

    def _increase_next_code(self) -> None:
        """Update bits_per_code and max_code_value if necessary."""
        self.next_code += 1
        if (
            self.next_code > self.max_code_value
            and self.bits_per_code < self.MAX_BITS_PER_CODE
        ):
            self.bits_per_code += 1
            self.max_code_value = (1 << self.bits_per_code) - 1

    def encode(self, data: bytes) -> bytes:
        """
        Encode data using the LZW compression algorithm.

        Taken from PDF 1.7 specs, "7.4.4.2 Details of LZW Encoding".
        """
        result_codes: list[int] = []

        # The encoder shall begin by issuing a clear-table code
        result_codes.append(self.CLEAR_TABLE_MARKER)
        self._initialize_encoding_table()

        current_sequence = b""
        for byte in data:
            next_sequence = current_sequence + bytes([byte])

            if next_sequence in self.encoding_table:
                # Extend current sequence if already in the table
                current_sequence = next_sequence
            else:
                # Output code for the current sequence
                result_codes.append(self.encoding_table[current_sequence])

                # Add the new sequence to the table if there's room
                if self.next_code <= (1 << self.MAX_BITS_PER_CODE) - 1:
                    self.encoding_table[next_sequence] = self.next_code
                    self._increase_next_code()
                else:
                    # If the table is full, emit a clear-table command
                    result_codes.append(self.CLEAR_TABLE_MARKER)
                    self._initialize_encoding_table()

                # Start new sequence
                current_sequence = bytes([byte])

        # Ensure everything actually is encoded
        if current_sequence:
            result_codes.append(self.encoding_table[current_sequence])
        result_codes.append(self.EOD_MARKER)

        return self._pack_codes_into_bytes(result_codes)

    def _pack_codes_into_bytes(self, codes: list[int]) -> bytes:
        """
        Convert the list of result codes into a continuous byte stream, with codes packed as per the code bit-width.
        The bit-width starts at 9 bits and expands as needed.
        """
        self._initialize_encoding_table()
        buffer = 0
        bits_in_buffer = 0
        output = bytearray()

        for code in codes:
            buffer = (buffer << self.bits_per_code) | code
            bits_in_buffer += self.bits_per_code

            # Codes shall be packed into a continuous bit stream, high-order bit
            # first. This stream shall then be divided into bytes, high-order bit
            # first.
            while bits_in_buffer >= 8:
                bits_in_buffer -= 8
                output.append((buffer >> bits_in_buffer) & 0xFF)

            if code == self.CLEAR_TABLE_MARKER:
                self._initialize_encoding_table()
            elif code == self.EOD_MARKER:
                continue
            else:
                self._increase_next_code()

        # Flush any remaining bits in the buffer
        if bits_in_buffer > 0:
            output.append((buffer << (8 - bits_in_buffer)) & 0xFF)

        return bytes(output)

    def _initialize_decoding_table(self) -> None:
        self.max_code_value = (1 << self.MAX_BITS_PER_CODE) - 1
        self.decoding_table = [bytes([i]) for i in range(self.CLEAR_TABLE_MARKER)] + [
            b""
        ] * (self.max_code_value - self.CLEAR_TABLE_MARKER + 1)
        self._table_index = self.EOD_MARKER + 1
        self._bits_to_get = 9

    def _next_code_decode(self, data: bytes) -> int:
        self._next_data: int
        try:
            while self._next_bits < self._bits_to_get:
                self._next_data = (self._next_data << 8) | (
                    data[self._byte_pointer]
                )
                self._byte_pointer += 1
                self._next_bits += 8

            code = (
                self._next_data >> (self._next_bits - self._bits_to_get)
            ) & self._and_table[self._bits_to_get - 9]
            self._next_bits -= self._bits_to_get

            # Reduce data to get rid of the overhead,
            # which increases performance on large streams significantly.
            self._next_data = self._next_data & 0xFFFFF

            return code
        except IndexError:
            return self.EOD_MARKER

    # The following method has been converted to Python from PDFsharp:
    # https://github.com/empira/PDFsharp/blob/5fbf6ed14740bc4e16786816882d32e43af3ff5d/src/foundation/src/PDFsharp/src/PdfSharp/Pdf.Filters/LzwDecode.cs
    #
    # Original license:
    #
    # -------------------------------------------------------------------------
    # Copyright (c) 2001-2024 empira Software GmbH, Troisdorf (Cologne Area),
    # Germany
    #
    # http://docs.pdfsharp.net
    #
    # MIT License
    #
    # Permission is hereby granted, free of charge, to any person obtaining a
    # copy of this software and associated documentation files (the "Software"),
    # to deal in the Software without restriction, including without limitation
    # the rights to use, copy, modify, merge, publish, distribute, sublicense,
    # and/or sell copies of the Software, and to permit persons to whom the
    # Software is furnished to do so, subject to the following conditions:
    #
    # The above copyright notice and this permission notice shall be included
    # in all copies or substantial portions of the Software.
    #
    # THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    # IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    # FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
    # THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    # LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
    # FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
    # DEALINGS IN THE SOFTWARE.
    # --------------------------------------------------------------------------
    def decode(self, data: bytes) -> bytes:
        """
        The following code was converted to Python from the following code:
        https://github.com/empira/PDFsharp/blob/master/src/foundation/src/PDFsharp/src/PdfSharp/Pdf.Filters/LzwDecode.cs
        """
        self._and_table = [511, 1023, 2047, 4095]
        self._table_index = 0
        self._bits_to_get = 9
        self._byte_pointer = 0
        self._next_data = 0
        self._next_bits = 0

        output_stream = io.BytesIO()
        output_length = 0

        self._initialize_decoding_table()
        self._byte_pointer = 0
        self._next_data = 0
        self._next_bits = 0
        old_code = self.CLEAR_TABLE_MARKER

        while True:
            code = self._next_code_decode(data)
            if code == self.EOD_MARKER:
                break

            if code == self.CLEAR_TABLE_MARKER:
                self._initialize_decoding_table()
                code = self._next_code_decode(data)
                if code == self.EOD_MARKER:
                    break
                output_stream.write(decoded := self.decoding_table[code])
                old_code = code
            elif code < self._table_index:
                decoded = self.decoding_table[code]
                output_stream.write(decoded)
                if old_code != self.CLEAR_TABLE_MARKER:
                    self._add_entry_decode(self.decoding_table[old_code], decoded[0])
                old_code = code
            else:
                # The code is not in the table and not one of the special codes
                decoded = (
                    self.decoding_table[old_code] + self.decoding_table[old_code][:1]
                )
                output_stream.write(decoded)
                self._add_entry_decode(self.decoding_table[old_code], decoded[0])
                old_code = code

            output_length += len(decoded)
            if output_length > self.max_output_length:
                raise LimitReachedError(
                    f"Limit reached while decompressing: {output_length} > {self.max_output_length}"
                )

        return output_stream.getvalue()

    def _add_entry_decode(self, old_string: bytes, new_char: int) -> None:
        new_string = old_string + bytes([new_char])
        if self._table_index > self.max_code_value:
            logger_warning("Ignoring too large LZW table index.", __name__)
            return
        self.decoding_table[self._table_index] = new_string
        self._table_index += 1

        # Update the number of bits to get based on the table index
        if self._table_index == 511:
            self._bits_to_get = 10
        elif self._table_index == 1023:
            self._bits_to_get = 11
        elif self._table_index == 2047:
            self._bits_to_get = 12
