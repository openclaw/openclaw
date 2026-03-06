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

import secrets

from cryptography import __version__
from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers.algorithms import AES

try:
    # 43.0.0 - https://cryptography.io/en/latest/changelog/#v43-0-0
    from cryptography.hazmat.decrepit.ciphers.algorithms import ARC4
except ImportError:
    from cryptography.hazmat.primitives.ciphers.algorithms import ARC4
from cryptography.hazmat.primitives.ciphers.base import Cipher
from cryptography.hazmat.primitives.ciphers.modes import CBC, ECB

from pypdf._crypt_providers._base import CryptBase

crypt_provider = ("cryptography", __version__)


class CryptRC4(CryptBase):
    def __init__(self, key: bytes) -> None:
        self.cipher = Cipher(ARC4(key), mode=None)

    def encrypt(self, data: bytes) -> bytes:
        encryptor = self.cipher.encryptor()
        return encryptor.update(data) + encryptor.finalize()

    def decrypt(self, data: bytes) -> bytes:
        decryptor = self.cipher.decryptor()
        return decryptor.update(data) + decryptor.finalize()


class CryptAES(CryptBase):
    def __init__(self, key: bytes) -> None:
        self.alg = AES(key)

    def encrypt(self, data: bytes) -> bytes:
        iv = secrets.token_bytes(16)
        pad = padding.PKCS7(128).padder()
        data = pad.update(data) + pad.finalize()

        cipher = Cipher(self.alg, CBC(iv))
        encryptor = cipher.encryptor()
        return iv + encryptor.update(data) + encryptor.finalize()

    def decrypt(self, data: bytes) -> bytes:
        iv = data[:16]
        data = data[16:]
        # for empty encrypted data
        if not data:
            return data

        # just for robustness, it does not happen under normal circumstances
        if len(data) % 16 != 0:
            pad = padding.PKCS7(128).padder()
            data = pad.update(data) + pad.finalize()

        cipher = Cipher(self.alg, CBC(iv))
        decryptor = cipher.decryptor()
        d = decryptor.update(data) + decryptor.finalize()
        return d[: -d[-1]]


def rc4_encrypt(key: bytes, data: bytes) -> bytes:
    encryptor = Cipher(ARC4(key), mode=None).encryptor()
    return encryptor.update(data) + encryptor.finalize()


def rc4_decrypt(key: bytes, data: bytes) -> bytes:
    decryptor = Cipher(ARC4(key), mode=None).decryptor()
    return decryptor.update(data) + decryptor.finalize()


def aes_ecb_encrypt(key: bytes, data: bytes) -> bytes:
    encryptor = Cipher(AES(key), mode=ECB()).encryptor()
    return encryptor.update(data) + encryptor.finalize()


def aes_ecb_decrypt(key: bytes, data: bytes) -> bytes:
    decryptor = Cipher(AES(key), mode=ECB()).decryptor()
    return decryptor.update(data) + decryptor.finalize()


def aes_cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    encryptor = Cipher(AES(key), mode=CBC(iv)).encryptor()
    return encryptor.update(data) + encryptor.finalize()


def aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    decryptor = Cipher(AES(key), mode=CBC(iv)).decryptor()
    return decryptor.update(data) + decryptor.finalize()
