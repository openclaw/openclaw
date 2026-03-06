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

from pypdf._crypt_providers._base import CryptBase, CryptIdentity

try:
    from pypdf._crypt_providers._cryptography import (
        CryptAES,
        CryptRC4,
        aes_cbc_decrypt,
        aes_cbc_encrypt,
        aes_ecb_decrypt,
        aes_ecb_encrypt,
        crypt_provider,
        rc4_decrypt,
        rc4_encrypt,
    )
    from pypdf._utils import Version

    if Version(crypt_provider[1]) <= Version("3.0"):
        # This is due to the backend parameter being required back then:
        # https://cryptography.io/en/latest/changelog/#v3-1
        raise ImportError("cryptography<=3.0 is not supported")  # pragma: no cover
except ImportError:
    try:
        from pypdf._crypt_providers._pycryptodome import (  # type: ignore
            CryptAES,
            CryptRC4,
            aes_cbc_decrypt,
            aes_cbc_encrypt,
            aes_ecb_decrypt,
            aes_ecb_encrypt,
            crypt_provider,
            rc4_decrypt,
            rc4_encrypt,
        )
    except ImportError:
        from pypdf._crypt_providers._fallback import (  # type: ignore
            CryptAES,
            CryptRC4,
            aes_cbc_decrypt,
            aes_cbc_encrypt,
            aes_ecb_decrypt,
            aes_ecb_encrypt,
            crypt_provider,
            rc4_decrypt,
            rc4_encrypt,
        )

__all__ = [
    "CryptAES",
    "CryptBase",
    "CryptIdentity",
    "CryptRC4",
    "aes_cbc_decrypt",
    "aes_cbc_encrypt",
    "aes_ecb_decrypt",
    "aes_ecb_encrypt",
    "crypt_provider",
    "rc4_decrypt",
    "rc4_encrypt",
]
