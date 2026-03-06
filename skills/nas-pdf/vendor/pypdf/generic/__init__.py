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

"""Implementation of generic PDF objects (dictionary, number, string, ...)."""
__author__ = "Mathieu Fenniak"
__author_email__ = "biziqe@mathieu.fenniak.net"

from ..constants import OutlineFontFlag
from ._base import (
    BooleanObject,
    ByteStringObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NullObject,
    NumberObject,
    PdfObject,
    TextStringObject,
    encode_pdfdocencoding,
    is_null_or_none,
)
from ._data_structures import (
    ArrayObject,
    ContentStream,
    DecodedStreamObject,
    Destination,
    DictionaryObject,
    EncodedStreamObject,
    Field,
    StreamObject,
    TreeObject,
    read_object,
)
from ._files import EmbeddedFile
from ._fit import Fit
from ._link import DirectReferenceLink, NamedReferenceLink, ReferenceLink, extract_links
from ._outline import OutlineItem
from ._rectangle import RectangleObject
from ._utils import (
    create_string_object,
    decode_pdfdocencoding,
    hex_to_rgb,
    read_hex_string_from_stream,
    read_string_from_stream,
)
from ._viewerpref import ViewerPreferences

PAGE_FIT = Fit.fit()


__all__ = [
    "PAGE_FIT",
    "ArrayObject",
    "BooleanObject",
    "ByteStringObject",
    "ContentStream",
    "DecodedStreamObject",
    "Destination",
    "DictionaryObject",
    "DirectReferenceLink",
    "EmbeddedFile",
    "EncodedStreamObject",
    "Field",
    "Fit",
    "FloatObject",
    "IndirectObject",
    "NameObject",
    "NamedReferenceLink",
    "NullObject",
    "NumberObject",
    "OutlineFontFlag",
    "OutlineItem",
    "PdfObject",
    "RectangleObject",
    "ReferenceLink",
    "StreamObject",
    "TextStringObject",
    "TreeObject",
    "ViewerPreferences",
    # Utility functions
    "create_string_object",
    "decode_pdfdocencoding",
    "encode_pdfdocencoding",
    "extract_links",
    "hex_to_rgb",
    "is_null_or_none",
    "read_hex_string_from_stream",
    # Data structures core functions
    "read_object",
    "read_string_from_stream",
]
