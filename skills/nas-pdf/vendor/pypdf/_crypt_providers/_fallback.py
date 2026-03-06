# Copyright (c) 2023, exiledkingcc
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

from pypdf._crypt_providers._base import CryptBase
from pypdf.errors import DependencyError

_DEPENDENCY_ERROR_STR = "cryptography>=3.1 is required for AES algorithm"


crypt_provider = ("local_crypt_fallback", "0.0.0")


class CryptRC4(CryptBase):
    def __init__(self, key: bytes) -> None:
        self.s = bytearray(range(256))
        j = 0
        for i in range(256):
            j = (j + self.s[i] + key[i % len(key)]) % 256
            self.s[i], self.s[j] = self.s[j], self.s[i]

    def encrypt(self, data: bytes) -> bytes:
        s = bytearray(self.s)
        out = [0 for _ in range(len(data))]
        i, j = 0, 0
        for k in range(len(data)):
            i = (i + 1) % 256
            j = (j + s[i]) % 256
            s[i], s[j] = s[j], s[i]
            x = s[(s[i] + s[j]) % 256]
            out[k] = data[k] ^ x
        return bytes(out)

    def decrypt(self, data: bytes) -> bytes:
        return self.encrypt(data)


class CryptAES(CryptBase):
    def __init__(self, key: bytes) -> None:
        pass

    def encrypt(self, data: bytes) -> bytes:
        raise DependencyError(_DEPENDENCY_ERROR_STR)

    def decrypt(self, data: bytes) -> bytes:
        raise DependencyError(_DEPENDENCY_ERROR_STR)


def rc4_encrypt(key: bytes, data: bytes) -> bytes:
    return CryptRC4(key).encrypt(data)


def rc4_decrypt(key: bytes, data: bytes) -> bytes:
    return CryptRC4(key).decrypt(data)


def aes_ecb_encrypt(key: bytes, data: bytes) -> bytes:
    raise DependencyError(_DEPENDENCY_ERROR_STR)


def aes_ecb_decrypt(key: bytes, data: bytes) -> bytes:
    raise DependencyError(_DEPENDENCY_ERROR_STR)


def aes_cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    raise DependencyError(_DEPENDENCY_ERROR_STR)


def aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    raise DependencyError(_DEPENDENCY_ERROR_STR)
