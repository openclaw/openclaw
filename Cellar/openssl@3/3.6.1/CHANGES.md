# OpenSSL CHANGES

This is a detailed breakdown of significant changes. For a high-level overview
of changes in each release, see [NEWS.md](./NEWS.md).

For a full list of changes, see the [git commit log][log] and pick the
appropriate release branch.

[log]: https://github.com/openssl/openssl/commits/

## OpenSSL Releases

- [OpenSSL 3.6](#openssl-36)
- [OpenSSL 3.5](#openssl-35)
- [OpenSSL 3.4](#openssl-34)
- [OpenSSL 3.3](#openssl-33)
- [OpenSSL 3.2](#openssl-32)
- [OpenSSL 3.1](#openssl-31)
- [OpenSSL 3.0](#openssl-30)
- [OpenSSL 1.1.1](#openssl-111)
- [OpenSSL 1.1.0](#openssl-110)
- [OpenSSL 1.0.2](#openssl-102)
- [OpenSSL 1.0.1](#openssl-101)
- [OpenSSL 1.0.0](#openssl-100)
- [OpenSSL 0.9.x](#openssl-09x)

## OpenSSL 3.6

### Changes between 3.6.0 and 3.6.1 [27 Jan 2026]

- Fixed Improper validation of PBMAC1 parameters in PKCS#12 MAC verification.

  Severity: Moderate

  Issue summary: PBMAC1 parameters in PKCS#12 files are missing validation
  which can trigger a stack-based buffer overflow, invalid pointer or NULL
  pointer dereference during MAC verification.

  Impact summary: The stack buffer overflow or NULL pointer dereference may
  cause a crash leading to Denial of Service for an application that parses
  untrusted PKCS#12 files. The buffer overflow may also potentially enable
  code execution depending on platform mitigations.

  Reported by: Stanislav Fort (Aisle Research) and Petr Šimeček (Aisle
  Research) and Hamza (Metadust)

  ([CVE-2025-11187])

  _Tomáš Mráz_

- Fixed Stack buffer overflow in CMS `AuthEnvelopedData` parsing.

  Severity: High

  Issue summary: Parsing CMS `AuthEnvelopedData` message with maliciously
  crafted AEAD parameters can trigger a stack buffer overflow.

  Impact summary: A stack buffer overflow may lead to a crash, causing Denial
  of Service, or potentially remote code execution.

  Reported by: Stanislav Fort (Aisle Research)

  ([CVE-2025-15467])

  _Igor Ustinov_

- Fixed NULL dereference in `SSL_CIPHER_find()` function on unknown cipher ID.

  Severity: Low

  Issue summary: If an application using the `SSL_CIPHER_find()` function
  in a QUIC protocol client or server receives an unknown cipher suite from
  the peer, a NULL dereference occurs.

  Impact summary: A NULL pointer dereference leads to abnormal termination
  of the running process causing Denial of Service.

  Reported by: Stanislav Fort (Aisle Research)

  ([CVE-2025-15468])

  _Stanislav Fort_

- Fixed `openssl dgst` one-shot codepath silently truncates inputs >16 MiB.

  Severity: Low

  Issue summary: The `openssl dgst` command-line tool silently truncates input
  data to 16 MiB when using one-shot signing algorithms and reports success
  instead of an error.

  Impact summary: A user signing or verifying files larger than 16 MiB with
  one-shot algorithms (such as Ed25519, Ed448, or ML-DSA) may believe the
  entire file is authenticated while trailing data beyond 16 MiB remains
  unauthenticated.

  Reported by: Stanislav Fort (Aisle Research)

  ([CVE-2025-15469])

  _Viktor Dukhovni_

- Fixed TLS 1.3 `CompressedCertificate` excessive memory allocation.

  Severity: Low

  Issue summary: A TLS 1.3 connection using certificate compression can be
  forced to allocate a large buffer before decompression without checking
  against the configured certificate size limit.

  Impact summary: An attacker can cause per-connection memory allocations
  of up to approximately 22 MiB and extra CPU work, potentially leading
  to service degradation or resource exhaustion (Denial of Service).

  Reported by: Tomas Dulka (Aisle Research) and Stanislav Fort (Aisle
  Research)

  ([CVE-2025-66199])

  _Tomas Dulka and Stanislav Fort_

- Fixed Heap out-of-bounds write in `BIO_f_linebuffer` on short writes.

  Severity: Low

  Issue summary: Writing large, newline-free data into a BIO chain using the
  line-buffering filter where the next BIO performs short writes can trigger
  a heap-based out-of-bounds write.

  Impact summary: This out-of-bounds write can cause memory corruption
  which typically results in a crash, leading to Denial of Service for
  an application.

  Reported by: Petr Simecek (Aisle Research) and Stanislav Fort (Aisle
  Research)

  ([CVE-2025-68160])

  _Stanislav Fort and Neil Horman_

- Fixed Unauthenticated/unencrypted trailing bytes with low-level OCB
  function calls.

  Severity: Low

  Issue summary: When using the low-level OCB API directly with AES-NI or
  other hardware-accelerated code paths, inputs whose length is not a multiple
  of 16 bytes can leave the final partial block unencrypted and
  unauthenticated.

  Impact summary: The trailing 1-15 bytes of a message may be exposed in
  cleartext on encryption and are not covered by the authentication tag,
  allowing an attacker to read or tamper with those bytes without detection.

  Reported by: Stanislav Fort (Aisle Research)

  ([CVE-2025-69418])

  _Stanislav Fort_

- Fixed Out of bounds write in `PKCS12_get_friendlyname()` UTF-8 conversion.

  Severity: Low

  Issue summary: Calling `PKCS12_get_friendlyname()` function on a maliciously
  crafted PKCS#12 file with a `BMPString` (UTF-16BE) friendly name containing
  non-ASCII BMP code point can trigger a one byte write before the allocated
  buffer.

  Impact summary: The out-of-bounds write can cause a memory corruption
  which can have various consequences including a Denial of Service.

  Reported by: Stanislav Fort (Aisle Research)

  ([CVE-2025-69419])

  _Norbert Pócs_

- Fixed Missing `ASN1_TYPE` validation in `TS_RESP_verify_response()` function.

  Severity: Low

  Issue summary: A type confusion vulnerability exists in the TimeStamp
  Response verification code where an `ASN1_TYPE` union member is accessed
  without first validating the type, causing an invalid or NULL pointer
  dereference when processing a malformed `TimeStamp` Response file.

  Impact summary: An application calling `TS_RESP_verify_response()`
  with a malformed TimeStamp Response can be caused to dereference an invalid
  or NULL pointer when reading, resulting in a Denial of Service.

  Reported by: Luigino Camastra (Aisle Research)

  ([CVE-2025-69420])

  _Bob Beck_

- Fixed NULL Pointer Dereference in `PKCS12_item_decrypt_d2i_ex()` function.

  Severity: Low

  Issue summary: Processing a malformed PKCS#12 file can trigger a NULL
  pointer dereference in the `PKCS12_item_decrypt_d2i_ex()` function.

  Impact summary: A NULL pointer dereference can trigger a crash which leads
  to Denial of Service for an application processing PKCS#12 files.

  Reported by: Luigino Camastra (Aisle Research)

  ([CVE-2025-69421])

  _Luigino Camastra_

- Fixed Missing `ASN1_TYPE` validation in PKCS#12 parsing.

  Severity: Low

  Issue summary: An invalid or NULL pointer dereference can happen in
  an application processing a malformed PKCS#12 file.

  Impact summary: An application processing a malformed PKCS#12 file can be
  caused to dereference an invalid or NULL pointer on memory read, resulting
  in a Denial of Service.

  Reported by: Luigino Camastra (Aisle Research)

  ([CVE-2026-22795])

  _Bob Beck_

- Fixed `ASN1_TYPE` Type Confusion in the `PKCS7_digest_from_attributes()`
  function.

  Severity: Low

  Issue summary: A type confusion vulnerability exists in the signature
  verification of signed PKCS#7 data where an `ASN1_TYPE` union member
  is accessed without first validating the type, causing an invalid or NULL
  pointer dereference when processing malformed PKCS#7 data.

  Impact summary: An application performing signature verification of PKCS#7
  data or calling directly the `PKCS7_digest_from_attributes()` function can be
  caused to dereference an invalid or NULL pointer when reading, resulting in
  a Denial of Service.

  Reported by: Luigino Camastra (Aisle Research)

  ([CVE-2026-22796])

  _Bob Beck_

- RISC-V capabilities string format has changed to include the base
  architecture and the vector length for the V extension.
  <!-- https://github.com/openssl/openssl/pull/28760 -->

  _Bernd Edlinger_

- Fixed a regression in `X509_V_FLAG_CRL_CHECK_ALL` flag handling by restoring
  its pre-3.6.0 behaviour of being ignored when `X509_V_FLAG_CRL_CHECK` flag
  is not set, and no longer implying the latter flag instead.
  <!-- https://github.com/openssl/openssl/pull/28797 -->

  _Carter Thaxton_

- Fixed a regression that caused generation of empty stapled OCSP responses
  when at least one certificate in the certificate chain had a stapled OCSP
  response present, causing handshake failures for OpenSSL 3.6.0 servers
  with various client implementations, including GnuTLS and BoringSSL.
  <!-- https://github.com/openssl/openssl/pull/28955 -->

  _Martin Rauch_

- Fixed exit code of `openssl x509` command with `-checkend` option in use.
  <!-- https://github.com/openssl/openssl/pull/29155 -->

  _Stefan Rieche_

- Fixed incorrect acceptance of some malformed ECDSA signatures on s390x.
  <!-- https://github.com/openssl/openssl/pull/29214 -->

  _Holger Dengler_

- Source code has been reformatted with `clang-format`.
  <!-- https://github.com/openssl/openssl/pull/29245 -->

  _Bob Beck_

- Reverted a change in behaviour of the single stapled OCSP response API
  with respect to the ownership of the OCSP response object that caused
  a memory leak.
  <!-- https://github.com/openssl/openssl/pull/29251 -->

  _Remi Gacogne and Tomáš Mráz_

### Changes between 3.5 and 3.6.0 [1 Oct 2025]

- Added support for `EVP_SKEY` opaque symmetric key objects to the key
  derivation and key exchange provider methods. Added
  `EVP_KDF_CTX_set_SKEY()`, `EVP_KDF_derive_SKEY()`,
  and `EVP_PKEY_derive_SKEY()` functions.

  _Dmitry Belyavskiy and Simo Sorce_

- Added PCT for key import for SLH-DSA when in FIPS mode.

  _Dr Paul Dale_

- Added `i2d_PKCS8PrivateKey(3)` API to complement `i2d_PrivateKey(3)`,
  the former always outputs PKCS#8.

  _Viktor Dukhovni_

- Implemented interleaved AES-CBC+HMAC-SHA algorithm on AArch64.

  _Fangming Fang_

- Added NIST security categories for PKEY objects.

  _Dr Paul Dale_

- Added notification when all stream FINs are acknowledged in QUIC. Introduced
  `ossl_quic_channel_notify_flush_done()` so that once final FINs are ACKed,
  the channel transitions to terminating and `SSL_poll()` signals completion.
  This allows applications to progress shutdown reliably.

  _Alexandr Nedvědický_

- Added array memory allocation routines and converted suitable memory
  allocation calls in the library to them.

  _Eugene Syromiatnikov_

- Fixed behavior change of EC keygen by adding the generic error entry if the
  provider did not itself add an error entry onto the queue. That way, there
  always is an error on the error queue in case of a failure, but no behavior
  change in case the provider emitted the error entry itself.

  _Ingo Franzki_

- Documented all the environment variables used across the project
  in `openssl-env(7)` and in specific man pages.

  _Eugene Syromiatnikov_

- Added SHA-2 assembly implementation enhancing performance for LoongArch.
  Added optimized SM3, MD5, SHA-256, SHA-512 implementation using Zbb extension
  for RISC-V.

  _Julian Zhu_

- Added options `CRYPTO_MEM_SEC` and `CRYPTO_MEM_SEC_MINSIZE` to `openssl` app
  to initialize secure memory at the beginning of `openssl` app.

  _Norbert Pócs_

- Resolved compiler warnings on Win64 builds.

  _Tomáš Mráz_

- Extended new `CRYPTO_THREAD_[get|set]_local` API to reduce the usage
  of OS thread-local variables.

  _Neil Horman_

- Added `make` targets `build_inst_sw` and `build_inst_programs` which have
  the functionality to split the build into two parts, e.g. when tests
  should be built with different compiler flags than the installed software.

  _Pavol Zacik_

- Refactored `OSSL_PARAM` name parsing so that automatically generated
  parsers are used instead of `OSSL_PARAM_locate()` calls. This should
  also ensure that the list of acceptable parameters better matches
  those which are actually processed. It should also provide a small
  performance improvement, because repeated iteration over passed
  parameter arrays is avoided.

  _Dr Paul Dale_

- Introduced `SSL_OP_SERVER_PREFERENCE`, superseding misleadingly
  named `SSL_OP_CIPHER_SERVER_PREFERENCE`.

  _Michael Baentsch_

- Added LMS signature verification support as per [SP 800-208].
  This support is present in both the FIPS and default providers.

  _Shane Lontis and Paul Dale_

- Introduced use of `<stdbool.h>` when handling JSON encoding
  in the OpenSSL codebase, replacing the previous use of `int`
  for these boolean values.

  _Alexis Goodfellow_

- An ANSI-C toolchain is no longer sufficient for building OpenSSL.
  The code should be built using compilers supporting C-99 features.

  _Alexandr Nedvědický_

- Support for the VxWorks platforms has been removed. These platforms
  were unadopted, unmaintained and reported to be non-functional.

  _Anthony Ioppolo_

- Relaxed the path check in OpenSSL's `file:` scheme implementation for
  `OSSL_STORE`. Previously, when the `file:` scheme is an explicit part
  of the URI, our implementation required an absolute path, such as
  `file:/path/to/file.pem`. This requirement is now relaxed, allowing
  `file:path/to/file.pem`, as well as `file:file.pem`.

  _Richard Levitte_

- Changed `openssl-pkey(1)` to match the documentation when private keys
  are output in DER format (`-outform DER`) by producing the PKCS#8 form
  by default. Previously, this would output the _traditional_ form for those
  older key types (`DSA`, `RSA`, `ECDSA`) that had such a form. The
  `-traditional` flag has been extended to support explicit requests to output
  that format in DER format (it was previously PEM-only).

  _Viktor Dukhovni_

- Added an `openssl configutl` utility for processing the OpenSSL
  configuration file and dumping the equal configuration file.

  _Dmitry Belyavskiy based on Clemens Lang's code_

- Added support for setting a free function thunk to `OPENSSL_sk` stack types.
  Using a thunk allows the type specific free function to be called
  with the correct type information from generic functions like
  `OPENSSL_sk_pop_free()`.

  _Frederik Wedel-Heinen_

- Enabled x86-64 SM4 optimizations with SM4 ISA Extension available starting
  Lunar Lake and Arrow Lake S CPUs. The expected performance improvement
  is ~3.6x for `sm4-cbc`, ~2.9x for `sm4-gcm`, ~9.2x for `sm4-xts`,
  ~5.3x for `sm4-ccm` (on average, may vary depending on the data size)
  on Arrow Lake S.

  _Alina Elizarova_

- Enabled x86-64 SM3 optimizations with SM3 ISA Extension available starting
  Lunar Lake and Arrow Lake S CPUs. The expected performance improvement
  is ~2.2—4.7x (depends on the data size) on Arrow Lake S.

  _Alina Elizarova_

- Enabled x86-64 SHA-512 optimizations with SHA512 ISA Extension.
  Optimized digests: `sha384`, `sha512`, `sha512-224`, `sha512-256`.
  `openssl speed` shows speedups ranging from 1.6x to 4.5x
  on the P-cores of Intel Core Ultra 5 238V.

  _Adrian Stanciu_

- Changed default EC point formats configuration to support only 'uncompressed'
  format, and added `SSL_OP_LEGACY_EC_POINT_FORMATS` flag and options
  to re-enable previous default, if required.

  _Tim Perry_

- Increased PKCS#12 default `macsaltlen` from 8 to 16, as, per NIST
  [SP 800-132], this improves interoperability for newly generated PKCS#12
  stores between FIPS and non-FIPS implementations.

  _Dimitri John Ledkov_

- Added `X509_CRL_get0_tbs_sigalg()` accessor for the signature
  `AlgorithmIdentifier` inside CRL's `TBSCertList`.

  _Theo Buehler_

- Added OIDS for HKDFs with SHA-256, SHA-384, and SHA-512. Added ability
  to load HKDF configured with these explicit digests by name or OID.

  _Daniel Van Geest (CryptoNext Security)_

- Added Intel AVX-512 and VAES optimizations for AES-CFB128 algorithms.
  Encryption performance on large buffers improved by 1.5—1.7x,
  while decryption speed increased by 20—23x.

  _Adrian Stanciu_

- Added support for TLS 1.3 OCSP multi-stapling for server certs.
  - new `s_client` options:
    - `-ocsp_check_leaf`: Checks the status of the leaf (server) certificate.
    - `-ocsp_check_all`: Checks the status of all certificates in the server
      chain.
  - new `s_server` option:
    - `-status_all` Provides OCSP status information for the entire server
      certificate chain (multi-stapling) for TLS 1.3 and later.
  - Improved `-status_file` option can now be given multiple times to provide
    multiple files containing OCSP responses.

  _Michael Krueger, Martin Rauch_

- Added `KEMRecipientInfo` (RFC 9629) and ML-KEM (`draft-ietf-lamps-cms-kyber`)
  support to CMS.

  _Daniel Van Geest (CryptoNext Security)_

- Added support for FIPS 186-5 deterministic ECDSA signature
  generation to the FIPS provider.

  _Dimitri John Ledkov_

## OpenSSL 3.5

### Changes between 3.5.3 and 3.5.4 [30 Sep 2025]

- Fix Out-of-bounds read & write in RFC 3211 KEK Unwrap

  Issue summary: An application trying to decrypt CMS messages encrypted using
  password based encryption can trigger an out-of-bounds read and write.

  Impact summary: This out-of-bounds read may trigger a crash which leads to
  Denial of Service for an application. The out-of-bounds write can cause
  a memory corruption which can have various consequences including
  a Denial of Service or Execution of attacker-supplied code.

  The issue was reported by Stanislav Fort (Aisle Research).

  ([CVE-2025-9230])

  _Viktor Dukhovni_

- Fix Timing side-channel in SM2 algorithm on 64 bit ARM

  Issue summary: A timing side-channel which could potentially allow remote
  recovery of the private key exists in the SM2 algorithm implementation on
  64 bit ARM platforms.

  Impact summary: A timing side-channel in SM2 signature computations on
  64 bit ARM platforms could allow recovering the private key by an attacker.

  The issue was reported by Stanislav Fort (Aisle Research).

  ([CVE-2025-9231])

  _Stanislav Fort and Tomáš Mráz_

- Fix Out-of-bounds read in HTTP client no_proxy handling

  Issue summary: An application using the OpenSSL HTTP client API functions
  may trigger an out-of-bounds read if the "no_proxy" environment variable is
  set and the host portion of the authority component of the HTTP URL is an
  IPv6 address.

  Impact summary: An out-of-bounds read can trigger a crash which leads to
  Denial of Service for an application.

  The issue was reported by Stanislav Fort (Aisle Research).

  ([CVE-2025-9232])

  _Stanislav Fort_

- The FIPS provider no longer performs a PCT on key import for ECX keys
  (that was introduced in 3.5.2), following the latest update
  on that requirement in FIPS 140-3 IG 10.3.A additional comment 1.

  _Eugene Syromiatnikov_

- Fixed the length of the ASN.1 sequence for the SM3 digests of RSA-encrypted
  signatures.

  _Xiao Lou Dong Feng_

- Reverted the synthesised `OPENSSL_VERSION_NUMBER` change for the release
  builds, as it broke some exiting applications that relied on the previous
  3.x semantics, as documented in `OpenSSL_version(3)`.

  _Richard Levitte_

### Changes between 3.5.2 and 3.5.3 [16 Sep 2025]

- Avoided a potential race condition introduced in 3.5.1, where
  `OSSL_STORE_CTX` kept open during lookup while potentially being used
  by multiple threads simultaneously, that could lead to potential crashes
  when multiple concurrent TLS connections are served.

  _Matt Caswell_

- The FIPS provider no longer performs a PCT on key import for RSA, DH,
  and EC keys (that was introduced in 3.5.2), following the latest update
  on that requirement in FIPS 140-3 IG 10.3.A additional comment 1.

  _Dr Paul Dale_

- Secure memory allocation calls are no longer used for HMAC keys.

  _Dr Paul Dale_

- `openssl req` no longer generates certificates with an empty extension list
  when SKID/AKID are set to `none` during generation.

  _David Benjamin_

- The man page date is now derived from the release date provided
  in `VERSION.dat` and not the current date for the released builds.

  _Enji Cooper_

- Hardened the provider implementation of the RSA public key "encrypt"
  operation to add a missing check that the caller-indicated output buffer
  size is at least as large as the byte count of the RSA modulus. The issue
  was reported by Arash Ale Ebrahim from SYSPWN.

  This operation is typically invoked via `EVP_PKEY_encrypt(3)`. Callers that
  in fact provide a sufficiently large buffer, but fail to correctly indicate
  its size may now encounter unexpected errors. In applications that attempt
  RSA public encryption into a buffer that is too small, an out-of-bounds
  write is now avoided and an error is reported instead.

  _Viktor Dukhovni_

- Added FIPS 140-3 PCT on DH key generation.

  _Nikola Pajkovsky_

- Fixed the synthesised `OPENSSL_VERSION_NUMBER`.

  _Richard Levitte_

### Changes between 3.5.1 and 3.5.2 [5 Aug 2025]

- The FIPS provider now performs a PCT on key import for RSA, EC and ECX.
  This is mandated by FIPS 140-3 IG 10.3.A additional comment 1.

  _Dr Paul Dale_

### Changes between 3.5.0 and 3.5.1 [1 Jul 2025]

- Fix x509 application adds trusted use instead of rejected use.

  Issue summary: Use of -addreject option with the openssl x509 application adds
  a trusted use instead of a rejected use for a certificate.

  Impact summary: If a user intends to make a trusted certificate rejected for
  a particular use it will be instead marked as trusted for that use.

  ([CVE-2025-4575])

  _Tomas Mraz_

- Aligned the behaviour of TLS and DTLS in the event of a no_renegotiation
  alert being received. Older versions of OpenSSL failed with DTLS if a
  no_renegotiation alert was received. All versions of OpenSSL do this for TLS.
  From 3.2 a bug was exposed that meant that DTLS ignored no_rengotiation. We
  have now restored the original behaviour and brought DTLS back into line with
  TLS.

  _Matt Caswell_

### Changes between 3.4 and 3.5.0 [8 Apr 2025]

- Added server side support for QUIC

  _Hugo Landau, Matt Caswell, Tomáš Mráz, Neil Horman, Sasha Nedvedicky, Andrew Dinh_

- Tolerate PKCS#8 version 2 with optional public keys. The public key data
  is currently ignored.

  _Viktor Dukhovni_

- Signature schemes without an explicit signing digest in CMS are now supported.
  Examples of such schemes are ED25519 or ML-DSA.

  _Michael Schroeder_

- The TLS Signature algorithms defaults now include all three ML-DSA variants as
  first algorithms.

  _Viktor Dukhovni_

- Added a `no-tls-deprecated-ec` configuration option.

  The `no-tls-deprecated-ec` option disables support for TLS elliptic curve
  groups deprecated in RFC8422 at compile time. This does not affect use of
  the associated curves outside TLS. By default support for these groups is
  compiled in, but, as before, they are not included in the default run-time
  list of supported groups.

  With the `enable-tls-deprecated-ec` option these TLS groups remain enabled at
  compile time even if the default configuration is changed, provided the
  underlying EC curves remain implemented.

  _Viktor Dukhovni_

- Added new API to enable 0-RTT for 3rd party QUIC stacks.

  _Cheng Zhang_

- Added support for a new callback registration `SSL_CTX_set_new_pending_conn_cb`,
  which allows for application notification of new connection SSL object
  creation, which occurs independently of calls to `SSL_accept_connection()`.
  Note: QUIC objects passed through SSL callbacks should not have their state
  mutated via calls back into the SSL api until such time as they have been
  received via a call to `SSL_accept_connection()`.

  _Neil Horman_

- Add SLH-DSA as specified in FIPS 205.

  _Shane Lontis and Dr Paul Dale_

- ML-KEM as specified in FIPS 203.

  Based on the original implementation in BoringSSL, ported from C++ to C,
  refactored, and integrated into the OpenSSL default and FIPS providers.
  Including also the X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024
  TLS hybrid key post-quantum/classical key agreement schemes.

  _Michael Baentsch, Viktor Dukhovni, Shane Lontis and Paul Dale_

- Add ML-DSA as specified in FIPS 204.

  The base code was derived from BoringSSL C++ code.

  _Shane Lontis, Viktor Dukhovni and Paul Dale_

- Added new API calls to enable 3rd party QUIC stacks to use the OpenSSL TLS
  implementation.

  _Matt Caswell_

- The default DRBG implementations have been changed to prefer to fetch
  algorithm implementations from the default provider (the provider the
  DRBG implementation is built in) regardless of the default properties
  set in the configuration file. The code will still fallback to find
  an implementation, as done previously, if needed.

  _Simo Sorce_

- Initial support for opaque symmetric keys objects (EVP_SKEY). These
  replace the ad-hoc byte arrays that are pervasive throughout the library.

  _Dmitry Belyavskiy and Simo Sorce_

- The default TLS group list setting is now set to:
  `?*X25519MLKEM768 / ?*X25519:?secp256r1 / ?X448:?secp384r1:?secp521r1 / ?ffdhe2048:?ffdhe3072`

  This means two key shares (X25519MLKEM768 and X25519) will be sent by
  default by the TLS client. GOST groups and FFDHE groups larger than 3072
  bits are no longer enabled by default.

  The group names in the group list setting are now also case insensitive.

  _Viktor Dukhovni_

- For TLSv1.3: Add capability for a client to send multiple key shares.
  Extend the scope of `SSL_OP_CIPHER_SERVER_PREFERENCE` to cover
  server-side key exchange group selection.

  Extend the server-side key exchange group selection algorithm and related
  group list syntax to support multiple group priorities, e.g. to prioritize
  (hybrid-)KEMs.

  _David Kelsey_, _Martin Schmatz_

- A new random generation API has been introduced which modifies all
  of the L<RAND_bytes(3)> family of calls so they are routed through a
  specific named provider instead of being resolved via the normal DRBG
  chaining. In a future OpenSSL release, this will obsolete RAND_METHOD.

  _Dr Paul Dale_

- New inline functions were added to support loads and stores of unsigned
  16-bit, 32-bit and 64-bit integers in either little-endian or big-endian
  form, regardless of the host byte-order. See the `OPENSSL_load_u16_le(3)`
  manpage for details.

  _Viktor Dukhovni_

- All the `BIO_meth_get_*()` functions allowing reuse of the internal OpenSSL
  BIO method implementations were deprecated. The reuse is unsafe due to
  dependency on the code of the internal methods not changing.

  _Tomáš Mráz_

- Support DEFAULT keyword and '-' prefix in `SSL_CTX_set1_groups_list()`.
  `SSL_CTX_set1_groups_list()` now supports the DEFAULT keyword which sets the
  available groups to the default selection. The '-' prefix allows the calling
  application to remove a group from the selection.

  _Frederik Wedel-Heinen_

- Updated the default encryption cipher for the `req`, `cms`, and `smime` applications
  from `des-ede3-cbc` to `aes-256-cbc`.

  AES-256 provides a stronger 256-bit key encryption than legacy 3DES.

  _Aditya_

- Enhanced PKCS#7 inner contents verification.
  In the `PKCS7_verify()` function, the BIO \*indata parameter refers to the
  signed data if the content is detached from p7. Otherwise, indata should be
  NULL, and then the signed data must be in p7.

  The previous OpenSSL implementation only supported MIME inner content
  [RFC 5652, section 5.2].

  The added functionality now enables support for PKCS#7 inner content
  [RFC 2315, section 7].

  _Małgorzata Olszówka_

- The `-rawin` option of the `pkeyutl` command is now implied (and thus no
  longer required) when using `-digest` or when signing or verifying with an
  Ed25519 or Ed448 key.
  The `-digest` and `-rawin` option may only be given with `-sign` or `verify`.

  _David von Oheimb_

- `X509_PURPOSE_add()` has been modified
  to take `sname` instead of `id` as the primary purpose identifier.
  For its convenient use, `X509_PURPOSE_get_unused_id()` has been added.

  This work was sponsored by Siemens AG.

  _David von Oheimb_

- Added support for central key generation in CMP.

  This work was sponsored by Siemens AG.

  _Rajeev Ranjan_

- Optionally allow the FIPS provider to use the `JITTER` entropy source.
  Note that using this option will require the resulting FIPS provider
  to undergo entropy source validation [ESV] by the [CMVP], without this
  the FIPS provider will not be FIPS compliant. Enable this using the
  configuration option `enable-fips-jitter`.

  _Paul Dale_

- Extended `OPENSSL_ia32cap` support to accommodate additional `CPUID`
  feature/capability bits in leaf `0x7` (Extended Feature Flags) as well
  as leaf `0x24` (Converged Vector ISA).

  _Dan Zimmerman, Alina Elizarova_

- Cipher pipelining support for provided ciphers with new API functions
  EVP_CIPHER_can_pipeline(), EVP_CipherPipelineEncryptInit(),
  EVP_CipherPipelineDecryptInit(), EVP_CipherPipelineUpdate(),
  and EVP_CipherPipelineFinal(). Cipher pipelining support allows application to
  submit multiple chunks of data in one cipher update call, thereby allowing the
  provided implementation to take advantage of parallel computing. There are
  currently no built-in ciphers that support pipelining. This new API replaces
  the legacy pipeline API [SSL_CTX_set_max_pipelines](https://docs.openssl.org/3.3/man3/SSL_CTX_set_split_send_fragment/) used with Engines.

  _Ramkumar_

- Add CMS_NO_SIGNING_TIME flag to CMS_sign(), CMS_add1_signer()

  Previously there was no way to create a CMS SignedData signature without a
  signing time attribute, because CMS_SignerInfo_sign added it unconditionally.
  However, there is a use case (PAdES signatures [ETSI EN 319 142-1](https://www.etsi.org/deliver/etsi_en/319100_319199/31914201/01.01.01_60/en_31914201v010101p.pdf) )
  where this attribute is not allowed, so a new flag was added to the CMS API
  that causes this attribute to be omitted at signing time.

  The new `-no_signing_time` option of the `cms` command enables this flag.

  _Juhász Péter_

- Parallel dual-prime 1024/1536/2048-bit modular exponentiation for
  AVX_IFMA capable processors (Intel Sierra Forest and its successor).

  This optimization brings performance enhancement, ranging from 1.8 to 2.2
  times, for the sign/decryption operations of rsaz-2k/3k/4k (`openssl speed rsa`)
  on the Intel Sierra Forest.

  _Zhiguo Zhou, Wangyang Guo (Intel Corp)_

- VAES/AVX-512 support for AES-XTS.

  For capable processors (>= Intel Icelake), this provides a
  vectorized implementation of AES-XTS with a throughput improvement
  between 1.3x to 2x, depending on the block size.

  _Pablo De Lara Guarch, Dan Pittman_

- Fixed EVP_DecodeUpdate() to not write padding zeros to the decoded output.

  According to the documentation, for every 4 valid base64 bytes processed
  (ignoring whitespace, carriage returns and line feeds), EVP_DecodeUpdate()
  produces 3 bytes of binary output data (except at the end of data
  terminated with one or two padding characters). However, the function
  behaved like an EVP_DecodeBlock(). It produced exactly 3 output bytes for
  every 4 input bytes. Such behaviour could cause writes to a non-allocated
  output buffer if a user allocates its size based on the documentation and
  knowing the padding size.

  The fix makes EVP_DecodeUpdate() produce exactly as many output bytes as
  in the initial non-encoded message.

  _Valerii Krygin_

- Added support for aAissuingDistributionPoint, allowedAttributeAssignments,
  timeSpecification, attributeDescriptor, roleSpecCertIdentifier,
  authorityAttributeIdentifier and attributeMappings X.509v3 extensions.

  _Jonathan M. Wilbur_

- Added a new CLI option `-provparam` and API functions for setting of
  provider configuration parameters.

  _Viktor Dukhovni_

- Added a new trace category for PROVIDER calls and added new tracing calls
  in provider and algorithm fetching API functions.

  _Neil Horman_

- Fixed benchmarking for AEAD ciphers in the `openssl speed` utility.

  _Mohammed Alhabib_

- Added a build configuration option `enable-sslkeylog` for enabling support
  for SSLKEYLOGFILE environment variable to log TLS connection secrets.

  _Neil Horman_

- Added EVP_get_default_properties() function to retrieve the current default
  property query string.

  _Dmitry Belyavskiy_

## OpenSSL 3.4

### Changes between 3.4.1 and 3.4.2 [xx XXX xxxx]

- When displaying distinguished names in the openssl application escape control
  characters by default.

  _Tomáš Mráz_

### Changes between 3.4.0 and 3.4.1 [11 Feb 2025]

- Fixed RFC7250 handshakes with unauthenticated servers don't abort as expected.

  Clients using RFC7250 Raw Public Keys (RPKs) to authenticate a
  server may fail to notice that the server was not authenticated, because
  handshakes don't abort as expected when the SSL_VERIFY_PEER verification mode
  is set.

  ([CVE-2024-12797])

  _Viktor Dukhovni_

- Fixed timing side-channel in ECDSA signature computation.

  There is a timing signal of around 300 nanoseconds when the top word of
  the inverted ECDSA nonce value is zero. This can happen with significant
  probability only for some of the supported elliptic curves. In particular
  the NIST P-521 curve is affected. To be able to measure this leak, the
  attacker process must either be located in the same physical computer or
  must have a very fast network connection with low latency.

  ([CVE-2024-13176])

  _Tomáš Mráz_

- Reverted the behavior change of CMS_get1_certs() and CMS_get1_crls()
  that happened in the 3.4.0 release. These functions now return NULL
  again if there are no certs or crls in the CMS object.

  _Tomáš Mráz_

### Changes between 3.3 and 3.4.0 [22 Oct 2024]

- For the FIPS provider only, replaced the primary DRBG with a continuous
  health check module. This also removes the now forbidden DRBG chaining.

  _Paul Dale_

- Improved base64 BIO correctness and error reporting.

  _Viktor Dukhovni_

- Added support for directly fetched composite signature algorithms such as
  RSA-SHA2-256 including new API functions in the EVP_PKEY_sign,
  EVP_PKEY_verify and EVP_PKEY_verify_recover groups.

  _Richard Levitte_

- XOF Digest API improvements

  EVP_MD_CTX_get_size() and EVP_MD_CTX_size are macros that were aliased to
  EVP_MD_get_size which returns a constant value. XOF Digests such as SHAKE
  have an output size that is not fixed, so calling EVP_MD_get_size() is not
  sufficent. The existing macros now point to the new function
  EVP_MD_CTX_get_size_ex() which will retrieve the "size" for a XOF digest,
  otherwise it falls back to calling EVP_MD_get_size(). Note that the SHAKE
  implementation did not have a context getter previously, so the "size" will
  only be able to be retrieved with new providers.

  Also added a EVP_xof() helper.

  _Shane Lontis_

- Added FIPS indicators to the FIPS provider.

  FIPS 140-3 requires indicators to be used if the FIPS provider allows
  non-approved algorithms. An algorithm is approved if it passes all
  required checks such as minimum key size. By default an error will
  occur if any check fails. For backwards compatibility individual
  algorithms may override the checks by using either an option in the
  FIPS configuration OR in code using an algorithm context setter.
  Overriding the check means that the algorithm is not FIPS compliant.
  OSSL_INDICATOR_set_callback() can be called to register a callback
  to log unapproved algorithms. At the end of any algorithm operation
  the approved status can be queried using an algorithm context getter.
  FIPS provider configuration options are set using 'openssl fipsinstall'.

  Note that new FIPS 140-3 restrictions have been enforced such as
  RSA Encryption using PKCS1 padding is no longer approved.
  Documentation related to the changes can be found on the [fips_module(7)]
  manual page.

  [fips_module(7)]: https://docs.openssl.org/master/man7/fips_module/#FIPS indicators

  _Shane Lontis, Paul Dale, Po-Hsing Wu and Dimitri John Ledkov_

- Added support for hardware acceleration for HMAC on S390x architecture.

  _Ingo Franzki_

- Added debuginfo Makefile target for unix platforms to produce
  a separate DWARF info file from the corresponding shared libs.

  _Neil Horman_

- Added support for encapsulation and decapsulation operations in the
  pkeyutl command.

  _Dmitry Belyavskiy_

- Added implementation of RFC 9579 (PBMAC1) in PKCS#12.

  _Dmitry Belyavskiy_

- Add a new random seed source RNG `JITTER` using a statically linked
  jitterentropy library.

  _Dimitri John Ledkov_

- Added a feature to retrieve configured TLS signature algorithms,
  e.g., via the openssl list command.

  _Michael Baentsch_

- Deprecated TS*VERIFY_CTX_set*_ functions and added replacement
  TS*VERIFY_CTX_set0*_ functions with improved semantics.

  _Tobias Erbsland_

- Redesigned Windows use of OPENSSLDIR/ENGINESDIR/MODULESDIR such that
  what were formerly build time locations can now be defined at run time
  with registry keys. See NOTES-WINDOWS.md.

  _Neil Horman_

- Added options `-not_before` and `-not_after` for explicit setting
  start and end dates of certificates created with the `req` and `x509`
  commands. Added the same options also to `ca` command as alias for
  `-startdate` and `-enddate` options.

  _Stephan Wurm_

- The X25519 and X448 key exchange implementation in the FIPS provider
  is unapproved and has `fips=no` property.

  _Tomáš Mráz_

- SHAKE-128 and SHAKE-256 implementations have no default digest length
  anymore. That means these algorithms cannot be used with
  EVP_DigestFinal/\_ex() unless the `xoflen` param is set before.

  This change was necessary because the preexisting default lengths were
  half the size necessary for full collision resistance supported by these
  algorithms.

  _Tomáš Mráz_

- Setting `config_diagnostics=1` in the config file will cause errors to
  be returned from SSL_CTX_new() and SSL_CTX_new_ex() if there is an error
  in the ssl module configuration.

  _Tomáš Mráz_

- An empty renegotiate extension will be used in TLS client hellos instead
  of the empty renegotiation SCSV, for all connections with a minimum TLS
  version > 1.0.

  _Tim Perry_

- Added support for integrity-only cipher suites TLS_SHA256_SHA256 and
  TLS_SHA384_SHA384 in TLS 1.3, as defined in RFC 9150.

  This work was sponsored by Siemens AG.

  _Rajeev Ranjan_

- Added support for retrieving certificate request templates and CRLs in CMP,
  with the respective CLI options `-template`,
  `-crlcert`, `-oldcrl`, `-crlout`, `-crlform>`, and `-rsp_crl`.

  This work was sponsored by Siemens AG.

  _Rajeev Ranjan_

- Added support for issuedOnBehalfOf, auditIdentity, basicAttConstraints,
  userNotice, acceptablePrivilegePolicies, acceptableCertPolicies,
  subjectDirectoryAttributes, associatedInformation, delegatedNameConstraints,
  holderNameConstraints and targetingInformation X.509v3 extensions.

  _Jonathan M. Wilbur_

- Added Attribute Certificate (RFC 5755) support. Attribute
  Certificates can be created, parsed, modified and printed via the
  public API. There is no command-line tool support at this time.

  _Damian Hobson-Garcia_

- Added support to build Position Independent Executables (PIE). Configuration
  option `enable-pie` configures the cflag '-fPIE' and ldflag '-pie' to
  support Address Space Layout Randomization (ASLR) in the openssl executable,
  removes reliance on external toolchain configurations.

  _Craig Lorentzen_

- SSL_SESSION_get_time()/SSL_SESSION_set_time()/SSL_CTX_flush_sessions() have
  been deprecated in favour of their respective ...\_ex() replacement functions
  which are Y2038-safe.

  _Alexander Kanavin_

- ECC groups may now customize their initialization to save CPU by using
  precomputed values. This is used by the P-256 implementation.

  _Watson Ladd_

## OpenSSL 3.3

### Changes between 3.3.2 and 3.3.3 [xx XXX xxxx]

- Fixed possible OOB memory access with invalid low-level GF(2^m) elliptic
  curve parameters.

  Use of the low-level GF(2^m) elliptic curve APIs with untrusted
  explicit values for the field polynomial can lead to out-of-bounds memory
  reads or writes.
  Applications working with "exotic" explicit binary (GF(2^m)) curve
  parameters, that make it possible to represent invalid field polynomials
  with a zero constant term, via the above or similar APIs, may terminate
  abruptly as a result of reading or writing outside of array bounds. Remote
  code execution cannot easily be ruled out.

  ([CVE-2024-9143])

  _Viktor Dukhovni_

### Changes between 3.3.1 and 3.3.2 [3 Sep 2024]

- Fixed possible denial of service in X.509 name checks.

  Applications performing certificate name checks (e.g., TLS clients checking
  server certificates) may attempt to read an invalid memory address when
  comparing the expected name with an `otherName` subject alternative name of
  an X.509 certificate. This may result in an exception that terminates the
  application program.

  ([CVE-2024-6119])

  _Viktor Dukhovni_

- Fixed possible buffer overread in SSL_select_next_proto().

  Calling the OpenSSL API function SSL_select_next_proto with an empty
  supported client protocols buffer may cause a crash or memory contents
  to be sent to the peer.

  ([CVE-2024-5535])

  _Matt Caswell_

### Changes between 3.3.0 and 3.3.1 [4 Jun 2024]

- Fixed potential use after free after SSL_free_buffers() is called.

  The SSL_free_buffers function is used to free the internal OpenSSL
  buffer used when processing an incoming record from the network.
  The call is only expected to succeed if the buffer is not currently
  in use. However, two scenarios have been identified where the buffer
  is freed even when still in use.

  The first scenario occurs where a record header has been received
  from the network and processed by OpenSSL, but the full record body
  has not yet arrived. In this case calling SSL_free_buffers will succeed
  even though a record has only been partially processed and the buffer
  is still in use.

  The second scenario occurs where a full record containing application
  data has been received and processed by OpenSSL but the application has
  only read part of this data. Again a call to SSL_free_buffers will
  succeed even though the buffer is still in use.

  ([CVE-2024-4741])

  _Matt Caswell_

- Fixed an issue where checking excessively long DSA keys or parameters may
  be very slow.

  Applications that use the functions EVP_PKEY_param_check() or
  EVP_PKEY_public_check() to check a DSA public key or DSA parameters may
  experience long delays. Where the key or parameters that are being checked
  have been obtained from an untrusted source this may lead to a Denial of
  Service.

  To resolve this issue DSA keys larger than OPENSSL_DSA_MAX_MODULUS_BITS
  will now fail the check immediately with a DSA_R_MODULUS_TOO_LARGE error
  reason.

  ([CVE-2024-4603])

  _Tomáš Mráz_

- Improved EC/DSA nonce generation routines to avoid bias and timing
  side channel leaks.

  Thanks to Florian Sieck from Universität zu Lübeck and George Pantelakis
  and Hubert Kario from Red Hat for reporting the issues.

  _Tomáš Mráz and Paul Dale_

### Changes between 3.2 and 3.3.0 [9 Apr 2024]

- The `-verify` option to the `openssl crl` and `openssl req` will make
  the program exit with 1 on failure.

  _Vladimír Kotal_

- The BIO_get_new_index() function can only be called 127 times before it
  reaches its upper bound of BIO_TYPE_MASK. It will now correctly return an
  error of -1 once it is exhausted. Users may need to reserve using this
  function for cases where BIO_find_type() is required. Either BIO_TYPE_NONE
  or BIO_get_new_index() can be used to supply a type to BIO_meth_new().

  _Shane Lontis_

- Added API functions SSL_SESSION_get_time_ex(), SSL_SESSION_set_time_ex()
  using time_t which is Y2038 safe on 32 bit systems when 64 bit time
  is enabled (e.g via setting glibc macro \_TIME_BITS=64).

  _Ijtaba Hussain_

- The d2i_ASN1_GENERALIZEDTIME(), d2i_ASN1_UTCTIME(), ASN1_TIME_check(), and
  related functions have been augmented to check for a minimum length of
  the input string, in accordance with ITU-T X.690 section 11.7 and 11.8.

  _Job Snijders_

- Unknown entries in TLS SignatureAlgorithms, ClientSignatureAlgorithms
  config options and the respective calls to SSL[_CTX]\_set1_sigalgs() and
  SSL[_CTX]\_set1_client_sigalgs() that start with `?` character are
  ignored and the configuration will still be used.

  Similarly unknown entries that start with `?` character in a TLS
  Groups config option or set with SSL[_CTX]\_set1_groups_list() are ignored
  and the configuration will still be used.

  In both cases if the resulting list is empty, an error is returned.

  _Tomáš Mráz_

- The EVP_PKEY_fromdata function has been augmented to allow for the derivation
  of CRT (Chinese Remainder Theorem) parameters when requested. See the
  OSSL_PKEY_PARAM_RSA_DERIVE_FROM_PQ param in the EVP_PKEY-RSA documentation.

  _Neil Horman_

- The activate and soft_load configuration settings for providers in
  openssl.cnf have been updated to require a value of [1|yes|true|on]
  (in lower or UPPER case) to enable the setting. Conversely a value
  of [0|no|false|off] will disable the setting. All other values, or the
  omission of a value for these settings will result in an error.

  _Neil Horman_

- Added `-set_issuer` and `-set_subject` options to `openssl x509` to
  override the Issuer and Subject when creating a certificate. The `-subj`
  option now is an alias for `-set_subject`.

  _Job Snijders, George Michaelson_

- OPENSSL*sk_push() and sk*<TYPE>\_push() functions now return 0 instead of -1
  if called with a NULL stack argument.

  _Tomáš Mráz_

- In `openssl speed`, changed the default hash function used with `hmac` from
  `md5` to `sha256`.

  _James Muir_

- Added several new features of CMPv3 defined in RFC 9480 and RFC 9483:
  - `certProfile` request message header and respective `-profile` CLI option
  - support for delayed delivery of all types of response messages

  This work was sponsored by Siemens AG.

  _David von Oheimb_

- The build of exporters (such as `.pc` files for pkg-config) cleaned up to
  be less hard coded in the build file templates, and to allow easier
  addition of more exporters. With that, an exporter for CMake is also
  added.

  _Richard Levitte_

- The BLAKE2s hash algorithm matches BLAKE2b's support
  for configurable output length.

  _Ahelenia Ziemiańska_

- New option `SSL_OP_PREFER_NO_DHE_KEX`, which allows configuring a TLS1.3
  server to prefer session resumption using PSK-only key exchange over PSK
  with DHE, if both are available.

  _Markus Minichmayr, Tapkey GmbH_

- New API `SSL_write_ex2`, which can be used to send an end-of-stream (FIN)
  condition in an optimised way when using QUIC.

  _Hugo Landau_

- New atexit configuration switch, which controls whether the OPENSSL_cleanup
  is registered when libcrypto is unloaded. This is turned off on NonStop
  configurations because of loader differences on that platform compared to
  Linux.

  _Randall S. Becker_

- Support for qlog for tracing QUIC connections has been added.

  The qlog output from OpenSSL currently uses a pre-standard draft version of
  qlog. The output from OpenSSL will change in incompatible ways in future
  releases, and is not subject to any format stability or compatibility
  guarantees at this time. This functionality can be
  disabled with the build-time option `no-unstable-qlog`. See the
  openssl-qlog(7) manpage for details.

  _Hugo Landau_

- Added APIs to allow configuring the negotiated idle timeout for QUIC
  connections, and to allow determining the number of additional streams
  that can currently be created for a QUIC connection.

  _Hugo Landau_

- Added APIs to allow disabling implicit QUIC event processing for
  QUIC SSL objects, allowing applications to control when event handling
  occurs. Refer to the SSL_get_value_uint(3) manpage for details.

  _Hugo Landau_

- Limited support for polling of QUIC connection and stream objects in a
  non-blocking manner. Refer to the SSL_poll(3) manpage for details.

  _Hugo Landau_

- Added APIs to allow querying the size and utilisation of a QUIC stream's
  write buffer. Refer to the SSL_get_value_uint(3) manpage for details.

  _Hugo Landau_

- New limit on HTTP response headers is introduced to HTTP client. The
  default limit is set to 256 header lines. If limit is exceeded the
  response processing stops with error HTTP_R_RESPONSE_TOO_MANY_HDRLINES.
  Application may call OSSL_HTTP_REQ_CTX_set_max_response_hdr_lines(3)
  to change the default. Setting the value to 0 disables the limit.

  _Alexandr Nedvedicky_

- Applied AES-GCM unroll8 optimisation to Microsoft Azure Cobalt 100

  _Tom Cosgrove_

- Added X509_STORE_get1_objects to avoid issues with the existing
  X509_STORE_get0_objects API in multi-threaded applications. Refer to the
  documentation for details.

  _David Benjamin_

- Added assembly implementation for md5 on loongarch64

  _Min Zhou_

- Optimized AES-CTR for ARM Neoverse V1 and V2

  _Fisher Yu_

- Enable AES and SHA3 optimisations on Apple Silicon M3-based MacOS systems
  similar to M1/M2.

  _Tom Cosgrove_

- Added a new EVP_DigestSqueeze() API. This allows SHAKE to squeeze multiple
  times with different output sizes.

  _Shane Lontis, Holger Dengler_

- Various optimizations for cryptographic routines using RISC-V vector crypto
  extensions

  _Christoph Müllner, Charalampos Mitrodimas, Ard Biesheuvel, Phoebe Chen,
  Jerry Shih_

- Accept longer context for TLS 1.2 exporters

  While RFC 5705 implies that the maximum length of a context for exporters is
  65535 bytes as the length is embedded in uint16, the previous implementation
  enforced a much smaller limit, which is less than 1024 bytes. This
  restriction has been removed.

  _Daiki Ueno_

## OpenSSL 3.2

### Changes between 3.2.1 and 3.2.2 [xx XXX xxxx]

- Fixed an issue where some non-default TLS server configurations can cause
  unbounded memory growth when processing TLSv1.3 sessions. An attacker may
  exploit certain server configurations to trigger unbounded memory growth that
  would lead to a Denial of Service

  This problem can occur in TLSv1.3 if the non-default SSL_OP_NO_TICKET option
  is being used (but not if early_data is also configured and the default
  anti-replay protection is in use). In this case, under certain conditions,
  the session cache can get into an incorrect state and it will fail to flush
  properly as it fills. The session cache will continue to grow in an unbounded
  manner. A malicious client could deliberately create the scenario for this
  failure to force a Denial of Service. It may also happen by accident in
  normal operation.

  ([CVE-2024-2511])

  _Matt Caswell_

- Fixed bug where SSL_export_keying_material() could not be used with QUIC
  connections. (#23560)

  _Hugo Landau_

### Changes between 3.2.0 and 3.2.1 [30 Jan 2024]

- A file in PKCS12 format can contain certificates and keys and may come from
  an untrusted source. The PKCS12 specification allows certain fields to be
  NULL, but OpenSSL did not correctly check for this case. A fix has been
  applied to prevent a NULL pointer dereference that results in OpenSSL
  crashing. If an application processes PKCS12 files from an untrusted source
  using the OpenSSL APIs then that application will be vulnerable to this
  issue prior to this fix.

  OpenSSL APIs that were vulnerable to this are: PKCS12_parse(),
  PKCS12_unpack_p7data(), PKCS12_unpack_p7encdata(), PKCS12_unpack_authsafes()
  and PKCS12_newpass().

  We have also fixed a similar issue in SMIME_write_PKCS7(). However since this
  function is related to writing data we do not consider it security
  significant.

  ([CVE-2024-0727])

  _Matt Caswell_

- When function EVP_PKEY_public_check() is called on RSA public keys,
  a computation is done to confirm that the RSA modulus, n, is composite.
  For valid RSA keys, n is a product of two or more large primes and this
  computation completes quickly. However, if n is an overly large prime,
  then this computation would take a long time.

  An application that calls EVP_PKEY_public_check() and supplies an RSA key
  obtained from an untrusted source could be vulnerable to a Denial of Service
  attack.

  The function EVP_PKEY_public_check() is not called from other OpenSSL
  functions however it is called from the OpenSSL pkey command line
  application. For that reason that application is also vulnerable if used
  with the "-pubin" and "-check" options on untrusted data.

  To resolve this issue RSA keys larger than OPENSSL_RSA_MAX_MODULUS_BITS will
  now fail the check immediately with an RSA_R_MODULUS_TOO_LARGE error reason.

  ([CVE-2023-6237])

  _Tomáš Mráz_

- Restore the encoding of SM2 PrivateKeyInfo and SubjectPublicKeyInfo to
  have the contained AlgorithmIdentifier.algorithm set to id-ecPublicKey
  rather than SM2.

  _Richard Levitte_

- The POLY1305 MAC (message authentication code) implementation in OpenSSL
  for PowerPC CPUs saves the contents of vector registers in different
  order than they are restored. Thus the contents of some of these vector
  registers is corrupted when returning to the caller. The vulnerable code is
  used only on newer PowerPC processors supporting the PowerISA 2.07
  instructions.

  The consequences of this kind of internal application state corruption can
  be various - from no consequences, if the calling application does not
  depend on the contents of non-volatile XMM registers at all, to the worst
  consequences, where the attacker could get complete control of the
  application process. However unless the compiler uses the vector registers
  for storing pointers, the most likely consequence, if any, would be an
  incorrect result of some application dependent calculations or a crash
  leading to a denial of service.

  ([CVE-2023-6129])

  _Rohan McLure_

- Disable building QUIC server utility when OpenSSL is configured with
  `no-apps`.

  _Vitalii Koshura_

### Changes between 3.1 and 3.2.0 [23 Nov 2023]

- Fix excessive time spent in DH check / generation with large Q parameter
  value.

  Applications that use the functions DH_generate_key() to generate an
  X9.42 DH key may experience long delays. Likewise, applications that use
  DH_check_pub_key(), DH_check_pub_key_ex() or EVP_PKEY_public_check()
  to check an X9.42 DH key or X9.42 DH parameters may experience long delays.
  Where the key or parameters that are being checked have been obtained from
  an untrusted source this may lead to a Denial of Service.

  ([CVE-2023-5678])

  _Richard Levitte_

- The BLAKE2b hash algorithm supports a configurable output length
  by setting the "size" parameter.

  _Čestmír Kalina and Tomáš Mráz_

- Enable extra Arm64 optimization on Windows for GHASH, RAND and AES.

  _Evgeny Karpov_

- Added a function to delete objects from store by URI - OSSL_STORE_delete()
  and the corresponding provider-storemgmt API function
  OSSL_FUNC_store_delete().

  _Dmitry Belyavskiy_

- Added OSSL_FUNC_store_open_ex() provider-storemgmt API function to pass
  a passphrase callback when opening a store.

  _Simo Sorce_

- Changed the default salt length used by PBES2 KDF's (PBKDF2 and scrypt)
  from 8 bytes to 16 bytes.
  The PKCS5 (RFC 8018) standard uses a 64 bit salt length for PBE, and
  recommends a minimum of 64 bits for PBES2. For FIPS compliance PBKDF2
  requires a salt length of 128 bits. This affects OpenSSL command line
  applications such as "genrsa" and "pkcs8" and API's such as
  PEM_write_bio_PrivateKey() that are reliant on the default value.
  The additional commandline option 'saltlen' has been added to the
  OpenSSL command line applications for "pkcs8" and "enc" to allow the
  salt length to be set to a non default value.

  _Shane Lontis_

- Changed the default value of the `ess_cert_id_alg` configuration
  option which is used to calculate the TSA's public key certificate
  identifier. The default algorithm is updated to be sha256 instead
  of sha1.

  _Małgorzata Olszówka_

- Added optimization for SM2 algorithm on aarch64. It uses a huge precomputed
  table for point multiplication of the base point, which increases the size of
  libcrypto from 4.4 MB to 4.9 MB. A new configure option `no-sm2-precomp` has
  been added to disable the precomputed table.

  _Xu Yizhou_

- Added client side support for QUIC

  _Hugo Landau, Matt Caswell, Paul Dale, Tomáš Mráz, Richard Levitte_

- Added multiple tutorials on the OpenSSL library and in particular
  on writing various clients (using TLS and QUIC protocols) with libssl.

  _Matt Caswell_

- Added secp384r1 implementation using Solinas' reduction to improve
  speed of the NIST P-384 elliptic curve. To enable the implementation
  the build option `enable-ec_nistp_64_gcc_128` must be used.

  _Rohan McLure_

- Improved RFC7468 compliance of the asn1parse command.

  _Matthias St. Pierre_

- Added SHA256/192 algorithm support.

  _Fergus Dall_

- Improved contention on global write locks by using more read locks where
  appropriate.

  _Matt Caswell_

- Improved performance of OSSL_PARAM lookups in performance critical
  provider functions.

  _Paul Dale_

- Added the SSL_get0_group_name() function to provide access to the
  name of the group used for the TLS key exchange.

  _Alex Bozarth_

- Provide a new configure option `no-http` that can be used to disable the
  HTTP support. Provide new configure options `no-apps` and `no-docs` to
  disable building the openssl command line application and the documentation.

  _Vladimír Kotal_

- Provide a new configure option `no-ecx` that can be used to disable the
  X25519, X448, and EdDSA support.

  _Yi Li_

- When multiple OSSL_KDF_PARAM_INFO parameters are passed to
  the EVP_KDF_CTX_set_params() function they are now concatenated not just
  for the HKDF algorithm but also for SSKDF and X9.63 KDF algorithms.

  _Paul Dale_

- Added OSSL_FUNC_keymgmt_im/export_types_ex() provider functions that get
  the provider context as a parameter.

  _Ingo Franzki_

- TLS round-trip time calculation was added by a Brigham Young University
  Capstone team partnering with Sandia National Laboratories. A new function
  in ssl_lib titled SSL_get_handshake_rtt will calculate and retrieve this
  value.

  _Jairus Christensen_

- Added the "-quic" option to s_client to enable connectivity to QUIC servers.
  QUIC requires the use of ALPN, so this must be specified via the "-alpn"
  option. Use of the "advanced" s_client command command via the "-adv" option
  is recommended.

  _Matt Caswell_

- Added an "advanced" command mode to s_client. Use this with the "-adv"
  option. The old "basic" command mode recognises certain letters that must
  always appear at the start of a line and cannot be escaped. The advanced
  command mode enables commands to be entered anywhere and there is an
  escaping mechanism. After starting s_client with "-adv" type "{help}"
  to show a list of available commands.

  _Matt Caswell_

- Add Raw Public Key (RFC7250) support. Authentication is supported
  by matching keys against either local policy (TLSA records synthesised
  from the expected keys) or DANE (TLSA records obtained by the
  application from DNS). TLSA records will also match the same key in
  the server certificate, should RPK use not happen to be negotiated.

  _Todd Short_

- Added support for modular exponentiation and CRT offloading for the
  S390x architecture.

  _Juergen Christ_

- Added further assembler code for the RISC-V architecture.

  _Christoph Müllner_

- Added EC_GROUP_to_params() which creates an OSSL_PARAM array
  from a given EC_GROUP.

  _Oliver Mihatsch_

- Improved support for non-default library contexts and property queries
  when parsing PKCS#12 files.

  _Shane Lontis_

- Implemented support for all five instances of EdDSA from RFC8032:
  Ed25519, Ed25519ctx, Ed25519ph, Ed448, and Ed448ph.
  The streaming is not yet supported for the HashEdDSA variants
  (Ed25519ph and Ed448ph).

  _James Muir_

- Added SM4 optimization for ARM processors using ASIMD and AES HW
  instructions.

  _Xu Yizhou_

- Implemented SM4-XTS support.

  _Xu Yizhou_

- Added platform-agnostic OSSL_sleep() function.

  _Richard Levitte_

- Implemented deterministic ECDSA signatures (RFC6979) support.

  _Shane Lontis_

- Implemented AES-GCM-SIV (RFC8452) support.

  _Todd Short_

- Added support for pluggable (provider-based) TLS signature algorithms.
  This enables TLS 1.3 authentication operations with algorithms embedded
  in providers not included by default in OpenSSL. In combination with
  the already available pluggable KEM and X.509 support, this enables
  for example suitable providers to deliver post-quantum or quantum-safe
  cryptography to OpenSSL users.

  _Michael Baentsch_

- Added support for pluggable (provider-based) CMS signature algorithms.
  This enables CMS sign and verify operations with algorithms embedded
  in providers not included by default in OpenSSL.

  _Michael Baentsch_

- Added support for Hybrid Public Key Encryption (HPKE) as defined
  in RFC9180. HPKE is required for TLS Encrypted ClientHello (ECH),
  Message Layer Security (MLS) and other IETF specifications.
  HPKE can also be used by other applications that require
  encrypting "to" an ECDH public key. External APIs are defined in
  include/openssl/hpke.h and documented in doc/man3/OSSL_HPKE_CTX_new.pod

  _Stephen Farrell_

- Implemented HPKE DHKEM support in providers used by HPKE (RFC9180)
  API.

  _Shane Lontis_

- Add support for certificate compression (RFC8879), including
  library support for Brotli and Zstandard compression.

  _Todd Short_

- Add the ability to add custom attributes to PKCS12 files. Add a new API
  PKCS12_create_ex2, identical to the existing PKCS12_create_ex but allows
  for a user specified callback and optional argument.
  Added a new PKCS12_SAFEBAG_set0_attr, which allows for a new attr to be
  added to the existing STACK_OF attrs.

  _Graham Woodward_

- Major refactor of the libssl record layer.

  _Matt Caswell_

- Add a mac salt length option for the pkcs12 command.

  _Xinping Chen_

- Add more SRTP protection profiles from RFC8723 and RFC8269.

  _Kijin Kim_

- Extended Kernel TLS (KTLS) to support TLS 1.3 receive offload.

  _Daiki Ueno, John Baldwin and Dmitry Podgorny_

- Add support for TCP Fast Open (RFC7413) to macOS, Linux, and FreeBSD where
  supported and enabled.

  _Todd Short_

- Add ciphersuites based on DHE_PSK (RFC 4279) and ECDHE_PSK (RFC 5489)
  to the list of ciphersuites providing Perfect Forward Secrecy as
  required by SECLEVEL >= 3.

  _Dmitry Belyavskiy, Nicola Tuveri_

- Add new SSL APIs to aid in efficiently implementing TLS/SSL fingerprinting.
  The SSL_CTRL_GET_IANA_GROUPS control code, exposed as the
  SSL_get0_iana_groups() function-like macro, retrieves the list of
  supported groups sent by the peer.
  The function SSL_client_hello_get_extension_order() populates
  a caller-supplied array with the list of extension types present in the
  ClientHello, in order of appearance.

  _Phus Lu_

- Fixed PEM_write_bio_PKCS8PrivateKey() and PEM_write_bio_PKCS8PrivateKey_nid()
  to make it possible to use empty passphrase strings.

  _Darshan Sen_

- The PKCS12_parse() function now supports MAC-less PKCS12 files.

  _Daniel Fiala_

- Added ASYNC_set_mem_functions() and ASYNC_get_mem_functions() calls to be able
  to change functions used for allocating the memory of asynchronous call stack.

  _Arran Cudbard-Bell_

- Added support for signed BIGNUMs in the OSSL_PARAM APIs.

  _Richard Levitte_

- A failure exit code is returned when using the openssl x509 command to check
  certificate attributes and the checks fail.

  _Rami Khaldi_

- The default SSL/TLS security level has been changed from 1 to 2. RSA,
  DSA and DH keys of 1024 bits and above and less than 2048 bits and ECC keys
  of 160 bits and above and less than 224 bits were previously accepted by
  default but are now no longer allowed. By default TLS compression was
  already disabled in previous OpenSSL versions. At security level 2 it cannot
  be enabled.

  _Matt Caswell_

- The SSL_CTX_set_cipher_list family functions now accept ciphers using their
  IANA standard names.

  _Erik Lax_

- The PVK key derivation function has been moved from b2i_PVK_bio_ex() into
  the legacy crypto provider as an EVP_KDF. Applications requiring this KDF
  will need to load the legacy crypto provider.

  _Paul Dale_

- CCM8 cipher suites in TLS have been downgraded to security level zero
  because they use a short authentication tag which lowers their strength.

  _Paul Dale_

- Subject or issuer names in X.509 objects are now displayed as UTF-8 strings
  by default. Also spaces surrounding `=` in DN output are removed.

  _Dmitry Belyavskiy_

- Add X.509 certificate codeSigning purpose and related checks on key usage and
  extended key usage of the leaf certificate according to the CA/Browser Forum.
  - Lutz Jänicke\*

- The `x509`, `ca`, and `req` commands now produce X.509 v3 certificates.
  The `-x509v1` option of `req` prefers generation of X.509 v1 certificates.
  `X509_sign()` and `X509_sign_ctx()` make sure that the certificate has
  X.509 version 3 if the certificate information includes X.509 extensions.

  _David von Oheimb_

- Fix and extend certificate handling and the commands `x509`, `verify` etc.
  such as adding a trace facility for debugging certificate chain building.

  _David von Oheimb_

- Various fixes and extensions to the CMP+CRMF implementation and the `cmp` app
  in particular supporting various types of genm/genp exchanges such as getting
  CA certificates and root CA cert updates defined in CMP Updates [RFC 9480],
  as well as the `-srvcertout` and `-serial` CLI options.

  This work was sponsored by Siemens AG.

  _David von Oheimb_

- Fixes and extensions to the HTTP client and to the HTTP server in `apps/`
  like correcting the TLS and proxy support and adding tracing for debugging.

  _David von Oheimb_

- Extended the CMS API for handling `CMS_SignedData` and `CMS_EnvelopedData`.

  _David von Oheimb_

- `CMS_add0_cert()` and `CMS_add1_cert()` no longer throw an error if
  a certificate to be added is already present. `CMS_sign_ex()` and
  `CMS_sign()` now ignore any duplicate certificates in their `certs` argument
  and no longer throw an error for them.

  _David von Oheimb_

- Fixed and extended `util/check-format.pl` for checking adherence to the
  coding style <https://www.openssl.org/policies/technical/coding-style.html>.
  The checks are meanwhile more complete and yield fewer false positives.

  _David von Oheimb_

- Added BIO_s_dgram_pair() and BIO_s_dgram_mem() that provide memory-based
  BIOs with datagram semantics and support for BIO_sendmmsg() and BIO_recvmmsg()
  calls. They can be used as the transport BIOs for QUIC.

  _Hugo Landau, Matt Caswell and Tomáš Mráz_

- Add new BIO_sendmmsg() and BIO_recvmmsg() BIO methods which allow
  sending and receiving multiple messages in a single call. An implementation
  is provided for BIO_dgram. For further details, see BIO_sendmmsg(3).

  _Hugo Landau_

- Support for loading root certificates from the Windows certificate store
  has been added. The support is in the form of a store which recognises the
  URI string of `org.openssl.winstore://`. This URI scheme currently takes no
  arguments. This store is built by default and can be disabled using the new
  compile-time option `no-winstore`. This store is not currently used by
  default and must be loaded explicitly using the above store URI. It is
  expected to be loaded by default in the future.

  _Hugo Landau_

- Enable KTLS with the TLS 1.3 CCM mode ciphersuites. Note that some linux
  kernel versions that support KTLS have a known bug in CCM processing. That
  has been fixed in stable releases starting from 5.4.164, 5.10.84, 5.15.7,
  and all releases since 5.16. KTLS with CCM ciphersuites should be only used
  on these releases.

  _Tianjia Zhang_

- Added `-ktls` option to `s_server` and `s_client` commands to enable the
  KTLS support.

  _Tianjia Zhang_

- Zerocopy KTLS sendfile() support on Linux.

  _Maxim Mikityanskiy_

- The OBJ\_ calls are now thread safe using a global lock.

  _Paul Dale_

- New parameter `-digest` for openssl cms command allowing signing
  pre-computed digests and new CMS API functions supporting that
  functionality.

  _Viktor Söderqvist_

- OPENSSL_malloc() and other allocation functions now raise errors on
  allocation failures. The callers do not need to explicitly raise errors
  unless they want to for tracing purposes.

  _David von Oheimb_

- Added and enabled by default implicit rejection in RSA PKCS#1 v1.5
  decryption as a protection against Bleichenbacher-like attacks.
  The RSA decryption API will now return a randomly generated deterministic
  message instead of an error in case it detects an error when checking
  padding during PKCS#1 v1.5 decryption. This is a general protection against
  issues like CVE-2020-25659 and CVE-2020-25657. This protection can be
  disabled by calling
  `EVP_PKEY_CTX_ctrl_str(ctx, "rsa_pkcs1_implicit_rejection". "0")`
  on the RSA decryption context.

  _Hubert Kario_

- Added support for Brainpool curves in TLS-1.3.

  _Bernd Edlinger and Matt Caswell_

- Added OpenBSD specific build targets.

  _David Carlier_

- Support for Argon2d, Argon2i, Argon2id KDFs has been added along with
  a basic thread pool implementation for select platforms.

  _Čestmír Kalina_

## OpenSSL 3.1

### Changes between 3.1.3 and 3.1.4 [24 Oct 2023]

- Fix incorrect key and IV resizing issues when calling EVP_EncryptInit_ex2(),
  EVP_DecryptInit_ex2() or EVP_CipherInit_ex2() with OSSL_PARAM parameters
  that alter the key or IV length ([CVE-2023-5363]).

  _Paul Dale_

### Changes between 3.1.2 and 3.1.3 [19 Sep 2023]

- Fix POLY1305 MAC implementation corrupting XMM registers on Windows.

  The POLY1305 MAC (message authentication code) implementation in OpenSSL
  does not save the contents of non-volatile XMM registers on Windows 64
  platform when calculating the MAC of data larger than 64 bytes. Before
  returning to the caller all the XMM registers are set to zero rather than
  restoring their previous content. The vulnerable code is used only on newer
  x86_64 processors supporting the AVX512-IFMA instructions.

  The consequences of this kind of internal application state corruption can
  be various - from no consequences, if the calling application does not
  depend on the contents of non-volatile XMM registers at all, to the worst
  consequences, where the attacker could get complete control of the
  application process. However given the contents of the registers are just
  zeroized so the attacker cannot put arbitrary values inside, the most likely
  consequence, if any, would be an incorrect result of some application
  dependent calculations or a crash leading to a denial of service.

  ([CVE-2023-4807])

  _Bernd Edlinger_

### Changes between 3.1.1 and 3.1.2 [1 Aug 2023]

- Fix excessive time spent checking DH q parameter value.

  The function DH_check() performs various checks on DH parameters. After
  fixing CVE-2023-3446 it was discovered that a large q parameter value can
  also trigger an overly long computation during some of these checks.
  A correct q value, if present, cannot be larger than the modulus p
  parameter, thus it is unnecessary to perform these checks if q is larger
  than p.

  If DH_check() is called with such q parameter value,
  DH_CHECK_INVALID_Q_VALUE return flag is set and the computationally
  intensive checks are skipped.

  ([CVE-2023-3817])

  _Tomáš Mráz_

- Fix DH_check() excessive time with over sized modulus.

  The function DH_check() performs various checks on DH parameters. One of
  those checks confirms that the modulus ("p" parameter) is not too large.
  Trying to use a very large modulus is slow and OpenSSL will not normally use
  a modulus which is over 10,000 bits in length.

  However the DH_check() function checks numerous aspects of the key or
  parameters that have been supplied. Some of those checks use the supplied
  modulus value even if it has already been found to be too large.

  A new limit has been added to DH_check of 32,768 bits. Supplying a
  key/parameters with a modulus over this size will simply cause DH_check() to
  fail.

  ([CVE-2023-3446])

  _Matt Caswell_

- Do not ignore empty associated data entries with AES-SIV.

  The AES-SIV algorithm allows for authentication of multiple associated
  data entries along with the encryption. To authenticate empty data the
  application has to call `EVP_EncryptUpdate()` (or `EVP_CipherUpdate()`)
  with NULL pointer as the output buffer and 0 as the input buffer length.
  The AES-SIV implementation in OpenSSL just returns success for such call
  instead of performing the associated data authentication operation.
  The empty data thus will not be authenticated. ([CVE-2023-2975])

  Thanks to Juerg Wullschleger (Google) for discovering the issue.

  The fix changes the authentication tag value and the ciphertext for
  applications that use empty associated data entries with AES-SIV.
  To decrypt data encrypted with previous versions of OpenSSL the application
  has to skip calls to `EVP_DecryptUpdate()` for empty associated data
  entries.

  _Tomáš Mráz_

- When building with the `enable-fips` option and using the resulting
  FIPS provider, TLS 1.2 will, by default, mandate the use of an extended
  master secret (FIPS 140-3 IG G.Q) and the Hash and HMAC DRBGs will
  not operate with truncated digests (FIPS 140-3 IG G.R).

  _Paul Dale_

### Changes between 3.1.0 and 3.1.1 [30 May 2023]

- Mitigate for the time it takes for `OBJ_obj2txt` to translate gigantic
  OBJECT IDENTIFIER sub-identifiers to canonical numeric text form.

  OBJ_obj2txt() would translate any size OBJECT IDENTIFIER to canonical
  numeric text form. For gigantic sub-identifiers, this would take a very
  long time, the time complexity being O(n^2) where n is the size of that
  sub-identifier. ([CVE-2023-2650])

  To mitigitate this, `OBJ_obj2txt()` will only translate an OBJECT
  IDENTIFIER to canonical numeric text form if the size of that OBJECT
  IDENTIFIER is 586 bytes or less, and fail otherwise.

  The basis for this restriction is [RFC 2578 (STD 58), section 3.5]. OBJECT
  IDENTIFIER values, which stipulates that OBJECT IDENTIFIERS may have at
  most 128 sub-identifiers, and that the maximum value that each sub-
  identifier may have is 2^32-1 (4294967295 decimal).

  For each byte of every sub-identifier, only the 7 lower bits are part of
  the value, so the maximum amount of bytes that an OBJECT IDENTIFIER with
  these restrictions may occupy is 32 \* 128 / 7, which is approximately 586
  bytes.

  _Richard Levitte_

- Multiple algorithm implementation fixes for ARM BE platforms.

  _Liu-ErMeng_

- Added a -pedantic option to fipsinstall that adjusts the various
  settings to ensure strict FIPS compliance rather than backwards
  compatibility.

  _Paul Dale_

- Fixed buffer overread in AES-XTS decryption on ARM 64 bit platforms which
  happens if the buffer size is 4 mod 5 in 16 byte AES blocks. This can
  trigger a crash of an application using AES-XTS decryption if the memory
  just after the buffer being decrypted is not mapped.
  Thanks to Anton Romanov (Amazon) for discovering the issue.
  ([CVE-2023-1255])

  _Nevine Ebeid_

- Reworked the Fix for the Timing Oracle in RSA Decryption ([CVE-2022-4304]).
  The previous fix for this timing side channel turned out to cause
  a severe 2-3x performance regression in the typical use case
  compared to 3.0.7. The new fix uses existing constant time
  code paths, and restores the previous performance level while
  fully eliminating all existing timing side channels.
  The fix was developed by Bernd Edlinger with testing support
  by Hubert Kario.

  _Bernd Edlinger_

- Add FIPS provider configuration option to disallow the use of
  truncated digests with Hash and HMAC DRBGs (q.v. FIPS 140-3 IG D.R.).
  The option '-no_drbg_truncated_digests' can optionally be
  supplied to 'openssl fipsinstall'.

  _Paul Dale_

- Corrected documentation of X509_VERIFY_PARAM_add0_policy() to mention
  that it does not enable policy checking. Thanks to David Benjamin for
  discovering this issue.
  ([CVE-2023-0466])

  _Tomáš Mráz_

- Fixed an issue where invalid certificate policies in leaf certificates are
  silently ignored by OpenSSL and other certificate policy checks are skipped
  for that certificate. A malicious CA could use this to deliberately assert
  invalid certificate policies in order to circumvent policy checking on the
  certificate altogether.
  ([CVE-2023-0465])

  _Matt Caswell_

- Limited the number of nodes created in a policy tree to mitigate
  against CVE-2023-0464. The default limit is set to 1000 nodes, which
  should be sufficient for most installations. If required, the limit
  can be adjusted by setting the OPENSSL_POLICY_TREE_NODES_MAX build
  time define to a desired maximum number of nodes or zero to allow
  unlimited growth.
  ([CVE-2023-0464])

  _Paul Dale_

### Changes between 3.0 and 3.1.0 [14 Mar 2023]

- Add FIPS provider configuration option to enforce the
  Extended Master Secret (EMS) check during the TLS1_PRF KDF.
  The option '-ems_check' can optionally be supplied to
  'openssl fipsinstall'.

  _Shane Lontis_

- The FIPS provider includes a few non-approved algorithms for
  backward compatibility purposes and the "fips=yes" property query
  must be used for all algorithm fetches to ensure FIPS compliance.

  The algorithms that are included but not approved are Triple DES ECB,
  Triple DES CBC and EdDSA.

  _Paul Dale_

- Added support for KMAC in KBKDF.

  _Shane Lontis_

- RNDR and RNDRRS support in provider functions to provide
  random number generation for Arm CPUs (aarch64).

  _Orr Toledano_

- `s_client` and `s_server` commands now explicitly say when the TLS version
  does not include the renegotiation mechanism. This avoids confusion
  between that scenario versus when the TLS version includes secure
  renegotiation but the peer lacks support for it.

  _Felipe Gasper_

- AES-GCM enabled with AVX512 vAES and vPCLMULQDQ.

  _Tomasz Kantecki, Andrey Matyukov_

- The various OBJ\_\* functions have been made thread safe.

  _Paul Dale_

- Parallel dual-prime 1536/2048-bit modular exponentiation for
  AVX512_IFMA capable processors.

  _Sergey Kirillov, Andrey Matyukov (Intel Corp)_

- The functions `OPENSSL_LH_stats`, `OPENSSL_LH_node_stats`,
  `OPENSSL_LH_node_usage_stats`, `OPENSSL_LH_stats_bio`,
  `OPENSSL_LH_node_stats_bio` and `OPENSSL_LH_node_usage_stats_bio` are now
  marked deprecated from OpenSSL 3.1 onwards and can be disabled by defining
  `OPENSSL_NO_DEPRECATED_3_1`.

  The macro `DEFINE_LHASH_OF` is now deprecated in favour of the macro
  `DEFINE_LHASH_OF_EX`, which omits the corresponding type-specific function
  definitions for these functions regardless of whether
  `OPENSSL_NO_DEPRECATED_3_1` is defined.

  Users of `DEFINE_LHASH_OF` may start receiving deprecation warnings for these
  functions regardless of whether they are using them. It is recommended that
  users transition to the new macro, `DEFINE_LHASH_OF_EX`.

  _Hugo Landau_

- When generating safe-prime DH parameters set the recommended private key
  length equivalent to minimum key lengths as in RFC 7919.

  _Tomáš Mráz_

- Change the default salt length for PKCS#1 RSASSA-PSS signatures to the
  maximum size that is smaller or equal to the digest length to comply with
  FIPS 186-4 section 5. This is implemented by a new option
  `OSSL_PKEY_RSA_PSS_SALT_LEN_AUTO_DIGEST_MAX` ("auto-digestmax") for the
  `rsa_pss_saltlen` parameter, which is now the default. Signature
  verification is not affected by this change and continues to work as before.

  _Clemens Lang_

## OpenSSL 3.0

For OpenSSL 3.0 a [Migration guide][] has been added, so the CHANGES entries
listed here are only a brief description.
The migration guide contains more detailed information related to new features,
breaking changes, and mappings for the large list of deprecated functions.

[Migration guide]: https://github.com/openssl/openssl/tree/master/doc/man7/migration_guide.pod

### Changes between 3.0.7 and 3.0.8 [7 Feb 2023]

- Fixed NULL dereference during PKCS7 data verification.

  A NULL pointer can be dereferenced when signatures are being
  verified on PKCS7 signed or signedAndEnveloped data. In case the hash
  algorithm used for the signature is known to the OpenSSL library but
  the implementation of the hash algorithm is not available the digest
  initialization will fail. There is a missing check for the return
  value from the initialization function which later leads to invalid
  usage of the digest API most likely leading to a crash.
  ([CVE-2023-0401])

  PKCS7 data is processed by the SMIME library calls and also by the
  time stamp (TS) library calls. The TLS implementation in OpenSSL does
  not call these functions however third party applications would be
  affected if they call these functions to verify signatures on untrusted
  data.

  _Tomáš Mráz_

- Fixed X.400 address type confusion in X.509 GeneralName.

  There is a type confusion vulnerability relating to X.400 address processing
  inside an X.509 GeneralName. X.400 addresses were parsed as an ASN1_STRING
  but the public structure definition for GENERAL_NAME incorrectly specified
  the type of the x400Address field as ASN1_TYPE. This field is subsequently
  interpreted by the OpenSSL function GENERAL_NAME_cmp as an ASN1_TYPE rather
  than an ASN1_STRING.

  When CRL checking is enabled (i.e. the application sets the
  X509_V_FLAG_CRL_CHECK flag), this vulnerability may allow an attacker to
  pass arbitrary pointers to a memcmp call, enabling them to read memory
  contents or enact a denial of service.
  ([CVE-2023-0286])

  _Hugo Landau_

- Fixed NULL dereference validating DSA public key.

  An invalid pointer dereference on read can be triggered when an
  application tries to check a malformed DSA public key by the
  EVP_PKEY_public_check() function. This will most likely lead
  to an application crash. This function can be called on public
  keys supplied from untrusted sources which could allow an attacker
  to cause a denial of service attack.

  The TLS implementation in OpenSSL does not call this function
  but applications might call the function if there are additional
  security requirements imposed by standards such as FIPS 140-3.
  ([CVE-2023-0217])

  _Shane Lontis, Tomáš Mráz_

- Fixed Invalid pointer dereference in d2i_PKCS7 functions.

  An invalid pointer dereference on read can be triggered when an
  application tries to load malformed PKCS7 data with the
  d2i_PKCS7(), d2i_PKCS7_bio() or d2i_PKCS7_fp() functions.

  The result of the dereference is an application crash which could
  lead to a denial of service attack. The TLS implementation in OpenSSL
  does not call this function however third party applications might
  call these functions on untrusted data.
  ([CVE-2023-0216])

  _Tomáš Mráz_

- Fixed Use-after-free following BIO_new_NDEF.

  The public API function BIO_new_NDEF is a helper function used for
  streaming ASN.1 data via a BIO. It is primarily used internally to OpenSSL
  to support the SMIME, CMS and PKCS7 streaming capabilities, but may also
  be called directly by end user applications.

  The function receives a BIO from the caller, prepends a new BIO_f_asn1
  filter BIO onto the front of it to form a BIO chain, and then returns
  the new head of the BIO chain to the caller. Under certain conditions,
  for example if a CMS recipient public key is invalid, the new filter BIO
  is freed and the function returns a NULL result indicating a failure.
  However, in this case, the BIO chain is not properly cleaned up and the
  BIO passed by the caller still retains internal pointers to the previously
  freed filter BIO. If the caller then goes on to call BIO_pop() on the BIO
  then a use-after-free will occur. This will most likely result in a crash.
  ([CVE-2023-0215])

  _Viktor Dukhovni, Matt Caswell_

- Fixed Double free after calling PEM_read_bio_ex.

  The function PEM_read_bio_ex() reads a PEM file from a BIO and parses and
  decodes the "name" (e.g. "CERTIFICATE"), any header data and the payload
  data. If the function succeeds then the "name_out", "header" and "data"
  arguments are populated with pointers to buffers containing the relevant
  decoded data. The caller is responsible for freeing those buffers. It is
  possible to construct a PEM file that results in 0 bytes of payload data.
  In this case PEM_read_bio_ex() will return a failure code but will populate
  the header argument with a pointer to a buffer that has already been freed.
  If the caller also frees this buffer then a double free will occur. This
  will most likely lead to a crash.

  The functions PEM_read_bio() and PEM_read() are simple wrappers around
  PEM_read_bio_ex() and therefore these functions are also directly affected.

  These functions are also called indirectly by a number of other OpenSSL
  functions including PEM_X509_INFO_read_bio_ex() and
  SSL_CTX_use_serverinfo_file() which are also vulnerable. Some OpenSSL
  internal uses of these functions are not vulnerable because the caller does
  not free the header argument if PEM_read_bio_ex() returns a failure code.
  ([CVE-2022-4450])

  _Kurt Roeckx, Matt Caswell_

- Fixed Timing Oracle in RSA Decryption.

  A timing based side channel exists in the OpenSSL RSA Decryption
  implementation which could be sufficient to recover a plaintext across
  a network in a Bleichenbacher style attack. To achieve a successful
  decryption an attacker would have to be able to send a very large number
  of trial messages for decryption. The vulnerability affects all RSA padding
  modes: PKCS#1 v1.5, RSA-OEAP and RSASVE.
  ([CVE-2022-4304])

  _Dmitry Belyavsky, Hubert Kario_

- Fixed X.509 Name Constraints Read Buffer Overflow.

  A read buffer overrun can be triggered in X.509 certificate verification,
  specifically in name constraint checking. The read buffer overrun might
  result in a crash which could lead to a denial of service attack.
  In a TLS client, this can be triggered by connecting to a malicious
  server. In a TLS server, this can be triggered if the server requests
  client authentication and a malicious client connects.
  ([CVE-2022-4203])

  _Viktor Dukhovni_

- Fixed X.509 Policy Constraints Double Locking security issue.

  If an X.509 certificate contains a malformed policy constraint and
  policy processing is enabled, then a write lock will be taken twice
  recursively. On some operating systems (most widely: Windows) this
  results in a denial of service when the affected process hangs. Policy
  processing being enabled on a publicly facing server is not considered
  to be a common setup.
  ([CVE-2022-3996])

  _Paul Dale_

- Our provider implementations of `OSSL_FUNC_KEYMGMT_EXPORT` and
  `OSSL_FUNC_KEYMGMT_GET_PARAMS` for EC and SM2 keys now honor
  `OSSL_PKEY_PARAM_EC_POINT_CONVERSION_FORMAT` as set (and
  default to `POINT_CONVERSION_UNCOMPRESSED`) when exporting
  `OSSL_PKEY_PARAM_PUB_KEY`, instead of unconditionally using
  `POINT_CONVERSION_COMPRESSED` as in previous 3.x releases.
  For symmetry, our implementation of `EVP_PKEY_ASN1_METHOD->export_to`
  for legacy EC and SM2 keys is also changed similarly to honor the
  equivalent conversion format flag as specified in the underlying
  `EC_KEY` object being exported to a provider, when this function is
  called through `EVP_PKEY_export()`.

  _Nicola Tuveri_

### Changes between 3.0.6 and 3.0.7 [1 Nov 2022]

- Fixed two buffer overflows in punycode decoding functions.

  A buffer overrun can be triggered in X.509 certificate verification,
  specifically in name constraint checking. Note that this occurs after
  certificate chain signature verification and requires either a CA to
  have signed the malicious certificate or for the application to continue
  certificate verification despite failure to construct a path to a trusted
  issuer.

  In a TLS client, this can be triggered by connecting to a malicious
  server. In a TLS server, this can be triggered if the server requests
  client authentication and a malicious client connects.

  An attacker can craft a malicious email address to overflow
  an arbitrary number of bytes containing the `.` character (decimal 46)
  on the stack. This buffer overflow could result in a crash (causing a
  denial of service).
  ([CVE-2022-3786])

  An attacker can craft a malicious email address to overflow four
  attacker-controlled bytes on the stack. This buffer overflow could
  result in a crash (causing a denial of service) or potentially remote code
  execution depending on stack layout for any given platform/compiler.
  ([CVE-2022-3602])

  _Paul Dale_

- Removed all references to invalid OSSL_PKEY_PARAM_RSA names for CRT
  parameters in OpenSSL code.
  Applications should not use the names OSSL_PKEY_PARAM_RSA_FACTOR,
  OSSL_PKEY_PARAM_RSA_EXPONENT and OSSL_PKEY_PARAM_RSA_COEFFICIENT.
  Use the numbered names such as OSSL_PKEY_PARAM_RSA_FACTOR1 instead.
  Using these invalid names may cause algorithms to use slower methods
  that ignore the CRT parameters.

  _Shane Lontis_

- Fixed a regression introduced in 3.0.6 version raising errors on some stack
  operations.

  _Tomáš Mráz_

- Fixed a regression introduced in 3.0.6 version not refreshing the certificate
  data to be signed before signing the certificate.

  _Gibeom Gwon_

- Added RIPEMD160 to the default provider.

  _Paul Dale_

- Ensured that the key share group sent or accepted for the key exchange
  is allowed for the protocol version.

  _Matt Caswell_

### Changes between 3.0.5 and 3.0.6 [11 Oct 2022]

- OpenSSL supports creating a custom cipher via the legacy
  EVP_CIPHER_meth_new() function and associated function calls. This function
  was deprecated in OpenSSL 3.0 and application authors are instead encouraged
  to use the new provider mechanism in order to implement custom ciphers.

  OpenSSL versions 3.0.0 to 3.0.5 incorrectly handle legacy custom ciphers
  passed to the EVP_EncryptInit_ex2(), EVP_DecryptInit_ex2() and
  EVP_CipherInit_ex2() functions (as well as other similarly named encryption
  and decryption initialisation functions). Instead of using the custom cipher
  directly it incorrectly tries to fetch an equivalent cipher from the
  available providers. An equivalent cipher is found based on the NID passed to
  EVP_CIPHER_meth_new(). This NID is supposed to represent the unique NID for a
  given cipher. However it is possible for an application to incorrectly pass
  NID_undef as this value in the call to EVP_CIPHER_meth_new(). When NID_undef
  is used in this way the OpenSSL encryption/decryption initialisation function
  will match the NULL cipher as being equivalent and will fetch this from the
  available providers. This will succeed if the default provider has been
  loaded (or if a third party provider has been loaded that offers this
  cipher). Using the NULL cipher means that the plaintext is emitted as the
  ciphertext.

  Applications are only affected by this issue if they call
  EVP_CIPHER_meth_new() using NID_undef and subsequently use it in a call to an
  encryption/decryption initialisation function. Applications that only use
  SSL/TLS are not impacted by this issue.
  ([CVE-2022-3358])

  _Matt Caswell_

- Fix LLVM vs Apple LLVM version numbering confusion that caused build failures
  on MacOS 10.11

  _Richard Levitte_

- Fixed the linux-mips64 Configure target which was missing the
  SIXTY_FOUR_BIT bn_ops flag. This was causing heap corruption on that
  platform.

  _Adam Joseph_

- Fix handling of a ticket key callback that returns 0 in TLSv1.3 to not send a
  ticket

  _Matt Caswell_

- Correctly handle a retransmitted ClientHello in DTLS

  _Matt Caswell_

- Fixed detection of ktls support in cross-compile environment on Linux

  _Tomas Mraz_

- Fixed some regressions and test failures when running the 3.0.0 FIPS provider
  against 3.0.x

  _Paul Dale_

- Fixed SSL_pending() and SSL_has_pending() with DTLS which were failing to
  report correct results in some cases

  _Matt Caswell_

- Fix UWP builds by defining VirtualLock

  _Charles Milette_

- For known safe primes use the minimum key length according to RFC 7919.
  Longer private key sizes unnecessarily raise the cycles needed to compute the
  shared secret without any increase of the real security. This fixes a
  regression from 1.1.1 where these shorter keys were generated for the known
  safe primes.

  _Tomas Mraz_

- Added the loongarch64 target

  _Shi Pujin_

- Fixed EC ASM flag passing. Flags for ASM implementations of EC curves were
  only passed to the FIPS provider and not to the default or legacy provider.

  _Juergen Christ_

- Fixed reported performance degradation on aarch64. Restored the
  implementation prior to commit 2621751 ("aes/asm/aesv8-armx.pl: avoid
  32-bit lane assignment in CTR mode") for 64bit targets only, since it is
  reportedly 2-17% slower and the silicon errata only affects 32bit targets.
  The new algorithm is still used for 32 bit targets.

  _Bernd Edlinger_

- Added a missing header for memcmp that caused compilation failure on some
  platforms

  _Gregor Jasny_

### Changes between 3.0.4 and 3.0.5 [5 Jul 2022]

- The OpenSSL 3.0.4 release introduced a serious bug in the RSA
  implementation for X86_64 CPUs supporting the AVX512IFMA instructions.
  This issue makes the RSA implementation with 2048 bit private keys
  incorrect on such machines and memory corruption will happen during
  the computation. As a consequence of the memory corruption an attacker
  may be able to trigger a remote code execution on the machine performing
  the computation.

  SSL/TLS servers or other servers using 2048 bit RSA private keys running
  on machines supporting AVX512IFMA instructions of the X86_64 architecture
  are affected by this issue.
  ([CVE-2022-2274])

  _Xi Ruoyao_

- AES OCB mode for 32-bit x86 platforms using the AES-NI assembly optimised
  implementation would not encrypt the entirety of the data under some
  circumstances. This could reveal sixteen bytes of data that was
  preexisting in the memory that wasn't written. In the special case of
  "in place" encryption, sixteen bytes of the plaintext would be revealed.

  Since OpenSSL does not support OCB based cipher suites for TLS and DTLS,
  they are both unaffected.
  ([CVE-2022-2097])

  _Alex Chernyakhovsky, David Benjamin, Alejandro Sedeño_

### Changes between 3.0.3 and 3.0.4 [21 Jun 2022]

- In addition to the c_rehash shell command injection identified in
  CVE-2022-1292, further bugs where the c_rehash script does not
  properly sanitise shell metacharacters to prevent command injection have been
  fixed.

  When the CVE-2022-1292 was fixed it was not discovered that there
  are other places in the script where the file names of certificates
  being hashed were possibly passed to a command executed through the shell.

  This script is distributed by some operating systems in a manner where
  it is automatically executed. On such operating systems, an attacker
  could execute arbitrary commands with the privileges of the script.

  Use of the c_rehash script is considered obsolete and should be replaced
  by the OpenSSL rehash command line tool.
  (CVE-2022-2068)

  _Daniel Fiala, Tomáš Mráz_

- Case insensitive string comparison no longer uses locales. It has instead
  been directly implemented.

  _Paul Dale_

### Changes between 3.0.2 and 3.0.3 [3 May 2022]

- Case insensitive string comparison is reimplemented via new locale-agnostic
  comparison functions OPENSSL_str[n]casecmp always using the POSIX locale for
  comparison. The previous implementation had problems when the Turkish locale
  was used.

  _Dmitry Belyavskiy_

- Fixed a bug in the c_rehash script which was not properly sanitising shell
  metacharacters to prevent command injection. This script is distributed by
  some operating systems in a manner where it is automatically executed. On
  such operating systems, an attacker could execute arbitrary commands with the
  privileges of the script.

  Use of the c_rehash script is considered obsolete and should be replaced
  by the OpenSSL rehash command line tool.
  (CVE-2022-1292)

  _Tomáš Mráz_

- Fixed a bug in the function `OCSP_basic_verify` that verifies the signer
  certificate on an OCSP response. The bug caused the function in the case
  where the (non-default) flag OCSP_NOCHECKS is used to return a postivie
  response (meaning a successful verification) even in the case where the
  response signing certificate fails to verify.

  It is anticipated that most users of `OCSP_basic_verify` will not use the
  OCSP_NOCHECKS flag. In this case the `OCSP_basic_verify` function will return
  a negative value (indicating a fatal error) in the case of a certificate
  verification failure. The normal expected return value in this case would be 0.

  This issue also impacts the command line OpenSSL "ocsp" application. When
  verifying an ocsp response with the "-no_cert_checks" option the command line
  application will report that the verification is successful even though it
  has in fact failed. In this case the incorrect successful response will also
  be accompanied by error messages showing the failure and contradicting the
  apparently successful result.
  ([CVE-2022-1343])

  _Matt Caswell_

- Fixed a bug where the RC4-MD5 ciphersuite incorrectly used the
  AAD data as the MAC key. This made the MAC key trivially predictable.

  An attacker could exploit this issue by performing a man-in-the-middle attack
  to modify data being sent from one endpoint to an OpenSSL 3.0 recipient such
  that the modified data would still pass the MAC integrity check.

  Note that data sent from an OpenSSL 3.0 endpoint to a non-OpenSSL 3.0
  endpoint will always be rejected by the recipient and the connection will
  fail at that point. Many application protocols require data to be sent from
  the client to the server first. Therefore, in such a case, only an OpenSSL
  3.0 server would be impacted when talking to a non-OpenSSL 3.0 client.

  If both endpoints are OpenSSL 3.0 then the attacker could modify data being
  sent in both directions. In this case both clients and servers could be
  affected, regardless of the application protocol.

  Note that in the absence of an attacker this bug means that an OpenSSL 3.0
  endpoint communicating with a non-OpenSSL 3.0 endpoint will fail to complete
  the handshake when using this ciphersuite.

  The confidentiality of data is not impacted by this issue, i.e. an attacker
  cannot decrypt data that has been encrypted using this ciphersuite - they can
  only modify it.

  In order for this attack to work both endpoints must legitimately negotiate
  the RC4-MD5 ciphersuite. This ciphersuite is not compiled by default in
  OpenSSL 3.0, and is not available within the default provider or the default
  ciphersuite list. This ciphersuite will never be used if TLSv1.3 has been
  negotiated. In order for an OpenSSL 3.0 endpoint to use this ciphersuite the
  following must have occurred:
  1.  OpenSSL must have been compiled with the (non-default) compile time option
      enable-weak-ssl-ciphers

  2.  OpenSSL must have had the legacy provider explicitly loaded (either
      through application code or via configuration)

  3.  The ciphersuite must have been explicitly added to the ciphersuite list

  4.  The libssl security level must have been set to 0 (default is 1)

  5.  A version of SSL/TLS below TLSv1.3 must have been negotiated

  6.  Both endpoints must negotiate the RC4-MD5 ciphersuite in preference to any
      others that both endpoints have in common
      (CVE-2022-1434)

  _Matt Caswell_

- Fix a bug in the OPENSSL_LH_flush() function that breaks reuse of the memory
  occupied by the removed hash table entries.

  This function is used when decoding certificates or keys. If a long lived
  process periodically decodes certificates or keys its memory usage will
  expand without bounds and the process might be terminated by the operating
  system causing a denial of service. Also traversing the empty hash table
  entries will take increasingly more time.

  Typically such long lived processes might be TLS clients or TLS servers
  configured to accept client certificate authentication.
  (CVE-2022-1473)

  _Hugo Landau, Aliaksei Levin_

- The functions `OPENSSL_LH_stats` and `OPENSSL_LH_stats_bio` now only report
  the `num_items`, `num_nodes` and `num_alloc_nodes` statistics. All other
  statistics are no longer supported. For compatibility, these statistics are
  still listed in the output but are now always reported as zero.

  _Hugo Landau_

### Changes between 3.0.1 and 3.0.2 [15 Mar 2022]

- Fixed a bug in the BN_mod_sqrt() function that can cause it to loop forever
  for non-prime moduli.

  Internally this function is used when parsing certificates that contain
  elliptic curve public keys in compressed form or explicit elliptic curve
  parameters with a base point encoded in compressed form.

  It is possible to trigger the infinite loop by crafting a certificate that
  has invalid explicit curve parameters.

  Since certificate parsing happens prior to verification of the certificate
  signature, any process that parses an externally supplied certificate may thus
  be subject to a denial of service attack. The infinite loop can also be
  reached when parsing crafted private keys as they can contain explicit
  elliptic curve parameters.

  Thus vulnerable situations include:
  - TLS clients consuming server certificates
  - TLS servers consuming client certificates
  - Hosting providers taking certificates or private keys from customers
  - Certificate authorities parsing certification requests from subscribers
  - Anything else which parses ASN.1 elliptic curve parameters

  Also any other applications that use the BN_mod_sqrt() where the attacker
  can control the parameter values are vulnerable to this DoS issue.
  ([CVE-2022-0778])

  _Tomáš Mráz_

- Add ciphersuites based on DHE_PSK (RFC 4279) and ECDHE_PSK (RFC 5489)
  to the list of ciphersuites providing Perfect Forward Secrecy as
  required by SECLEVEL >= 3.

  _Dmitry Belyavskiy, Nicola Tuveri_

- Made the AES constant time code for no-asm configurations
  optional due to the resulting 95% performance degradation.
  The AES constant time code can be enabled, for no assembly
  builds, with: ./config no-asm -DOPENSSL_AES_CONST_TIME

  _Paul Dale_

- Fixed PEM_write_bio_PKCS8PrivateKey() to make it possible to use empty
  passphrase strings.

  _Darshan Sen_

- The negative return value handling of the certificate verification callback
  was reverted. The replacement is to set the verification retry state with
  the SSL_set_retry_verify() function.

  _Tomáš Mráz_

### Changes between 3.0.0 and 3.0.1 [14 Dec 2021]

- Fixed carry bug in BN_mod_exp which may produce incorrect results on MIPS
  squaring procedure. Many EC algorithms are affected, including some of the
  TLS 1.3 default curves. Impact was not analyzed in detail, because the
  pre-requisites for attack are considered unlikely and include reusing
  private keys. Analysis suggests that attacks against RSA and DSA as a result
  of this defect would be very difficult to perform and are not believed
  likely. Attacks against DH are considered just feasible (although very
  difficult) because most of the work necessary to deduce information about
  a private key may be performed offline.
  The amount of resources required for such an attack would be significant.
  However, for an attack on TLS to be meaningful, the server would have
  to share the DH private key among multiple clients, which is no longer
  an option since CVE-2016-0701.
  The issue only affects OpenSSL on MIPS platforms.
  ([CVE-2021-4160])

  _Bernd Edlinger_

- Fixed invalid handling of X509_verify_cert() internal errors in libssl
  Internally libssl in OpenSSL calls X509_verify_cert() on the client side to
  verify a certificate supplied by a server. That function may return a
  negative return value to indicate an internal error (for example out of
  memory). Such a negative return value is mishandled by OpenSSL and will cause
  an IO function (such as SSL_connect() or SSL_do_handshake()) to not indicate
  success and a subsequent call to SSL_get_error() to return the value
  SSL_ERROR_WANT_RETRY_VERIFY. This return value is only supposed to be
  returned by OpenSSL if the application has previously called
  SSL_CTX_set_cert_verify_callback(). Since most applications do not do this
  the SSL_ERROR_WANT_RETRY_VERIFY return value from SSL_get_error() will be
  totally unexpected and applications may not behave correctly as a result. The
  exact behaviour will depend on the application but it could result in
  crashes, infinite loops or other similar incorrect responses.

  This issue is made more serious in combination with a separate bug in OpenSSL
  3.0 that will cause X509_verify_cert() to indicate an internal error when
  processing a certificate chain. This will occur where a certificate does not
  include the Subject Alternative Name extension but where a Certificate
  Authority has enforced name constraints. This issue can occur even with valid
  chains.
  ([CVE-2021-4044])

  _Matt Caswell_

- Corrected a few file name and file reference bugs in the build,
  installation and setup scripts, which lead to installation verification
  failures. Slightly enhanced the installation verification script.

  _Richard Levitte_

- Fixed EVP_PKEY_eq() to make it possible to use it with strictly private
  keys.

  _Richard Levitte_

- Fixed PVK encoder to properly query for the passphrase.

  _Tomáš Mráz_

- Multiple fixes in the OSSL_HTTP API functions.

  _David von Oheimb_

- Allow sign extension in OSSL_PARAM_allocate_from_text() for the
  OSSL_PARAM_INTEGER data type and return error on negative numbers
  used with the OSSL_PARAM_UNSIGNED_INTEGER data type. Make
  OSSL_PARAM_BLD_push_BN{,\_pad}() return an error on negative numbers.

  _Richard Levitte_

- Allow copying uninitialized digest contexts with EVP_MD_CTX_copy_ex.

  _Tomáš Mráz_

- Fixed detection of ARMv7 and ARM64 CPU features on FreeBSD.

  _Allan Jude_

- Multiple threading fixes.

  _Matt Caswell_

- Added NULL digest implementation to keep compatibility with 1.1.1 version.

  _Tomáš Mráz_

- Allow fetching an operation from the provider that owns an unexportable key
  as a fallback if that is still allowed by the property query.

  _Richard Levitte_

### Changes between 1.1.1 and 3.0.0 [7 Sep 2021]

- TLS_MAX_VERSION, DTLS_MAX_VERSION and DTLS_MIN_VERSION constants are now
  deprecated.

  _Matt Caswell_

- The `OPENSSL_s390xcap` environment variable can be used to set bits in the
  S390X capability vector to zero. This simplifies testing of different code
  paths on S390X architecture.

  _Patrick Steuer_

- Encrypting more than 2^64 TLS records with AES-GCM is disallowed
  as per FIPS 140-2 IG A.5 "Key/IV Pair Uniqueness Requirements from
  SP 800-38D". The communication will fail at this point.

  _Paul Dale_

- The EC_GROUP_clear_free() function is deprecated as there is nothing
  confidential in EC_GROUP data.

  _Nicola Tuveri_

- The byte order mark (BOM) character is ignored if encountered at the
  beginning of a PEM-formatted file.

  _Dmitry Belyavskiy_

- Added CMS support for the Russian GOST algorithms.

  _Dmitry Belyavskiy_

- Due to move of the implementation of cryptographic operations
  to the providers, validation of various operation parameters can
  be postponed until the actual operation is executed where previously
  it happened immediately when an operation parameter was set.

  For example when setting an unsupported curve with
  EVP_PKEY_CTX_set_ec_paramgen_curve_nid() this function call will not
  fail but later keygen operations with the EVP_PKEY_CTX will fail.

  _OpenSSL team members and many third party contributors_

- The EVP_get_cipherbyname() function will return NULL for algorithms such as
  "AES-128-SIV", "AES-128-CBC-CTS" and "CAMELLIA-128-CBC-CTS" which were
  previously only accessible via low-level interfaces. Use EVP_CIPHER_fetch()
  instead to retrieve these algorithms from a provider.

  _Shane Lontis_

- On build targets where the multilib postfix is set in the build
  configuration the libdir directory was changing based on whether
  the lib directory with the multilib postfix exists on the system
  or not. This unpredictable behavior was removed and eventual
  multilib postfix is now always added to the default libdir. Use
  `--libdir=lib` to override the libdir if adding the postfix is
  undesirable.

  _Jan Lána_

- The triple DES key wrap functionality now conforms to RFC 3217 but is
  no longer interoperable with OpenSSL 1.1.1.

  _Paul Dale_

- The ERR_GET_FUNC() function was removed. With the loss of meaningful
  function codes, this function can only cause problems for calling
  applications.

  _Paul Dale_

- Add a configurable flag to output date formats as ISO 8601. Does not
  change the default date format.

  _William Edmisten_

- Version of MSVC earlier than 1300 could get link warnings, which could
  be suppressed if the undocumented -DI_CAN_LIVE_WITH_LNK4049 was set.
  Support for this flag has been removed.

  _Rich Salz_

- Rework and make DEBUG macros consistent. Remove unused -DCONF_DEBUG,
  -DBN_CTX_DEBUG, and REF_PRINT. Add a new tracing category and use it for
  printing reference counts. Rename -DDEBUG_UNUSED to -DUNUSED_RESULT_DEBUG
  Fix BN_DEBUG_RAND so it compiles and, when set, force DEBUG_RAND to be set
  also. Rename engine_debug_ref to be ENGINE_REF_PRINT also for consistency.

  _Rich Salz_

- The signatures of the functions to get and set options on SSL and
  SSL_CTX objects changed from "unsigned long" to "uint64_t" type.
  Some source code changes may be required.

  _Rich Salz_

- The public definitions of conf_method_st and conf_st have been
  deprecated. They will be made opaque in a future release.

  _Rich Salz and Tomáš Mráz_

- Client-initiated renegotiation is disabled by default. To allow it, use
  the -client_renegotiation option, the SSL_OP_ALLOW_CLIENT_RENEGOTIATION
  flag, or the "ClientRenegotiation" config parameter as appropriate.

  _Rich Salz_

- Add "abspath" and "includedir" pragma's to config files, to prevent,
  or modify relative pathname inclusion.

  _Rich Salz_

- OpenSSL includes a cryptographic module that is intended to be FIPS 140-2
  validated. Please consult the README-FIPS and
  README-PROVIDERS files, as well as the migration guide.

  _OpenSSL team members and many third party contributors_

- For the key types DH and DHX the allowed settable parameters are now different.

  _Shane Lontis_

- The openssl commands that read keys, certificates, and CRLs now
  automatically detect the PEM or DER format of the input files.

  _David von Oheimb, Richard Levitte, and Tomáš Mráz_

- Added enhanced PKCS#12 APIs which accept a library context.

  _Jon Spillett_

- The default manual page suffix ($MANSUFFIX) has been changed to "ossl"

  _Matt Caswell_

- Added support for Kernel TLS (KTLS).

  _Boris Pismenny, John Baldwin and Andrew Gallatin_

- Support for RFC 5746 secure renegotiation is now required by default for
  SSL or TLS connections to succeed.

  _Benjamin Kaduk_

- The signature of the `copy` functional parameter of the
  EVP_PKEY_meth_set_copy() function has changed so its `src` argument is
  now `const EVP_PKEY_CTX *` instead of `EVP_PKEY_CTX *`. Similarly
  the signature of the `pub_decode` functional parameter of the
  EVP_PKEY_asn1_set_public() function has changed so its `pub` argument is
  now `const X509_PUBKEY *` instead of `X509_PUBKEY *`.

  _David von Oheimb_

- The error return values from some control calls (ctrl) have changed.

  _Paul Dale_

- A public key check is now performed during EVP_PKEY_derive_set_peer().

  _Shane Lontis_

- Many functions in the EVP\_ namespace that are getters of values from
  implementations or contexts were renamed to include get or get0 in their
  names. Old names are provided as macro aliases for compatibility and
  are not deprecated.

  _Tomáš Mráz_

- The EVP_PKEY_CTRL_PKCS7_ENCRYPT, EVP_PKEY_CTRL_PKCS7_DECRYPT,
  EVP_PKEY_CTRL_PKCS7_SIGN, EVP_PKEY_CTRL_CMS_ENCRYPT,
  EVP_PKEY_CTRL_CMS_DECRYPT, and EVP_PKEY_CTRL_CMS_SIGN control operations
  are deprecated.

  _Tomáš Mráz_

- The EVP_PKEY_public_check() and EVP_PKEY_param_check() functions now work for
  more key types.

- The output from the command line applications may have minor
  changes.

  _Paul Dale_

- The output from numerous "printing" may have minor changes.

  _David von Oheimb_

- Windows thread synchronization uses read/write primitives (SRWLock) when
  supported by the OS, otherwise CriticalSection continues to be used.

  _Vincent Drake_

- Add filter BIO BIO_f_readbuffer() that allows BIO_tell() and BIO_seek() to
  work on read only BIO source/sinks that do not support these functions.
  This allows piping or redirection of a file BIO using stdin to be buffered
  into memory. This is used internally in OSSL_DECODER_from_bio().

  _Shane Lontis_

- OSSL_STORE_INFO_get_type() may now return an additional value. In 1.1.1
  this function would return one of the values OSSL_STORE_INFO_NAME,
  OSSL_STORE_INFO_PKEY, OSSL_STORE_INFO_PARAMS, OSSL_STORE_INFO_CERT or
  OSSL_STORE_INFO_CRL. Decoded public keys would previously have been reported
  as type OSSL_STORE_INFO_PKEY in 1.1.1. In 3.0 decoded public keys are now
  reported as having the new type OSSL_STORE_INFO_PUBKEY. Applications
  using this function should be amended to handle the changed return value.

  _Richard Levitte_

- Improved adherence to Enhanced Security Services (ESS, RFC 2634 and RFC 5035)
  for the TSP and CMS Advanced Electronic Signatures (CAdES) implementations.
  As required by RFC 5035 check both ESSCertID and ESSCertIDv2 if both present.
  Correct the semantics of checking the validation chain in case ESSCertID{,v2}
  contains more than one certificate identifier: This means that all
  certificates referenced there MUST be part of the validation chain.

  _David von Oheimb_

- The implementation of older EVP ciphers related to CAST, IDEA, SEED, RC2, RC4,
  RC5, DESX and DES have been moved to the legacy provider.

  _Matt Caswell_

- The implementation of the EVP digests MD2, MD4, MDC2, WHIRLPOOL and
  RIPEMD-160 have been moved to the legacy provider.

  _Matt Caswell_

- The deprecated function EVP_PKEY_get0() now returns NULL being called for a
  provided key.

  _Dmitry Belyavskiy_

- The deprecated functions EVP_PKEY_get0_RSA(),
  EVP_PKEY_get0_DSA(), EVP_PKEY_get0_EC_KEY(), EVP_PKEY_get0_DH(),
  EVP_PKEY_get0_hmac(), EVP_PKEY_get0_poly1305() and EVP_PKEY_get0_siphash() as
  well as the similarly named "get1" functions behave differently in
  OpenSSL 3.0.

  _Matt Caswell_

- A number of functions handling low-level keys or engines were deprecated
  including EVP_PKEY_set1_engine(), EVP_PKEY_get0_engine(), EVP_PKEY_assign(),
  EVP_PKEY_get0(), EVP_PKEY_get0_hmac(), EVP_PKEY_get0_poly1305() and
  EVP_PKEY_get0_siphash().

  _Matt Caswell_

- PKCS#5 PBKDF1 key derivation has been moved from PKCS5_PBE_keyivgen() into
  the legacy crypto provider as an EVP_KDF. Applications requiring this KDF
  will need to load the legacy crypto provider. This includes these PBE
  algorithms which use this KDF:
  - NID_pbeWithMD2AndDES_CBC
  - NID_pbeWithMD5AndDES_CBC
  - NID_pbeWithSHA1AndRC2_CBC
  - NID_pbeWithMD2AndRC2_CBC
  - NID_pbeWithMD5AndRC2_CBC
  - NID_pbeWithSHA1AndDES_CBC

  _Jon Spillett_

- Deprecated obsolete BIO_set_callback(), BIO_get_callback(), and
  BIO_debug_callback() functions.

  _Tomáš Mráz_

- Deprecated obsolete EVP_PKEY_CTX_get0_dh_kdf_ukm() and
  EVP_PKEY_CTX_get0_ecdh_kdf_ukm() functions.

  _Tomáš Mráz_

- The RAND_METHOD APIs have been deprecated.

  _Paul Dale_

- The SRP APIs have been deprecated.

  _Matt Caswell_

- Add a compile time option to prevent the caching of provider fetched
  algorithms. This is enabled by including the no-cached-fetch option
  at configuration time.

  _Paul Dale_

- pkcs12 now uses defaults of PBKDF2, AES and SHA-256, with a MAC iteration
  count of PKCS12_DEFAULT_ITER.

  _Tomáš Mráz and Sahana Prasad_

- The openssl speed command does not use low-level API calls anymore.

  _Tomáš Mráz_

- Parallel dual-prime 1024-bit modular exponentiation for AVX512_IFMA
  capable processors.

  _Ilya Albrekht, Sergey Kirillov, Andrey Matyukov (Intel Corp)_

- Combining the Configure options no-ec and no-dh no longer disables TLSv1.3.

  _Matt Caswell_

- Implemented support for fully "pluggable" TLSv1.3 groups. This means that
  providers may supply their own group implementations (using either the "key
  exchange" or the "key encapsulation" methods) which will automatically be
  detected and used by libssl.

  _Matt Caswell, Nicola Tuveri_

- The undocumented function X509_certificate_type() has been deprecated;

  _Rich Salz_

- Deprecated the obsolete BN_pseudo_rand() and BN_pseudo_rand_range().

  _Tomáš Mráz_

- Removed RSA padding mode for SSLv23 (which was only used for
  SSLv2). This includes the functions RSA_padding_check_SSLv23() and
  RSA_padding_add_SSLv23() and the `-ssl` option in the deprecated
  `rsautl` command.

  _Rich Salz_

- Deprecated the obsolete X9.31 RSA key generation related functions.

- While a callback function set via `SSL_CTX_set_cert_verify_callback()`
  is not allowed to return a value > 1, this is no more taken as failure.

  _Viktor Dukhovni and David von Oheimb_

- Deprecated the obsolete X9.31 RSA key generation related functions
  BN_X931_generate_Xpq(), BN_X931_derive_prime_ex(), and
  BN_X931_generate_prime_ex().

  _Tomáš Mráz_

- The default key generation method for the regular 2-prime RSA keys was
  changed to the FIPS 186-4 B.3.6 method.

  _Shane Lontis_

- Deprecated the BN_is_prime_ex() and BN_is_prime_fasttest_ex() functions.

  _Kurt Roeckx_

- Deprecated EVP_MD_CTX_set_update_fn() and EVP_MD_CTX_update_fn().

  _Rich Salz_

- Deprecated the type OCSP*REQ_CTX and the functions OCSP_REQ_CTX*_() and
  replaced with OSSL*HTTP_REQ_CTX and the functions OSSL_HTTP_REQ_CTX*_().

  _Rich Salz, Richard Levitte, and David von Oheimb_

- Deprecated `X509_http_nbio()` and `X509_CRL_http_nbio()`.

  _David von Oheimb_

- Deprecated `OCSP_parse_url()`.

  _David von Oheimb_

- Validation of SM2 keys has been separated from the validation of regular EC
  keys.

  _Nicola Tuveri_

- Behavior of the `pkey` command is changed,
  when using the `-check` or `-pubcheck`
  switches: a validation failure triggers an early exit, returning a failure
  exit status to the parent process.

  _Nicola Tuveri_

- Changed behavior of SSL_CTX_set_ciphersuites() and SSL_set_ciphersuites()
  to ignore unknown ciphers.

  _Otto Hollmann_

- The `-cipher-commands` and `-digest-commands` options
  of the command line utility `list` have been deprecated.
  Instead use the `-cipher-algorithms` and `-digest-algorithms` options.

  _Dmitry Belyavskiy_

- Added convenience functions for generating asymmetric key pairs:
  The 'quick' one-shot (yet somewhat limited) function L<EVP_PKEY_Q_keygen(3)>
  and macros for the most common cases: <EVP_RSA_gen(3)> and L<EVP_EC_gen(3)>.

  _David von Oheimb_

- All of the low-level EC_KEY functions have been deprecated.

  _Shane Lontis, Paul Dale, Richard Levitte, and Tomáš Mráz_

- Deprecated all the libcrypto and libssl error string loading
  functions.

  _Richard Levitte_

- The functions SSL_CTX_set_tmp_dh_callback and SSL_set_tmp_dh_callback, as
  well as the macros SSL_CTX_set_tmp_dh() and SSL_set_tmp_dh() have been
  deprecated.

  _Matt Caswell_

- The `-crypt` option to the `passwd` command line tool has been removed.

  _Paul Dale_

- The -C option to the `x509`, `dhparam`, `dsaparam`, and `ecparam` commands
  were removed.

  _Rich Salz_

- Add support for AES Key Wrap inverse ciphers to the EVP layer.

  _Shane Lontis_

- Deprecated EVP_PKEY_set1_tls_encodedpoint() and
  EVP_PKEY_get1_tls_encodedpoint().

  _Matt Caswell_

- The security callback, which can be customised by application code, supports
  the security operation SSL_SECOP_TMP_DH. One location of the "other" parameter
  was incorrectly passing a DH object. It now passed an EVP_PKEY in all cases.

  _Matt Caswell_

- Add PKCS7_get_octet_string() and PKCS7_type_is_other() to the public
  interface. Their functionality remains unchanged.

  _Jordan Montgomery_

- Added new option for 'openssl list', '-providers', which will display the
  list of loaded providers, their names, version and status. It optionally
  displays their gettable parameters.

  _Paul Dale_

- Removed EVP_PKEY_set_alias_type().

  _Richard Levitte_

- Deprecated `EVP_PKEY_CTX_set_rsa_keygen_pubexp()` and introduced
  `EVP_PKEY_CTX_set1_rsa_keygen_pubexp()`, which is now preferred.

  _Jeremy Walch_

- Changed all "STACK" functions to be macros instead of inline functions. Macro
  parameters are still checked for type safety at compile time via helper
  inline functions.

  _Matt Caswell_

- Remove the RAND_DRBG API

  _Paul Dale and Matthias St. Pierre_

- Allow `SSL_set1_host()` and `SSL_add1_host()` to take IP literal addresses
  as well as actual hostnames.

  _David Woodhouse_

- The 'MinProtocol' and 'MaxProtocol' configuration commands now silently
  ignore TLS protocol version bounds when configuring DTLS-based contexts, and
  conversely, silently ignore DTLS protocol version bounds when configuring
  TLS-based contexts. The commands can be repeated to set bounds of both
  types. The same applies with the corresponding "min_protocol" and
  "max_protocol" command-line switches, in case some application uses both TLS
  and DTLS.

  SSL_CTX instances that are created for a fixed protocol version (e.g.
  `TLSv1_server_method()`) also silently ignore version bounds. Previously
  attempts to apply bounds to these protocol versions would result in an
  error. Now only the "version-flexible" SSL_CTX instances are subject to
  limits in configuration files in command-line options.

  _Viktor Dukhovni_

- Deprecated the `ENGINE` API. Engines should be replaced with providers
  going forward.

  _Paul Dale_

- Reworked the recorded ERR codes to make better space for system errors.
  To distinguish them, the macro `ERR_SYSTEM_ERROR()` indicates if the
  given code is a system error (true) or an OpenSSL error (false).

  _Richard Levitte_

- Reworked the test perl framework to better allow parallel testing.

  _Nicola Tuveri and David von Oheimb_

- Added ciphertext stealing algorithms AES-128-CBC-CTS, AES-192-CBC-CTS and
  AES-256-CBC-CTS to the providers. CS1, CS2 and CS3 variants are supported.

  _Shane Lontis_

- 'Configure' has been changed to figure out the configuration target if
  none is given on the command line. Consequently, the 'config' script is
  now only a mere wrapper. All documentation is changed to only mention
  'Configure'.

  _Rich Salz and Richard Levitte_

- Added a library context `OSSL_LIB_CTX` that applications as well as
  other libraries can use to form a separate context within which
  libcrypto operations are performed.

  _Richard Levitte_

- Added various `_ex` functions to the OpenSSL API that support using
  a non-default `OSSL_LIB_CTX`.

  _OpenSSL team_

- Handshake now fails if Extended Master Secret extension is dropped
  on renegotiation.

  _Tomáš Mráz_

- Dropped interactive mode from the `openssl` program.

  _Richard Levitte_

- Deprecated `EVP_PKEY_cmp()` and `EVP_PKEY_cmp_parameters()`.

  _David von Oheimb and Shane Lontis_

- Deprecated `EC_METHOD_get_field_type()`.

  _Billy Bob Brumley_

- Deprecated EC_GFp_simple_method(), EC_GFp_mont_method(),
  EC_GF2m_simple_method(), EC_GFp_nist_method(), EC_GFp_nistp224_method()
  EC_GFp_nistp256_method(), and EC_GFp_nistp521_method().

  _Billy Bob Brumley_

- Deprecated EC_GROUP_new(), EC_GROUP_method_of(), and EC_POINT_method_of().

  _Billy Bob Brumley_

- Add CAdES-BES signature verification support, mostly derived
  from ESSCertIDv2 TS (RFC 5816) contribution by Marek Klein.

  _Filipe Raimundo da Silva_

- Add CAdES-BES signature scheme and attributes support (RFC 5126) to CMS API.

  _Antonio Iacono_

- Added the AuthEnvelopedData content type structure (RFC 5083) with AES-GCM
  parameter (RFC 5084) for the Cryptographic Message Syntax (CMS).

  _Jakub Zelenka_

- Deprecated EC_POINT_make_affine() and EC_POINTs_make_affine().

  _Billy Bob Brumley_

- Deprecated EC_GROUP_precompute_mult(), EC_GROUP_have_precompute_mult(), and
  EC_KEY_precompute_mult().

  _Billy Bob Brumley_

- Deprecated EC_POINTs_mul().

  _Billy Bob Brumley_

- Removed FIPS_mode() and FIPS_mode_set().

  _Shane Lontis_

- The SSL option SSL_OP_IGNORE_UNEXPECTED_EOF is introduced.

  _Dmitry Belyavskiy_

- Deprecated EC_POINT_set_Jprojective_coordinates_GFp() and
  EC_POINT_get_Jprojective_coordinates_GFp().

  _Billy Bob Brumley_

- Added OSSL_PARAM_BLD to the public interface. This allows OSSL_PARAM
  arrays to be more easily constructed via a series of utility functions.
  Create a parameter builder using OSSL_PARAM_BLD_new(), add parameters using
  the various push functions and finally convert to a passable OSSL_PARAM
  array using OSSL_PARAM_BLD_to_param().

  _Paul Dale_

- The security strength of SHA1 and MD5 based signatures in TLS has been
  reduced.

  _Kurt Roeckx_

- Added EVP_PKEY_set_type_by_keymgmt(), to initialise an EVP_PKEY to
  contain a provider side internal key.

  _Richard Levitte_

- ASN1_verify(), ASN1_digest() and ASN1_sign() have been deprecated.

  _Richard Levitte_

- Project text documents not yet having a proper file name extension
  (`HACKING`, `LICENSE`, `NOTES*`, `README*`, `VERSION`) have been renamed to
  `*.md` as far as reasonable, else `*.txt`, for better use with file managers.

  _David von Oheimb_

- The main project documents (README, NEWS, CHANGES, INSTALL, SUPPORT)
  have been converted to Markdown with the goal to produce documents
  which not only look pretty when viewed online in the browser, but
  remain well readable inside a plain text editor.

  To achieve this goal, a 'minimalistic' Markdown style has been applied
  which avoids formatting elements that interfere too much with the
  reading flow in the text file. For example, it
  - avoids [ATX headings][] and uses [setext headings][] instead
    (which works for `<h1>` and `<h2>` headings only).
  - avoids [inline links][] and uses [reference links][] instead.
  - avoids [fenced code blocks][] and uses [indented code blocks][] instead.

    [ATX headings]: https://github.github.com/gfm/#atx-headings
    [setext headings]: https://github.github.com/gfm/#setext-headings
    [inline links]: https://github.github.com/gfm/#inline-link
    [reference links]: https://github.github.com/gfm/#reference-link
    [fenced code blocks]: https://github.github.com/gfm/#fenced-code-blocks
    [indented code blocks]: https://github.github.com/gfm/#indented-code-blocks

  _Matthias St. Pierre_

- The test suite is changed to preserve results of each test recipe.
  A new directory test-runs/ with subdirectories named like the
  test recipes are created in the build tree for this purpose.

  _Richard Levitte_

- Added an implementation of CMP and CRMF (RFC 4210, RFC 4211 RFC 6712).
  This adds `crypto/cmp/`, `crpyto/crmf/`, `apps/cmp.c`, and `test/cmp_*`.
  See L<openssl-cmp(1)> and L<OSSL_CMP_exec_IR_ses(3)> as starting points.

  _David von Oheimb, Martin Peylo_

- Generalized the HTTP client code from `crypto/ocsp/` into `crpyto/http/`.
  It supports arbitrary request and response content types, GET redirection,
  TLS, connections via HTTP(S) proxies, connections and exchange via
  user-defined BIOs (allowing implicit connections), persistent connections,
  and timeout checks. See L<OSSL_HTTP_transfer(3)> etc. for details.
  The legacy OCSP-focused (and only partly documented) API
  is retained for backward compatibility, while most of it is deprecated.

  _David von Oheimb_

- Added `util/check-format.pl`, a tool for checking adherence to the
  OpenSSL coding style <https://www.openssl.org/policies/codingstyle.html>.
  The checks performed are incomplete and yield some false positives.
  Still the tool should be useful for detecting most typical glitches.

  _David von Oheimb_

- `BIO_do_connect()` and `BIO_do_handshake()` have been extended:
  If domain name resolution yields multiple IP addresses all of them are tried
  after `connect()` failures.

  _David von Oheimb_

- All of the low-level RSA functions have been deprecated.

  _Paul Dale_

- X509 certificates signed using SHA1 are no longer allowed at security
  level 1 and above.

  _Kurt Roeckx_

- The command line utilities dhparam, dsa, gendsa and dsaparam have been
  modified to use PKEY APIs. These commands are now in maintenance mode
  and no new features will be added to them.

  _Paul Dale_

- The command line utility rsautl has been deprecated.

  _Paul Dale_

- The command line utilities genrsa and rsa have been modified to use PKEY
  APIs. They now write PKCS#8 keys by default. These commands are now in
  maintenance mode and no new features will be added to them.

  _Paul Dale_

- All of the low-level DH functions have been deprecated.

  _Paul Dale and Matt Caswell_

- All of the low-level DSA functions have been deprecated.

  _Paul Dale_

- Reworked the treatment of EC EVP_PKEYs with the SM2 curve to
  automatically become EVP_PKEY_SM2 rather than EVP_PKEY_EC.

  _Richard Levitte_

- Deprecated low-level ECDH and ECDSA functions.

  _Paul Dale_

- Deprecated EVP_PKEY_decrypt_old() and EVP_PKEY_encrypt_old().

  _Richard Levitte_

- Enhanced the documentation of EVP_PKEY_get_size(), EVP_PKEY_get_bits()
  and EVP_PKEY_get_security_bits(). Especially EVP_PKEY_get_size() needed
  a new formulation to include all the things it can be used for,
  as well as words of caution.

  _Richard Levitte_

- The SSL_CTX_set_tlsext_ticket_key_cb(3) function has been deprecated.

  _Paul Dale_

- All of the low-level HMAC functions have been deprecated.

  _Paul Dale and David von Oheimb_

- Over two thousand fixes were made to the documentation, including:
  - Common options (such as -rand/-writerand, TLS version control, etc)
    were refactored and point to newly-enhanced descriptions in openssl.pod.
  - Added style conformance for all options (with help from Richard Levitte),
    documented all reported missing options, added a CI build to check
    that all options are documented and that no unimplemented options
    are documented.
  - Documented some internals, such as all use of environment variables.
  - Addressed all internal broken L<> references.

  _Rich Salz_

- All of the low-level CMAC functions have been deprecated.

  _Paul Dale_

- The low-level MD2, MD4, MD5, MDC2, RIPEMD160 and Whirlpool digest
  functions have been deprecated.

  _Paul Dale and David von Oheimb_

- Corrected the documentation of the return values from the `EVP_DigestSign*`
  set of functions. The documentation mentioned negative values for some
  errors, but this was never the case, so the mention of negative values
  was removed.

  Code that followed the documentation and thereby check with something
  like `EVP_DigestSignInit(...) <= 0` will continue to work undisturbed.

  _Richard Levitte_

- All of the low-level cipher functions have been deprecated.

  _Matt Caswell and Paul Dale_

- Removed include/openssl/opensslconf.h.in and replaced it with
  include/openssl/configuration.h.in, which differs in not including
  <openssl/macros.h>. A short header include/openssl/opensslconf.h
  was added to include both.

  This allows internal hacks where one might need to modify the set
  of configured macros, for example this if deprecated symbols are
  still supposed to be available internally:

      #include <openssl/configuration.h>

      #undef OPENSSL_NO_DEPRECATED
      #define OPENSSL_SUPPRESS_DEPRECATED

      #include <openssl/macros.h>

  This should not be used by applications that use the exported
  symbols, as that will lead to linking errors.

  _Richard Levitte_

- Fixed an overflow bug in the x64_64 Montgomery squaring procedure
  used in exponentiation with 512-bit moduli. No EC algorithms are
  affected. Analysis suggests that attacks against 2-prime RSA1024,
  3-prime RSA1536, and DSA1024 as a result of this defect would be very
  difficult to perform and are not believed likely. Attacks against DH512
  are considered just feasible. However, for an attack the target would
  have to reuse the DH512 private key, which is not recommended anyway.
  Also applications directly using the low-level API BN_mod_exp may be
  affected if they use BN_FLG_CONSTTIME.
  ([CVE-2019-1551])

  _Andy Polyakov_

- Most memory-debug features have been deprecated, and the functionality
  replaced with no-ops.

  _Rich Salz_

- Added documentation for the STACK API.

  _Rich Salz_

- Introduced a new method type and API, OSSL_ENCODER, to represent
  generic encoders. These do the same sort of job that PEM writers
  and d2i functions do, but with support for methods supplied by
  providers, and the possibility for providers to support other
  formats as well.

  _Richard Levitte_

- Introduced a new method type and API, OSSL_DECODER, to represent
  generic decoders. These do the same sort of job that PEM readers
  and i2d functions do, but with support for methods supplied by
  providers, and the possibility for providers to support other
  formats as well.

  _Richard Levitte_

- Added a .pragma directive to the syntax of configuration files, to
  allow varying behavior in a supported and predictable manner.
  Currently added pragma:

          .pragma dollarid:on

  This allows dollar signs to be a keyword character unless it's
  followed by a opening brace or parenthesis. This is useful for
  platforms where dollar signs are commonly used in names, such as
  volume names and system directory names on VMS.

  _Richard Levitte_

- Added functionality to create an EVP_PKEY from user data.

  _Richard Levitte_

- Change the interpretation of the '--api' configuration option to
  mean that this is a desired API compatibility level with no
  further meaning. The previous interpretation, that this would
  also mean to remove all deprecated symbols up to and including
  the given version, no requires that 'no-deprecated' is also used
  in the configuration.

  When building applications, the desired API compatibility level
  can be set with the OPENSSL_API_COMPAT macro like before. For
  API compatibility version below 3.0, the old style numerical
  value is valid as before, such as -DOPENSSL_API_COMPAT=0x10100000L.
  For version 3.0 and on, the value is expected to be the decimal
  value calculated from the major and minor version like this:

          MAJOR * 10000 + MINOR * 100

  Examples:

          -DOPENSSL_API_COMPAT=30000             For 3.0
          -DOPENSSL_API_COMPAT=30200             For 3.2

  To hide declarations that are deprecated up to and including the
  given API compatibility level, -DOPENSSL_NO_DEPRECATED must be
  given when building the application as well.

  _Richard Levitte_

- Added the X509_LOOKUP_METHOD called X509_LOOKUP_store, to allow
  access to certificate and CRL stores via URIs and OSSL_STORE
  loaders.

  This adds the following functions:
  - X509_LOOKUP_store()
  - X509_STORE_load_file()
  - X509_STORE_load_path()
  - X509_STORE_load_store()
  - SSL_add_store_cert_subjects_to_stack()
  - SSL_CTX_set_default_verify_store()
  - SSL_CTX_load_verify_file()
  - SSL_CTX_load_verify_dir()
  - SSL_CTX_load_verify_store()

  _Richard Levitte_

- Added a new method to gather entropy on VMS, based on SYS$GET_ENTROPY.
  The presence of this system service is determined at run-time.

  _Richard Levitte_

- Added functionality to create an EVP_PKEY context based on data
  for methods from providers. This takes an algorithm name and a
  property query string and simply stores them, with the intent
  that any operation that uses this context will use those strings
  to fetch the needed methods implicitly, thereby making the port
  of application written for pre-3.0 OpenSSL easier.

  _Richard Levitte_

- The undocumented function NCONF_WIN32() has been deprecated; for
  conversion details see the HISTORY section of doc/man5/config.pod

  _Rich Salz_

- Introduced the new functions EVP_DigestSignInit_ex() and
  EVP_DigestVerifyInit_ex(). The macros EVP_DigestSignUpdate() and
  EVP_DigestVerifyUpdate() have been converted to functions. See the man
  pages for further details.

  _Matt Caswell_

- Over two thousand fixes were made to the documentation, including:
  adding missing command flags, better style conformance, documentation
  of internals, etc.

  _Rich Salz, Richard Levitte_

- s390x assembly pack: add hardware-support for P-256, P-384, P-521,
  X25519, X448, Ed25519 and Ed448.

  _Patrick Steuer_

- Print all values for a PKCS#12 attribute with 'openssl pkcs12', not just
  the first value.

  _Jon Spillett_

- Deprecated the public definition of `ERR_STATE` as well as the function
  `ERR_get_state()`. This is done in preparation of making `ERR_STATE` an
  opaque type.

  _Richard Levitte_

- Added ERR functionality to give callers access to the stored function
  names that have replaced the older function code based functions.

  New functions are ERR_peek_error_func(), ERR_peek_last_error_func(),
  ERR_peek_error_data(), ERR_peek_last_error_data(), ERR_get_error_all(),
  ERR_peek_error_all() and ERR_peek_last_error_all().

  Deprecate ERR functions ERR_get_error_line(), ERR_get_error_line_data(),
  ERR_peek_error_line_data(), ERR_peek_last_error_line_data() and
  ERR_func_error_string().

  _Richard Levitte_

- Extended testing to be verbose for failing tests only. The make variables
  VERBOSE_FAILURE or VF can be used to enable this:

          $ make VF=1 test                           # Unix
          $ mms /macro=(VF=1) test                   ! OpenVMS
          $ nmake VF=1 test                          # Windows

  _Richard Levitte_

- Added the `-copy_extensions` option to the `x509` command for use with
  `-req` and `-x509toreq`. When given with the `copy` or `copyall` argument,
  all extensions in the request are copied to the certificate or vice versa.

  _David von Oheimb_, _Kirill Stefanenkov <kirill_stefanenkov@rambler.ru>_

- Added the `-copy_extensions` option to the `req` command for use with
  `-x509`. When given with the `copy` or `copyall` argument,
  all extensions in the certification request are copied to the certificate.

  _David von Oheimb_

- The `x509`, `req`, and `ca` commands now make sure that X.509v3 certificates
  they generate are by default RFC 5280 compliant in the following sense:
  There is a subjectKeyIdentifier extension with a hash value of the public key
  and for not self-signed certs there is an authorityKeyIdentifier extension
  with a keyIdentifier field or issuer information identifying the signing key.
  This is done unless some configuration overrides the new default behavior,
  such as `subjectKeyIdentifier = none` and `authorityKeyIdentifier = none`.

  _David von Oheimb_

- Added several checks to `X509_verify_cert()` according to requirements in
  RFC 5280 in case `X509_V_FLAG_X509_STRICT` is set
  (which may be done by using the CLI option `-x509_strict`):
  - The basicConstraints of CA certificates must be marked critical.
  - CA certificates must explicitly include the keyUsage extension.
  - If a pathlenConstraint is given the key usage keyCertSign must be allowed.
  - The issuer name of any certificate must not be empty.
  - The subject name of CA certs, certs with keyUsage crlSign,
    and certs without subjectAlternativeName must not be empty.
  - If a subjectAlternativeName extension is given it must not be empty.
  - The signatureAlgorithm field and the cert signature must be consistent.
  - Any given authorityKeyIdentifier and any given subjectKeyIdentifier
    must not be marked critical.
  - The authorityKeyIdentifier must be given for X.509v3 certs
    unless they are self-signed.
  - The subjectKeyIdentifier must be given for all X.509v3 CA certs.

  _David von Oheimb_

- Certificate verification using `X509_verify_cert()` meanwhile rejects EC keys
  with explicit curve parameters (specifiedCurve) as required by RFC 5480.

  _Tomáš Mráz_

- For built-in EC curves, ensure an EC_GROUP built from the curve name is
  used even when parsing explicit parameters, when loading a encoded key
  or calling `EC_GROUP_new_from_ecpkparameters()`/
  `EC_GROUP_new_from_ecparameters()`.
  This prevents bypass of security hardening and performance gains,
  especially for curves with specialized EC_METHODs.
  By default, if a key encoded with explicit parameters is loaded and later
  encoded, the output is still encoded with explicit parameters, even if
  internally a "named" EC_GROUP is used for computation.

  _Nicola Tuveri_

- Compute ECC cofactors if not provided during EC_GROUP construction. Before
  this change, EC_GROUP_set_generator would accept order and/or cofactor as
  NULL. After this change, only the cofactor parameter can be NULL. It also
  does some minimal sanity checks on the passed order.
  ([CVE-2019-1547])

  _Billy Bob Brumley_

- Fixed a padding oracle in PKCS7_dataDecode and CMS_decrypt_set1_pkey.
  An attack is simple, if the first CMS_recipientInfo is valid but the
  second CMS_recipientInfo is chosen ciphertext. If the second
  recipientInfo decodes to PKCS #1 v1.5 form plaintext, the correct
  encryption key will be replaced by garbage, and the message cannot be
  decoded, but if the RSA decryption fails, the correct encryption key is
  used and the recipient will not notice the attack.
  As a work around for this potential attack the length of the decrypted
  key must be equal to the cipher default key length, in case the
  certificate is not given and all recipientInfo are tried out.
  The old behaviour can be re-enabled in the CMS code by setting the
  CMS_DEBUG_DECRYPT flag.

  _Bernd Edlinger_

- Early start up entropy quality from the DEVRANDOM seed source has been
  improved for older Linux systems. The RAND subsystem will wait for
  /dev/random to be producing output before seeding from /dev/urandom.
  The seeded state is stored for future library initialisations using
  a system global shared memory segment. The shared memory identifier
  can be configured by defining OPENSSL_RAND_SEED_DEVRANDOM_SHM_ID to
  the desired value. The default identifier is 114.

  _Paul Dale_

- Revised BN_generate_prime_ex to not avoid factors 2..17863 in p-1
  when primes for RSA keys are computed.
  Since we previously always generated primes == 2 (mod 3) for RSA keys,
  the 2-prime and 3-prime RSA modules were easy to distinguish, since
  `N = p*q = 1 (mod 3)`, but `N = p*q*r = 2 (mod 3)`. Therefore, fingerprinting
  2-prime vs. 3-prime RSA keys was possible by computing N mod 3.
  This avoids possible fingerprinting of newly generated RSA modules.

  _Bernd Edlinger_

- Correct the extended master secret constant on EBCDIC systems. Without this
  fix TLS connections between an EBCDIC system and a non-EBCDIC system that
  negotiate EMS will fail. Unfortunately this also means that TLS connections
  between EBCDIC systems with this fix, and EBCDIC systems without this
  fix will fail if they negotiate EMS.

  _Matt Caswell_

- Changed the library initialisation so that the config file is now loaded
  by default. This was already the case for libssl. It now occurs for both
  libcrypto and libssl. Use the OPENSSL_INIT_NO_LOAD_CONFIG option to
  `OPENSSL_init_crypto()` to suppress automatic loading of a config file.

  _Matt Caswell_

- Introduced new error raising macros, `ERR_raise()` and `ERR_raise_data()`,
  where the former acts as a replacement for `ERR_put_error()`, and the
  latter replaces the combination `ERR_put_error()` + `ERR_add_error_data()`.
  `ERR_raise_data()` adds more flexibility by taking a format string and
  an arbitrary number of arguments following it, to be processed with
  `BIO_snprintf()`.

  _Richard Levitte_

- Introduced a new function, `OSSL_PROVIDER_available()`, which can be used
  to check if a named provider is loaded and available. When called, it
  will also activate all fallback providers if such are still present.

  _Richard Levitte_

- Enforce a minimum DH modulus size of 512 bits.

  _Bernd Edlinger_

- Changed DH parameters to generate the order q subgroup instead of 2q.
  Previously generated DH parameters are still accepted by DH_check
  but DH_generate_key works around that by clearing bit 0 of the
  private key for those. This avoids leaking bit 0 of the private key.

  _Bernd Edlinger_

- Significantly reduce secure memory usage by the randomness pools.

  _Paul Dale_

- `{CRYPTO,OPENSSL}_mem_debug_{push,pop}` are now no-ops and have been
  deprecated.

  _Rich Salz_

- A new type, EVP_KEYEXCH, has been introduced to represent key exchange
  algorithms. An implementation of a key exchange algorithm can be obtained
  by using the function EVP_KEYEXCH_fetch(). An EVP_KEYEXCH algorithm can be
  used in a call to EVP_PKEY_derive_init_ex() which works in a similar way to
  the older EVP_PKEY_derive_init() function. See the man pages for the new
  functions for further details.

  _Matt Caswell_

- The EVP_PKEY_CTX_set_dh_pad() macro has now been converted to a function.

  _Matt Caswell_

- Removed the function names from error messages and deprecated the
  xxx_F_xxx define's.

  _Richard Levitte_

- Removed NextStep support and the macro OPENSSL_UNISTD

  _Rich Salz_

- Removed DES_check_key. Also removed OPENSSL_IMPLEMENT_GLOBAL,
  OPENSSL_GLOBAL_REF, OPENSSL_DECLARE_GLOBAL.
  Also removed "export var as function" capability; we do not export
  variables, only functions.

  _Rich Salz_

- RC5_32_set_key has been changed to return an int type, with 0 indicating
  an error and 1 indicating success. In previous versions of OpenSSL this
  was a void type. If a key was set longer than the maximum possible this
  would crash.

  _Matt Caswell_

- Support SM2 signing and verification schemes with X509 certificate.

  _Paul Yang_

- Use SHA256 as the default digest for TS query in the `ts` app.

  _Tomáš Mráz_

- Change PBKDF2 to conform to SP800-132 instead of the older PKCS5 RFC2898.

  _Shane Lontis_

- Default cipher lists/suites are now available via a function, the
  #defines are deprecated.

  _Todd Short_

- Add target VC-WIN32-UWP, VC-WIN64A-UWP, VC-WIN32-ARM-UWP and
  VC-WIN64-ARM-UWP in Windows OneCore target for making building libraries
  for Windows Store apps easier. Also, the "no-uplink" option has been added.

  _Kenji Mouri_

- Join the directories crypto/x509 and crypto/x509v3

  _Richard Levitte_

- Added command 'openssl kdf' that uses the EVP_KDF API.

  _Shane Lontis_

- Added command 'openssl mac' that uses the EVP_MAC API.

  _Shane Lontis_

- Added OPENSSL_info() to get diverse built-in OpenSSL data, such
  as default directories. Also added the command 'openssl info'
  for scripting purposes.

  _Richard Levitte_

- The functions AES_ige_encrypt() and AES_bi_ige_encrypt() have been
  deprecated.

  _Matt Caswell_

- Add prediction resistance to the DRBG reseeding process.

  _Paul Dale_

- Limit the number of blocks in a data unit for AES-XTS to 2^20 as
  mandated by IEEE Std 1619-2018.

  _Paul Dale_

- Added newline escaping functionality to a filename when using openssl dgst.
  This output format is to replicate the output format found in the `*sum`
  checksum programs. This aims to preserve backward compatibility.

  _Matt Eaton, Richard Levitte, and Paul Dale_

- Removed the heartbeat message in DTLS feature, as it has very
  little usage and doesn't seem to fulfill a valuable purpose.
  The configuration option is now deprecated.

  _Richard Levitte_

- Changed the output of 'openssl {digestname} < file' to display the
  digest name in its output.

  _Richard Levitte_

- Added a new generic trace API which provides support for enabling
  instrumentation through trace output.

  _Richard Levitte & Matthias St. Pierre_

- Added build tests for C++. These are generated files that only do one
  thing, to include one public OpenSSL head file each. This tests that
  the public header files can be usefully included in a C++ application.

  This test isn't enabled by default. It can be enabled with the option
  'enable-buildtest-c++'.

  _Richard Levitte_

- Added KB KDF (EVP_KDF_KB) to EVP_KDF.

  _Robbie Harwood_

- Added SSH KDF (EVP_KDF_SSHKDF) and KRB5 KDF (EVP_KDF_KRB5KDF) to EVP_KDF.

  _Simo Sorce_

- Added Single Step KDF (EVP_KDF_SS), X963 KDF, and X942 KDF to EVP_KDF.

  _Shane Lontis_

- Added KMAC to EVP_MAC.

  _Shane Lontis_

- Added property based algorithm implementation selection framework to
  the core.

  _Paul Dale_

- Added SCA hardening for modular field inversion in EC_GROUP through
  a new dedicated field_inv() pointer in EC_METHOD.
  This also addresses a leakage affecting conversions from projective
  to affine coordinates.

  _Billy Bob Brumley, Nicola Tuveri_

- Added EVP_KDF, an EVP layer KDF API, to simplify adding KDF and PRF
  implementations. This includes an EVP_PKEY to EVP_KDF bridge for
  those algorithms that were already supported through the EVP_PKEY API
  (scrypt, TLS1 PRF and HKDF). The low-level KDF functions for PBKDF2
  and scrypt are now wrappers that call EVP_KDF.

  _David Makepeace_

- Build devcrypto engine as a dynamic engine.

  _Eneas U de Queiroz_

- Add keyed BLAKE2 to EVP_MAC.

  _Antoine Salon_

- Fix a bug in the computation of the endpoint-pair shared secret used
  by DTLS over SCTP. This breaks interoperability with older versions
  of OpenSSL like OpenSSL 1.1.0 and OpenSSL 1.0.2. There is a runtime
  switch SSL_MODE_DTLS_SCTP_LABEL_LENGTH_BUG (off by default) enabling
  interoperability with such broken implementations. However, enabling
  this switch breaks interoperability with correct implementations.

- Fix a use after free bug in d2i_X509_PUBKEY when overwriting a
  reused X509_PUBKEY object if the second PUBKEY is malformed.

  _Bernd Edlinger_

- Move strictness check from EVP_PKEY_asn1_new() to EVP_PKEY_asn1_add0().

  _Richard Levitte_

- Changed the license to the Apache License v2.0.

  _Richard Levitte_

- Switch to a new version scheme using three numbers MAJOR.MINOR.PATCH.
  - Major releases (indicated by incrementing the MAJOR release number)
    may introduce incompatible API/ABI changes.
  - Minor releases (indicated by incrementing the MINOR release number)
    may introduce new features but retain API/ABI compatibility.
  - Patch releases (indicated by incrementing the PATCH number)
    are intended for bug fixes and other improvements of existing
    features only (like improving performance or adding documentation)
    and retain API/ABI compatibility.

  _Richard Levitte_

- Add support for RFC5297 SIV mode (siv128), including AES-SIV.

  _Todd Short_

- Remove the 'dist' target and add a tarball building script. The
  'dist' target has fallen out of use, and it shouldn't be
  necessary to configure just to create a source distribution.

  _Richard Levitte_

- Recreate the OS390-Unix config target. It no longer relies on a
  special script like it did for OpenSSL pre-1.1.0.

  _Richard Levitte_

- Instead of having the source directories listed in Configure, add
  a 'build.info' keyword SUBDIRS to indicate what sub-directories to
  look into.

  _Richard Levitte_

- Add GMAC to EVP_MAC.

  _Paul Dale_

- Ported the HMAC, CMAC and SipHash EVP_PKEY_METHODs to EVP_MAC.

  _Richard Levitte_

- Added EVP_MAC, an EVP layer MAC API, to simplify adding MAC
  implementations. This includes a generic EVP_PKEY to EVP_MAC bridge,
  to facilitate the continued use of MACs through raw private keys in
  functionality such as `EVP_DigestSign*` and `EVP_DigestVerify*`.

  _Richard Levitte_

- Deprecate ECDH_KDF_X9_62().

  _Antoine Salon_

- Added EVP_PKEY_ECDH_KDF_X9_63 and ecdh_KDF_X9_63() as replacements for
  the EVP_PKEY_ECDH_KDF_X9_62 KDF type and ECDH_KDF_X9_62(). The old names
  are retained for backwards compatibility.

  _Antoine Salon_

- AES-XTS mode now enforces that its two keys are different to mitigate
  the attacked described in "Efficient Instantiations of Tweakable
  Blockciphers and Refinements to Modes OCB and PMAC" by Phillip Rogaway.
  Details of this attack can be obtained from:
  <http://web.cs.ucdavis.edu/%7Erogaway/papers/offsets.pdf>

  _Paul Dale_

- Rename the object files, i.e. give them other names than in previous
  versions. Their names now include the name of the final product, as
  well as its type mnemonic (bin, lib, shlib).

  _Richard Levitte_

- Added new option for 'openssl list', '-objects', which will display the
  list of built in objects, i.e. OIDs with names.

  _Richard Levitte_

- Added the options `-crl_lastupdate` and `-crl_nextupdate` to `openssl ca`,
  allowing the `lastUpdate` and `nextUpdate` fields in the generated CRL to
  be set explicitly.

  _Chris Novakovic_

- Added support for Linux Kernel TLS data-path. The Linux Kernel data-path
  improves application performance by removing data copies and providing
  applications with zero-copy system calls such as sendfile and splice.

  _Boris Pismenny_

- The SSL option SSL_OP_CLEANSE_PLAINTEXT is introduced.

  _Martin Elshuber_

- `PKCS12_parse` now maintains the order of the parsed certificates
  when outputting them via `*ca` (rather than reversing it).

  _David von Oheimb_

- Deprecated pthread fork support methods.

  _Randall S. Becker_

- Added support for FFDHE key exchange in TLS 1.3.

  _Raja Ashok_

- Added a new concept for OpenSSL plugability: providers. This
  functionality is designed to replace the ENGINE API and ENGINE
  implementations, and to be much more dynamic, allowing provider
  authors to introduce new algorithms among other things, as long as
  there's an API that supports the algorithm type.

  With this concept comes a new core API for interaction between
  libcrypto and provider implementations. Public libcrypto functions
  that want to use providers do so through this core API.

  The main documentation for this core API is found in
  doc/man7/provider.pod, doc/man7/provider-base.pod, and they in turn
  refer to other manuals describing the API specific for supported
  algorithm types (also called operations).

  _The OpenSSL team_

## OpenSSL 1.1.1

### Changes between 1.1.1m and 1.1.1n [xx XXX xxxx]

### Changes between 1.1.1l and 1.1.1m [14 Dec 2021]

- Avoid loading of a dynamic engine twice.

  _Bernd Edlinger_

- Prioritise DANE TLSA issuer certs over peer certs

  _Viktor Dukhovni_

- Fixed random API for MacOS prior to 10.12

  These MacOS versions don't support the CommonCrypto APIs

  _Lenny Primak_

### Changes between 1.1.1k and 1.1.1l [24 Aug 2021]

- Fixed an SM2 Decryption Buffer Overflow.

  In order to decrypt SM2 encrypted data an application is expected to
  call the API function EVP_PKEY_decrypt(). Typically an application will
  call this function twice. The first time, on entry, the "out" parameter
  can be NULL and, on exit, the "outlen" parameter is populated with the
  buffer size required to hold the decrypted plaintext. The application
  can then allocate a sufficiently sized buffer and call EVP_PKEY_decrypt()
  again, but this time passing a non-NULL value for the "out" parameter.

  A bug in the implementation of the SM2 decryption code means that the
  calculation of the buffer size required to hold the plaintext returned
  by the first call to EVP_PKEY_decrypt() can be smaller than the actual
  size required by the second call. This can lead to a buffer overflow
  when EVP_PKEY_decrypt() is called by the application a second time with
  a buffer that is too small.

  A malicious attacker who is able present SM2 content for decryption to
  an application could cause attacker chosen data to overflow the buffer
  by up to a maximum of 62 bytes altering the contents of other data held
  after the buffer, possibly changing application behaviour or causing
  the application to crash. The location of the buffer is application
  dependent but is typically heap allocated.
  ([CVE-2021-3711])

  _Matt Caswell_

- Fixed various read buffer overruns processing ASN.1 strings

  ASN.1 strings are represented internally within OpenSSL as an ASN1_STRING
  structure which contains a buffer holding the string data and a field
  holding the buffer length. This contrasts with normal C strings which
  are represented as a buffer for the string data which is terminated
  with a NUL (0) byte.

  Although not a strict requirement, ASN.1 strings that are parsed using
  OpenSSL's own "d2i" functions (and other similar parsing functions) as
  well as any string whose value has been set with the ASN1_STRING_set()
  function will additionally NUL terminate the byte array in the
  ASN1_STRING structure.

  However, it is possible for applications to directly construct valid
  ASN1_STRING structures which do not NUL terminate the byte array by
  directly setting the "data" and "length" fields in the ASN1_STRING
  array. This can also happen by using the ASN1_STRING_set0() function.

  Numerous OpenSSL functions that print ASN.1 data have been found to
  assume that the ASN1_STRING byte array will be NUL terminated, even
  though this is not guaranteed for strings that have been directly
  constructed. Where an application requests an ASN.1 structure to be
  printed, and where that ASN.1 structure contains ASN1_STRINGs that have
  been directly constructed by the application without NUL terminating
  the "data" field, then a read buffer overrun can occur.

  The same thing can also occur during name constraints processing
  of certificates (for example if a certificate has been directly
  constructed by the application instead of loading it via the OpenSSL
  parsing functions, and the certificate contains non NUL terminated
  ASN1_STRING structures). It can also occur in the X509_get1_email(),
  X509_REQ_get1_email() and X509_get1_ocsp() functions.

  If a malicious actor can cause an application to directly construct an
  ASN1_STRING and then process it through one of the affected OpenSSL
  functions then this issue could be hit. This might result in a crash
  (causing a Denial of Service attack). It could also result in the
  disclosure of private memory contents (such as private keys, or
  sensitive plaintext).
  ([CVE-2021-3712])

  _Matt Caswell_

### Changes between 1.1.1j and 1.1.1k [25 Mar 2021]

- Fixed a problem with verifying a certificate chain when using the
  X509_V_FLAG_X509_STRICT flag. This flag enables additional security checks of
  the certificates present in a certificate chain. It is not set by default.

  Starting from OpenSSL version 1.1.1h a check to disallow certificates in
  the chain that have explicitly encoded elliptic curve parameters was added
  as an additional strict check.

  An error in the implementation of this check meant that the result of a
  previous check to confirm that certificates in the chain are valid CA
  certificates was overwritten. This effectively bypasses the check
  that non-CA certificates must not be able to issue other certificates.

  If a "purpose" has been configured then there is a subsequent opportunity
  for checks that the certificate is a valid CA. All of the named "purpose"
  values implemented in libcrypto perform this check. Therefore, where
  a purpose is set the certificate chain will still be rejected even when the
  strict flag has been used. A purpose is set by default in libssl client and
  server certificate verification routines, but it can be overridden or
  removed by an application.

  In order to be affected, an application must explicitly set the
  X509_V_FLAG_X509_STRICT verification flag and either not set a purpose
  for the certificate verification or, in the case of TLS client or server
  applications, override the default purpose.
  ([CVE-2021-3450])

  _Tomáš Mráz_

- Fixed an issue where an OpenSSL TLS server may crash if sent a maliciously
  crafted renegotiation ClientHello message from a client. If a TLSv1.2
  renegotiation ClientHello omits the signature_algorithms extension (where it
  was present in the initial ClientHello), but includes a
  signature_algorithms_cert extension then a NULL pointer dereference will
  result, leading to a crash and a denial of service attack.

  A server is only vulnerable if it has TLSv1.2 and renegotiation enabled
  (which is the default configuration). OpenSSL TLS clients are not impacted by
  this issue.
  ([CVE-2021-3449])

  _Peter Kästle and Samuel Sapalski_

### Changes between 1.1.1i and 1.1.1j [16 Feb 2021]

- Fixed the X509_issuer_and_serial_hash() function. It attempts to
  create a unique hash value based on the issuer and serial number data
  contained within an X509 certificate. However, it was failing to correctly
  handle any errors that may occur while parsing the issuer field (which might
  occur if the issuer field is maliciously constructed). This may subsequently
  result in a NULL pointer deref and a crash leading to a potential denial of
  service attack.
  ([CVE-2021-23841])

  _Matt Caswell_

- Fixed the RSA_padding_check_SSLv23() function and the RSA_SSLV23_PADDING
  padding mode to correctly check for rollback attacks. This is considered a
  bug in OpenSSL 1.1.1 because it does not support SSLv2. In 1.0.2 this is
  CVE-2021-23839.

  _Matt Caswell_

  Fixed the EVP_CipherUpdate, EVP_EncryptUpdate and EVP_DecryptUpdate
  functions. Previously they could overflow the output length argument in some
  cases where the input length is close to the maximum permissible length for
  an integer on the platform. In such cases the return value from the function
  call would be 1 (indicating success), but the output length value would be
  negative. This could cause applications to behave incorrectly or crash.
  ([CVE-2021-23840])

  _Matt Caswell_

- Fixed SRP_Calc_client_key so that it runs in constant time. The previous
  implementation called BN_mod_exp without setting BN_FLG_CONSTTIME. This
  could be exploited in a side channel attack to recover the password. Since
  the attack is local host only this is outside of the current OpenSSL
  threat model and therefore no CVE is assigned.

  Thanks to Mohammed Sabt and Daniel De Almeida Braga for reporting this
  issue.

  _Matt Caswell_

### Changes between 1.1.1h and 1.1.1i [8 Dec 2020]

- Fixed NULL pointer deref in the GENERAL_NAME_cmp function
  This function could crash if both GENERAL_NAMEs contain an EDIPARTYNAME.
  If an attacker can control both items being compared then this could lead
  to a possible denial of service attack. OpenSSL itself uses the
  GENERAL_NAME_cmp function for two purposes:
  1. Comparing CRL distribution point names between an available CRL and a
     CRL distribution point embedded in an X509 certificate
  2. When verifying that a timestamp response token signer matches the
     timestamp authority name (exposed via the API functions
     TS_RESP_verify_response and TS_RESP_verify_token)
     ([CVE-2020-1971])

  _Matt Caswell_

### Changes between 1.1.1g and 1.1.1h [22 Sep 2020]

- Certificates with explicit curve parameters are now disallowed in
  verification chains if the X509_V_FLAG_X509_STRICT flag is used.

  _Tomáš Mráz_

- The 'MinProtocol' and 'MaxProtocol' configuration commands now silently
  ignore TLS protocol version bounds when configuring DTLS-based contexts, and
  conversely, silently ignore DTLS protocol version bounds when configuring
  TLS-based contexts. The commands can be repeated to set bounds of both
  types. The same applies with the corresponding "min_protocol" and
  "max_protocol" command-line switches, in case some application uses both TLS
  and DTLS.

  SSL_CTX instances that are created for a fixed protocol version (e.g.
  TLSv1_server_method()) also silently ignore version bounds. Previously
  attempts to apply bounds to these protocol versions would result in an
  error. Now only the "version-flexible" SSL_CTX instances are subject to
  limits in configuration files in command-line options.

  _Viktor Dukhovni_

- Handshake now fails if Extended Master Secret extension is dropped
  on renegotiation.

  _Tomáš Mráz_

- The Oracle Developer Studio compiler will start reporting deprecated APIs

### Changes between 1.1.1f and 1.1.1g [21 Apr 2020]

- Fixed segmentation fault in SSL_check_chain()
  Server or client applications that call the SSL_check_chain() function
  during or after a TLS 1.3 handshake may crash due to a NULL pointer
  dereference as a result of incorrect handling of the
  "signature_algorithms_cert" TLS extension. The crash occurs if an invalid
  or unrecognised signature algorithm is received from the peer. This could
  be exploited by a malicious peer in a Denial of Service attack.
  ([CVE-2020-1967])

  _Benjamin Kaduk_

- Added AES consttime code for no-asm configurations
  an optional constant time support for AES was added
  when building openssl for no-asm.
  Enable with: ./config no-asm -DOPENSSL_AES_CONST_TIME
  Disable with: ./config no-asm -DOPENSSL_NO_AES_CONST_TIME
  At this time this feature is by default disabled.
  It will be enabled by default in 3.0.

  _Bernd Edlinger_

### Changes between 1.1.1e and 1.1.1f [31 Mar 2020]

- Revert the change of EOF detection while reading in libssl to avoid
  regressions in applications depending on the current way of reporting
  the EOF. As the existing method is not fully accurate the change to
  reporting the EOF via SSL_ERROR_SSL is kept on the current development
  branch and will be present in the 3.0 release.

  _Tomáš Mráz_

- Revised BN_generate_prime_ex to not avoid factors 3..17863 in p-1
  when primes for RSA keys are computed.
  Since we previously always generated primes == 2 (mod 3) for RSA keys,
  the 2-prime and 3-prime RSA modules were easy to distinguish, since
  N = p*q = 1 (mod 3), but N = p*q\*r = 2 (mod 3). Therefore, fingerprinting
  2-prime vs. 3-prime RSA keys was possible by computing N mod 3.
  This avoids possible fingerprinting of newly generated RSA modules.

  _Bernd Edlinger_

### Changes between 1.1.1d and 1.1.1e [17 Mar 2020]

- Properly detect EOF while reading in libssl. Previously if we hit an EOF
  while reading in libssl then we would report an error back to the
  application (SSL_ERROR_SYSCALL) but errno would be 0. We now add
  an error to the stack (which means we instead return SSL_ERROR_SSL) and
  therefore give a hint as to what went wrong.

  _Matt Caswell_

- Check that ed25519 and ed448 are allowed by the security level. Previously
  signature algorithms not using an MD were not being checked that they were
  allowed by the security level.

  _Kurt Roeckx_

- Fixed SSL_get_servername() behaviour. The behaviour of SSL_get_servername()
  was not quite right. The behaviour was not consistent between resumption
  and normal handshakes, and also not quite consistent with historical
  behaviour. The behaviour in various scenarios has been clarified and
  it has been updated to make it match historical behaviour as closely as
  possible.

  _Matt Caswell_

- _[VMS only]_ The header files that the VMS compilers include automatically,
  `__DECC_INCLUDE_PROLOGUE.H` and `__DECC_INCLUDE_EPILOGUE.H`, use pragmas
  that the C++ compiler doesn't understand. This is a shortcoming in the
  compiler, but can be worked around with `__cplusplus` guards.

  C++ applications that use OpenSSL libraries must be compiled using the
  qualifier `/NAMES=(AS_IS,SHORTENED)` to be able to use all the OpenSSL
  functions. Otherwise, only functions with symbols of less than 31
  characters can be used, as the linker will not be able to successfully
  resolve symbols with longer names.

  _Richard Levitte_

- Added a new method to gather entropy on VMS, based on SYS$GET_ENTROPY.
  The presence of this system service is determined at run-time.

  _Richard Levitte_

- Print all values for a PKCS#12 attribute with 'openssl pkcs12', not just
  the first value.

  _Jon Spillett_

### Changes between 1.1.1c and 1.1.1d [10 Sep 2019]

- Fixed a fork protection issue. OpenSSL 1.1.1 introduced a rewritten random
  number generator (RNG). This was intended to include protection in the
  event of a fork() system call in order to ensure that the parent and child
  processes did not share the same RNG state. However, this protection was not
  being used in the default case.

  A partial mitigation for this issue is that the output from a high
  precision timer is mixed into the RNG state so the likelihood of a parent
  and child process sharing state is significantly reduced.

  If an application already calls OPENSSL_init_crypto() explicitly using
  OPENSSL_INIT_ATFORK then this problem does not occur at all.
  ([CVE-2019-1549])

  _Matthias St. Pierre_

- For built-in EC curves, ensure an EC_GROUP built from the curve name is
  used even when parsing explicit parameters, when loading a encoded key
  or calling `EC_GROUP_new_from_ecpkparameters()`/
  `EC_GROUP_new_from_ecparameters()`.
  This prevents bypass of security hardening and performance gains,
  especially for curves with specialized EC_METHODs.
  By default, if a key encoded with explicit parameters is loaded and later
  encoded, the output is still encoded with explicit parameters, even if
  internally a "named" EC_GROUP is used for computation.

  _Nicola Tuveri_

- Compute ECC cofactors if not provided during EC_GROUP construction. Before
  this change, EC_GROUP_set_generator would accept order and/or cofactor as
  NULL. After this change, only the cofactor parameter can be NULL. It also
  does some minimal sanity checks on the passed order.
  ([CVE-2019-1547])

  _Billy Bob Brumley_

- Fixed a padding oracle in PKCS7_dataDecode and CMS_decrypt_set1_pkey.
  An attack is simple, if the first CMS_recipientInfo is valid but the
  second CMS_recipientInfo is chosen ciphertext. If the second
  recipientInfo decodes to PKCS #1 v1.5 form plaintext, the correct
  encryption key will be replaced by garbage, and the message cannot be
  decoded, but if the RSA decryption fails, the correct encryption key is
  used and the recipient will not notice the attack.
  As a work around for this potential attack the length of the decrypted
  key must be equal to the cipher default key length, in case the
  certificate is not given and all recipientInfo are tried out.
  The old behaviour can be re-enabled in the CMS code by setting the
  CMS_DEBUG_DECRYPT flag.
  ([CVE-2019-1563])

  _Bernd Edlinger_

- Early start up entropy quality from the DEVRANDOM seed source has been
  improved for older Linux systems. The RAND subsystem will wait for
  /dev/random to be producing output before seeding from /dev/urandom.
  The seeded state is stored for future library initialisations using
  a system global shared memory segment. The shared memory identifier
  can be configured by defining OPENSSL_RAND_SEED_DEVRANDOM_SHM_ID to
  the desired value. The default identifier is 114.

  _Paul Dale_

- Correct the extended master secret constant on EBCDIC systems. Without this
  fix TLS connections between an EBCDIC system and a non-EBCDIC system that
  negotiate EMS will fail. Unfortunately this also means that TLS connections
  between EBCDIC systems with this fix, and EBCDIC systems without this
  fix will fail if they negotiate EMS.

  _Matt Caswell_

- Use Windows installation paths in the mingw builds

  Mingw isn't a POSIX environment per se, which means that Windows
  paths should be used for installation.
  ([CVE-2019-1552])

  _Richard Levitte_

- Changed DH_check to accept parameters with order q and 2q subgroups.
  With order 2q subgroups the bit 0 of the private key is not secret
  but DH_generate_key works around that by clearing bit 0 of the
  private key for those. This avoids leaking bit 0 of the private key.

  _Bernd Edlinger_

- Significantly reduce secure memory usage by the randomness pools.

  _Paul Dale_

- Revert the DEVRANDOM_WAIT feature for Linux systems

  The DEVRANDOM_WAIT feature added a select() call to wait for the
  /dev/random device to become readable before reading from the
  /dev/urandom device.

  It turned out that this change had negative side effects on
  performance which were not acceptable. After some discussion it
  was decided to revert this feature and leave it up to the OS
  resp. the platform maintainer to ensure a proper initialization
  during early boot time.

  _Matthias St. Pierre_

### Changes between 1.1.1b and 1.1.1c [28 May 2019]

- Add build tests for C++. These are generated files that only do one
  thing, to include one public OpenSSL head file each. This tests that
  the public header files can be usefully included in a C++ application.

  This test isn't enabled by default. It can be enabled with the option
  'enable-buildtest-c++'.

  _Richard Levitte_

- Enable SHA3 pre-hashing for ECDSA and DSA.

  _Patrick Steuer_

- Change the default RSA, DSA and DH size to 2048 bit instead of 1024.
  This changes the size when using the `genpkey` command when no size is given.
  It fixes an omission in earlier changes that changed all RSA, DSA and DH
  generation commands to use 2048 bits by default.

  _Kurt Roeckx_

- Reorganize the manual pages to consistently have RETURN VALUES,
  EXAMPLES, SEE ALSO and HISTORY come in that order, and adjust
  util/fix-doc-nits accordingly.

  _Paul Yang, Joshua Lock_

- Add the missing accessor EVP_PKEY_get0_engine()

  _Matt Caswell_

- Have commands like `s_client` and `s_server` output the signature scheme
  along with other cipher suite parameters when debugging.

  _Lorinczy Zsigmond_

- Make OPENSSL_config() error agnostic again.

  _Richard Levitte_

- Do the error handling in RSA decryption constant time.

  _Bernd Edlinger_

- Prevent over long nonces in ChaCha20-Poly1305.

  ChaCha20-Poly1305 is an AEAD cipher, and requires a unique nonce input
  for every encryption operation. RFC 7539 specifies that the nonce value
  (IV) should be 96 bits (12 bytes). OpenSSL allows a variable nonce length
  and front pads the nonce with 0 bytes if it is less than 12
  bytes. However it also incorrectly allows a nonce to be set of up to 16
  bytes. In this case only the last 12 bytes are significant and any
  additional leading bytes are ignored.

  It is a requirement of using this cipher that nonce values are
  unique. Messages encrypted using a reused nonce value are susceptible to
  serious confidentiality and integrity attacks. If an application changes
  the default nonce length to be longer than 12 bytes and then makes a
  change to the leading bytes of the nonce expecting the new value to be a
  new unique nonce then such an application could inadvertently encrypt
  messages with a reused nonce.

  Additionally the ignored bytes in a long nonce are not covered by the
  integrity guarantee of this cipher. Any application that relies on the
  integrity of these ignored leading bytes of a long nonce may be further
  affected. Any OpenSSL internal use of this cipher, including in SSL/TLS,
  is safe because no such use sets such a long nonce value. However user
  applications that use this cipher directly and set a non-default nonce
  length to be longer than 12 bytes may be vulnerable.

  This issue was reported to OpenSSL on 16th of March 2019 by Joran Dirk
  Greef of Ronomon.
  ([CVE-2019-1543])

  _Matt Caswell_

- Add DEVRANDOM_WAIT feature for Linux systems

  On older Linux systems where the getrandom() system call is not available,
  OpenSSL normally uses the /dev/urandom device for seeding its CSPRNG.
  Contrary to getrandom(), the /dev/urandom device will not block during
  early boot when the kernel CSPRNG has not been seeded yet.

  To mitigate this known weakness, use select() to wait for /dev/random to
  become readable before reading from /dev/urandom.

- Ensure that SM2 only uses SM3 as digest algorithm

  _Paul Yang_

### Changes between 1.1.1a and 1.1.1b [26 Feb 2019]

- Change the info callback signals for the start and end of a post-handshake
  message exchange in TLSv1.3. In 1.1.1/1.1.1a we used SSL_CB_HANDSHAKE_START
  and SSL_CB_HANDSHAKE_DONE. Experience has shown that many applications get
  confused by this and assume that a TLSv1.2 renegotiation has started. This
  can break KeyUpdate handling. Instead we no longer signal the start and end
  of a post handshake message exchange (although the messages themselves are
  still signalled). This could break some applications that were expecting
  the old signals. However without this KeyUpdate is not usable for many
  applications.

  _Matt Caswell_

### Changes between 1.1.1 and 1.1.1a [20 Nov 2018]

- Timing vulnerability in DSA signature generation

  The OpenSSL DSA signature algorithm has been shown to be vulnerable to a
  timing side channel attack. An attacker could use variations in the signing
  algorithm to recover the private key.

  This issue was reported to OpenSSL on 16th October 2018 by Samuel Weiser.
  ([CVE-2018-0734])

  _Paul Dale_

- Timing vulnerability in ECDSA signature generation

  The OpenSSL ECDSA signature algorithm has been shown to be vulnerable to a
  timing side channel attack. An attacker could use variations in the signing
  algorithm to recover the private key.

  This issue was reported to OpenSSL on 25th October 2018 by Samuel Weiser.
  ([CVE-2018-0735])

  _Paul Dale_

- Fixed the issue that RAND_add()/RAND_seed() silently discards random input
  if its length exceeds 4096 bytes. The limit has been raised to a buffer size
  of two gigabytes and the error handling improved.

  This issue was reported to OpenSSL by Dr. Falko Strenzke. It has been
  categorized as a normal bug, not a security issue, because the DRBG reseeds
  automatically and is fully functional even without additional randomness
  provided by the application.

### Changes between 1.1.0i and 1.1.1 [11 Sep 2018]

- Add a new ClientHello callback. Provides a callback interface that gives
  the application the ability to adjust the nascent SSL object at the
  earliest stage of ClientHello processing, immediately after extensions have
  been collected but before they have been processed. In particular, this
  callback can adjust the supported TLS versions in response to the contents
  of the ClientHello

  _Benjamin Kaduk_

- Add SM2 base algorithm support.

  _Jack Lloyd_

- s390x assembly pack: add (improved) hardware-support for the following
  cryptographic primitives: sha3, shake, aes-gcm, aes-ccm, aes-ctr, aes-ofb,
  aes-cfb/cfb8, aes-ecb.

  _Patrick Steuer_

- Make EVP_PKEY_asn1_new() a bit stricter about its input. A NULL pem_str
  parameter is no longer accepted, as it leads to a corrupt table. NULL
  pem_str is reserved for alias entries only.

  _Richard Levitte_

- Use the new ec_scalar_mul_ladder scaffold to implement a specialized ladder
  step for prime curves. The new implementation is based on formulae from
  differential addition-and-doubling in homogeneous projective coordinates
  from Izu-Takagi "A fast parallel elliptic curve multiplication resistant
  against side channel attacks" and Brier-Joye "Weierstrass Elliptic Curves
  and Side-Channel Attacks" Eq. (8) for y-coordinate recovery, modified
  to work in projective coordinates.

  _Billy Bob Brumley, Nicola Tuveri_

- Change generating and checking of primes so that the error rate of not
  being prime depends on the intended use based on the size of the input.
  For larger primes this will result in more rounds of Miller-Rabin.
  The maximal error rate for primes with more than 1080 bits is lowered
  to 2^-128.

  _Kurt Roeckx, Annie Yousar_

- Increase the number of Miller-Rabin rounds for DSA key generating to 64.

  _Kurt Roeckx_

- The 'tsget' script is renamed to 'tsget.pl', to avoid confusion when
  moving between systems, and to avoid confusion when a Windows build is
  done with mingw vs with MSVC. For POSIX installs, there's still a
  symlink or copy named 'tsget' to avoid that confusion as well.

  _Richard Levitte_

- Revert blinding in ECDSA sign and instead make problematic addition
  length-invariant. Switch even to fixed-length Montgomery multiplication.

  _Andy Polyakov_

- Use the new ec_scalar_mul_ladder scaffold to implement a specialized ladder
  step for binary curves. The new implementation is based on formulae from
  differential addition-and-doubling in mixed Lopez-Dahab projective
  coordinates, modified to independently blind the operands.

  _Billy Bob Brumley, Sohaib ul Hassan, Nicola Tuveri_

- Add a scaffold to optionally enhance the Montgomery ladder implementation
  for `ec_scalar_mul_ladder` (formerly `ec_mul_consttime`) allowing
  EC_METHODs to implement their own specialized "ladder step", to take
  advantage of more favorable coordinate systems or more efficient
  differential addition-and-doubling algorithms.

  _Billy Bob Brumley, Sohaib ul Hassan, Nicola Tuveri_

- Modified the random device based seed sources to keep the relevant
  file descriptors open rather than reopening them on each access.
  This allows such sources to operate in a chroot() jail without
  the associated device nodes being available. This behaviour can be
  controlled using RAND_keep_random_devices_open().

  _Paul Dale_

- Numerous side-channel attack mitigations have been applied. This may have
  performance impacts for some algorithms for the benefit of improved
  security. Specific changes are noted in this change log by their respective
  authors.

  _Matt Caswell_

- AIX shared library support overhaul. Switch to AIX "natural" way of
  handling shared libraries, which means collecting shared objects of
  different versions and bitnesses in one common archive. This allows to
  mitigate conflict between 1.0 and 1.1 side-by-side installations. It
  doesn't affect the way 3rd party applications are linked, only how
  multi-version installation is managed.

  _Andy Polyakov_

- Make ec_group_do_inverse_ord() more robust and available to other
  EC cryptosystems, so that irrespective of BN_FLG_CONSTTIME, SCA
  mitigations are applied to the fallback BN_mod_inverse().
  When using this function rather than BN_mod_inverse() directly, new
  EC cryptosystem implementations are then safer-by-default.

  _Billy Bob Brumley_

- Add coordinate blinding for EC_POINT and implement projective
  coordinate blinding for generic prime curves as a countermeasure to
  chosen point SCA attacks.

  _Sohaib ul Hassan, Nicola Tuveri, Billy Bob Brumley_

- Add blinding to ECDSA and DSA signatures to protect against side channel
  attacks discovered by Keegan Ryan (NCC Group).

  _Matt Caswell_

- Enforce checking in the `pkeyutl` command to ensure that the input
  length does not exceed the maximum supported digest length when performing
  a sign, verify or verifyrecover operation.

  _Matt Caswell_

- SSL_MODE_AUTO_RETRY is enabled by default. Applications that use blocking
  I/O in combination with something like select() or poll() will hang. This
  can be turned off again using SSL_CTX_clear_mode().
  Many applications do not properly handle non-application data records, and
  TLS 1.3 sends more of such records. Setting SSL_MODE_AUTO_RETRY works
  around the problems in those applications, but can also break some.
  It's recommended to read the manpages about SSL_read(), SSL_write(),
  SSL_get_error(), SSL_shutdown(), SSL_CTX_set_mode() and
  SSL_CTX_set_read_ahead() again.

  _Kurt Roeckx_

- When unlocking a pass phrase protected PEM file or PKCS#8 container, we
  now allow empty (zero character) pass phrases.

  _Richard Levitte_

- Apply blinding to binary field modular inversion and remove patent
  pending (OPENSSL_SUN_GF2M_DIV) BN_GF2m_mod_div implementation.

  _Billy Bob Brumley_

- Deprecate ec2_mult.c and unify scalar multiplication code paths for
  binary and prime elliptic curves.

  _Billy Bob Brumley_

- Remove ECDSA nonce padding: EC_POINT_mul is now responsible for
  constant time fixed point multiplication.

  _Billy Bob Brumley_

- Revise elliptic curve scalar multiplication with timing attack
  defenses: ec*wNAF_mul redirects to a constant time implementation
  when computing fixed point and variable point multiplication (which
  in OpenSSL are mostly used with secret scalars in keygen, sign,
  ECDH derive operations).
  \_Billy Bob Brumley, Nicola Tuveri, Cesar Pereida García,
  Sohaib ul Hassan*

- Updated CONTRIBUTING

  _Rich Salz_

- Updated DRBG / RAND to request nonce and additional low entropy
  randomness from the system.

  _Matthias St. Pierre_

- Updated 'openssl rehash' to use OpenSSL consistent default.

  _Richard Levitte_

- Moved the load of the ssl_conf module to libcrypto, which helps
  loading engines that libssl uses before libssl is initialised.

  _Matt Caswell_

- Added EVP_PKEY_sign() and EVP_PKEY_verify() for EdDSA

  _Matt Caswell_

- Fixed X509_NAME_ENTRY_set to get multi-valued RDNs right in all cases.

  _Ingo Schwarze, Rich Salz_

- Added output of accepting IP address and port for 'openssl s_server'

  _Richard Levitte_

- Added a new API for TLSv1.3 ciphersuites:
  SSL_CTX_set_ciphersuites()
  SSL_set_ciphersuites()

  _Matt Caswell_

- Memory allocation failures consistently add an error to the error
  stack.

  _Rich Salz_

- Don't use OPENSSL_ENGINES and OPENSSL_CONF environment values
  in libcrypto when run as setuid/setgid.

  _Bernd Edlinger_

- Load any config file by default when libssl is used.

  _Matt Caswell_

- Added new public header file <openssl/rand_drbg.h> and documentation
  for the RAND_DRBG API. See manual page RAND_DRBG(7) for an overview.

  _Matthias St. Pierre_

- QNX support removed (cannot find contributors to get their approval
  for the license change).

  _Rich Salz_

- TLSv1.3 replay protection for early data has been implemented. See the
  SSL_read_early_data() man page for further details.

  _Matt Caswell_

- Separated TLSv1.3 ciphersuite configuration out from TLSv1.2 ciphersuite
  configuration. TLSv1.3 ciphersuites are not compatible with TLSv1.2 and
  below. Similarly TLSv1.2 ciphersuites are not compatible with TLSv1.3.
  In order to avoid issues where legacy TLSv1.2 ciphersuite configuration
  would otherwise inadvertently disable all TLSv1.3 ciphersuites the
  configuration has been separated out. See the ciphers man page or the
  SSL_CTX_set_ciphersuites() man page for more information.

  _Matt Caswell_

- On POSIX (BSD, Linux, ...) systems the ocsp(1) command running
  in responder mode now supports the new "-multi" option, which
  spawns the specified number of child processes to handle OCSP
  requests. The "-timeout" option now also limits the OCSP
  responder's patience to wait to receive the full client request
  on a newly accepted connection. Child processes are respawned
  as needed, and the CA index file is automatically reloaded
  when changed. This makes it possible to run the "ocsp" responder
  as a long-running service, making the OpenSSL CA somewhat more
  feature-complete. In this mode, most diagnostic messages logged
  after entering the event loop are logged via syslog(3) rather than
  written to stderr.

  _Viktor Dukhovni_

- Added support for X448 and Ed448. Heavily based on original work by
  Mike Hamburg.

  _Matt Caswell_

- Extend OSSL_STORE with capabilities to search and to narrow the set of
  objects loaded. This adds the functions OSSL_STORE_expect() and
  OSSL_STORE_find() as well as needed tools to construct searches and
  get the search data out of them.

  _Richard Levitte_

- Support for TLSv1.3 added. Note that users upgrading from an earlier
  version of OpenSSL should review their configuration settings to ensure
  that they are still appropriate for TLSv1.3. For further information see:
  <https://github.com/openssl/openssl/wiki/TLS1.3>

  _Matt Caswell_

- Grand redesign of the OpenSSL random generator

  The default RAND method now utilizes an AES-CTR DRBG according to
  NIST standard SP 800-90Ar1. The new random generator is essentially
  a port of the default random generator from the OpenSSL FIPS 2.0
  object module. It is a hybrid deterministic random bit generator
  using an AES-CTR bit stream and which seeds and reseeds itself
  automatically using trusted system entropy sources.

  Some of its new features are:
  - Support for multiple DRBG instances with seed chaining.
  - The default RAND method makes use of a DRBG.
  - There is a public and private DRBG instance.
  - The DRBG instances are fork-safe.
  - Keep all global DRBG instances on the secure heap if it is enabled.
  - The public and private DRBG instance are per thread for lock free
    operation

  _Paul Dale, Benjamin Kaduk, Kurt Roeckx, Rich Salz, Matthias St. Pierre_

- Changed Configure so it only says what it does and doesn't dump
  so much data. Instead, ./configdata.pm should be used as a script
  to display all sorts of configuration data.

  _Richard Levitte_

- Added processing of "make variables" to Configure.

  _Richard Levitte_

- Added SHA512/224 and SHA512/256 algorithm support.

  _Paul Dale_

- The last traces of Netware support, first removed in 1.1.0, have
  now been removed.

  _Rich Salz_

- Get rid of Makefile.shared, and in the process, make the processing
  of certain files (rc.obj, or the .def/.map/.opt files produced from
  the ordinal files) more visible and hopefully easier to trace and
  debug (or make silent).

  _Richard Levitte_

- Make it possible to have environment variable assignments as
  arguments to config / Configure.

  _Richard Levitte_

- Add multi-prime RSA (RFC 8017) support.

  _Paul Yang_

- Add SM3 implemented according to GB/T 32905-2016
  _Jack Lloyd <jack.lloyd@ribose.com>,_
  _Ronald Tse <ronald.tse@ribose.com>,_
  _Erick Borsboom <erick.borsboom@ribose.com>_

- Add 'Maximum Fragment Length' TLS extension negotiation and support
  as documented in RFC6066.
  Based on a patch from Tomasz Moń

  _Filipe Raimundo da Silva_

- Add SM4 implemented according to GB/T 32907-2016.
  _Jack Lloyd <jack.lloyd@ribose.com>,_
  _Ronald Tse <ronald.tse@ribose.com>,_
  _Erick Borsboom <erick.borsboom@ribose.com>_

- Reimplement -newreq-nodes and ERR_error_string_n; the
  original author does not agree with the license change.

  _Rich Salz_

- Add ARIA AEAD TLS support.

  _Jon Spillett_

- Some macro definitions to support VS6 have been removed. Visual
  Studio 6 has not worked since 1.1.0

  _Rich Salz_

- Add ERR_clear_last_mark(), to allow callers to clear the last mark
  without clearing the errors.

  _Richard Levitte_

- Add "atfork" functions. If building on a system that without
  pthreads, see doc/man3/OPENSSL_fork_prepare.pod for application
  requirements. The RAND facility now uses/requires this.

  _Rich Salz_

- Add SHA3.

  _Andy Polyakov_

- The UI API becomes a permanent and integral part of libcrypto, i.e.
  not possible to disable entirely. However, it's still possible to
  disable the console reading UI method, UI_OpenSSL() (use UI_null()
  as a fallback).

  To disable, configure with 'no-ui-console'. 'no-ui' is still
  possible to use as an alias. Check at compile time with the
  macro OPENSSL_NO_UI_CONSOLE. The macro OPENSSL_NO_UI is still
  possible to check and is an alias for OPENSSL_NO_UI_CONSOLE.

  _Richard Levitte_

- Add a STORE module, which implements a uniform and URI based reader of
  stores that can contain keys, certificates, CRLs and numerous other
  objects. The main API is loosely based on a few stdio functions,
  and includes OSSL_STORE_open, OSSL_STORE_load, OSSL_STORE_eof,
  OSSL_STORE_error and OSSL_STORE_close.
  The implementation uses backends called "loaders" to implement arbitrary
  URI schemes. There is one built in "loader" for the 'file' scheme.

  _Richard Levitte_

- Add devcrypto engine. This has been implemented against cryptodev-linux,
  then adjusted to work on FreeBSD 8.4 as well.
  Enable by configuring with 'enable-devcryptoeng'. This is done by default
  on BSD implementations, as cryptodev.h is assumed to exist on all of them.

  _Richard Levitte_

- Module names can prefixed with OSSL* or OPENSSL*. This affects
  util/mkerr.pl, which is adapted to allow those prefixes, leading to
  error code calls like this:

          OSSL_FOOerr(OSSL_FOO_F_SOMETHING, OSSL_FOO_R_WHATEVER);

  With this change, we claim the namespaces OSSL and OPENSSL in a manner
  that can be encoded in C. For the foreseeable future, this will only
  affect new modules.

  _Richard Levitte and Tim Hudson_

- Removed BSD cryptodev engine.

  _Rich Salz_

- Add a build target 'build_all_generated', to build all generated files
  and only that. This can be used to prepare everything that requires
  things like perl for a system that lacks perl and then move everything
  to that system and do the rest of the build there.

  _Richard Levitte_

- In the UI interface, make it possible to duplicate the user data. This
  can be used by engines that need to retain the data for a longer time
  than just the call where this user data is passed.

  _Richard Levitte_

- Ignore the '-named_curve auto' value for compatibility of applications
  with OpenSSL 1.0.2.

  _Tomáš Mráz <tmraz@fedoraproject.org>_

- Fragmented SSL/TLS alerts are no longer accepted. An alert message is 2
  bytes long. In theory it is permissible in SSLv3 - TLSv1.2 to fragment such
  alerts across multiple records (some of which could be empty). In practice
  it make no sense to send an empty alert record, or to fragment one. TLSv1.3
  prohibits this altogether and other libraries (BoringSSL, NSS) do not
  support this at all. Supporting it adds significant complexity to the
  record layer, and its removal is unlikely to cause interoperability
  issues.

  _Matt Caswell_

- Add the ASN.1 types INT32, UINT32, INT64, UINT64 and variants prefixed
  with Z. These are meant to replace LONG and ZLONG and to be size safe.
  The use of LONG and ZLONG is discouraged and scheduled for deprecation
  in OpenSSL 1.2.0.

  _Richard Levitte_

- Add the 'z' and 'j' modifiers to BIO_printf() et al formatting string,
  'z' is to be used for [s]size_t, and 'j' - with [u]int64_t.

  _Richard Levitte, Andy Polyakov_

- Add EC_KEY_get0_engine(), which does for EC_KEY what RSA_get0_engine()
  does for RSA, etc.

  _Richard Levitte_

- Have 'config' recognise 64-bit mingw and choose 'mingw64' as the target
  platform rather than 'mingw'.

  _Richard Levitte_

- The functions X509_STORE_add_cert and X509_STORE_add_crl return
  success if they are asked to add an object which already exists
  in the store. This change cascades to other functions which load
  certificates and CRLs.

  _Paul Dale_

- x86_64 assembly pack: annotate code with DWARF CFI directives to
  facilitate stack unwinding even from assembly subroutines.

  _Andy Polyakov_

- Remove VAX C specific definitions of OPENSSL_EXPORT, OPENSSL_EXTERN.
  Also remove OPENSSL_GLOBAL entirely, as it became a no-op.

  _Richard Levitte_

- Remove the VMS-specific reimplementation of gmtime from crypto/o_times.c.
  VMS C's RTL has a fully up to date gmtime() and gmtime_r() since V7.1,
  which is the minimum version we support.

  _Richard Levitte_

- Certificate time validation (X509_cmp_time) enforces stricter
  compliance with RFC 5280. Fractional seconds and timezone offsets
  are no longer allowed.

  _Emilia Käsper_

- Add support for ARIA

  _Paul Dale_

- s_client will now send the Server Name Indication (SNI) extension by
  default unless the new "-noservername" option is used. The server name is
  based on the host provided to the "-connect" option unless overridden by
  using "-servername".

  _Matt Caswell_

- Add support for SipHash

  _Todd Short_

- OpenSSL now fails if it receives an unrecognised record type in TLS1.0
  or TLS1.1. Previously this only happened in SSLv3 and TLS1.2. This is to
  prevent issues where no progress is being made and the peer continually
  sends unrecognised record types, using up resources processing them.

  _Matt Caswell_

- 'openssl passwd' can now produce SHA256 and SHA512 based output,
  using the algorithm defined in
  <https://www.akkadia.org/drepper/SHA-crypt.txt>

  _Richard Levitte_

- Heartbeat support has been removed; the ABI is changed for now.

  _Richard Levitte, Rich Salz_

- Support for SSL_OP_NO_ENCRYPT_THEN_MAC in SSL_CONF_cmd.

  _Emilia Käsper_

- The RSA "null" method, which was partially supported to avoid patent
  issues, has been replaced to always returns NULL.

  _Rich Salz_

## OpenSSL 1.1.0

### Changes between 1.1.0k and 1.1.0l [10 Sep 2019]

- For built-in EC curves, ensure an EC_GROUP built from the curve name is
  used even when parsing explicit parameters, when loading a encoded key
  or calling `EC_GROUP_new_from_ecpkparameters()`/
  `EC_GROUP_new_from_ecparameters()`.
  This prevents bypass of security hardening and performance gains,
  especially for curves with specialized EC_METHODs.
  By default, if a key encoded with explicit parameters is loaded and later
  encoded, the output is still encoded with explicit parameters, even if
  internally a "named" EC_GROUP is used for computation.

  _Nicola Tuveri_

- Compute ECC cofactors if not provided during EC_GROUP construction. Before
  this change, EC_GROUP_set_generator would accept order and/or cofactor as
  NULL. After this change, only the cofactor parameter can be NULL. It also
  does some minimal sanity checks on the passed order.
  ([CVE-2019-1547])

  _Billy Bob Brumley_

- Fixed a padding oracle in PKCS7_dataDecode and CMS_decrypt_set1_pkey.
  An attack is simple, if the first CMS_recipientInfo is valid but the
  second CMS_recipientInfo is chosen ciphertext. If the second
  recipientInfo decodes to PKCS #1 v1.5 form plaintext, the correct
  encryption key will be replaced by garbage, and the message cannot be
  decoded, but if the RSA decryption fails, the correct encryption key is
  used and the recipient will not notice the attack.
  As a work around for this potential attack the length of the decrypted
  key must be equal to the cipher default key length, in case the
  certificate is not given and all recipientInfo are tried out.
  The old behaviour can be re-enabled in the CMS code by setting the
  CMS_DEBUG_DECRYPT flag.
  ([CVE-2019-1563])

  _Bernd Edlinger_

- Use Windows installation paths in the mingw builds

  Mingw isn't a POSIX environment per se, which means that Windows
  paths should be used for installation.
  ([CVE-2019-1552])

  _Richard Levitte_

### Changes between 1.1.0j and 1.1.0k [28 May 2019]

- Change the default RSA, DSA and DH size to 2048 bit instead of 1024.
  This changes the size when using the `genpkey` command when no size is given.
  It fixes an omission in earlier changes that changed all RSA, DSA and DH
  generation commands to use 2048 bits by default.

  _Kurt Roeckx_

- Prevent over long nonces in ChaCha20-Poly1305.

  ChaCha20-Poly1305 is an AEAD cipher, and requires a unique nonce input
  for every encryption operation. RFC 7539 specifies that the nonce value
  (IV) should be 96 bits (12 bytes). OpenSSL allows a variable nonce length
  and front pads the nonce with 0 bytes if it is less than 12
  bytes. However it also incorrectly allows a nonce to be set of up to 16
  bytes. In this case only the last 12 bytes are significant and any
  additional leading bytes are ignored.

  It is a requirement of using this cipher that nonce values are
  unique. Messages encrypted using a reused nonce value are susceptible to
  serious confidentiality and integrity attacks. If an application changes
  the default nonce length to be longer than 12 bytes and then makes a
  change to the leading bytes of the nonce expecting the new value to be a
  new unique nonce then such an application could inadvertently encrypt
  messages with a reused nonce.

  Additionally the ignored bytes in a long nonce are not covered by the
  integrity guarantee of this cipher. Any application that relies on the
  integrity of these ignored leading bytes of a long nonce may be further
  affected. Any OpenSSL internal use of this cipher, including in SSL/TLS,
  is safe because no such use sets such a long nonce value. However user
  applications that use this cipher directly and set a non-default nonce
  length to be longer than 12 bytes may be vulnerable.

  This issue was reported to OpenSSL on 16th of March 2019 by Joran Dirk
  Greef of Ronomon.
  ([CVE-2019-1543])

  _Matt Caswell_

- Added SCA hardening for modular field inversion in EC_GROUP through
  a new dedicated field_inv() pointer in EC_METHOD.
  This also addresses a leakage affecting conversions from projective
  to affine coordinates.

  _Billy Bob Brumley, Nicola Tuveri_

- Fix a use after free bug in d2i_X509_PUBKEY when overwriting a
  reused X509_PUBKEY object if the second PUBKEY is malformed.

  _Bernd Edlinger_

- Move strictness check from EVP_PKEY_asn1_new() to EVP_PKEY_asn1_add0().

  _Richard Levitte_

- Remove the 'dist' target and add a tarball building script. The
  'dist' target has fallen out of use, and it shouldn't be
  necessary to configure just to create a source distribution.

  _Richard Levitte_

### Changes between 1.1.0i and 1.1.0j [20 Nov 2018]

- Timing vulnerability in DSA signature generation

  The OpenSSL DSA signature algorithm has been shown to be vulnerable to a
  timing side channel attack. An attacker could use variations in the signing
  algorithm to recover the private key.

  This issue was reported to OpenSSL on 16th October 2018 by Samuel Weiser.
  ([CVE-2018-0734])

  _Paul Dale_

- Timing vulnerability in ECDSA signature generation

  The OpenSSL ECDSA signature algorithm has been shown to be vulnerable to a
  timing side channel attack. An attacker could use variations in the signing
  algorithm to recover the private key.

  This issue was reported to OpenSSL on 25th October 2018 by Samuel Weiser.
  ([CVE-2018-0735])

  _Paul Dale_

- Add coordinate blinding for EC_POINT and implement projective
  coordinate blinding for generic prime curves as a countermeasure to
  chosen point SCA attacks.

  _Sohaib ul Hassan, Nicola Tuveri, Billy Bob Brumley_

### Changes between 1.1.0h and 1.1.0i [14 Aug 2018]

- Client DoS due to large DH parameter

  During key agreement in a TLS handshake using a DH(E) based ciphersuite a
  malicious server can send a very large prime value to the client. This will
  cause the client to spend an unreasonably long period of time generating a
  key for this prime resulting in a hang until the client has finished. This
  could be exploited in a Denial Of Service attack.

  This issue was reported to OpenSSL on 5th June 2018 by Guido Vranken
  ([CVE-2018-0732])

  _Guido Vranken_

- Cache timing vulnerability in RSA Key Generation

  The OpenSSL RSA Key generation algorithm has been shown to be vulnerable to
  a cache timing side channel attack. An attacker with sufficient access to
  mount cache timing attacks during the RSA key generation process could
  recover the private key.

  This issue was reported to OpenSSL on 4th April 2018 by Alejandro Cabrera
  Aldaya, Billy Brumley, Cesar Pereida Garcia and Luis Manuel Alvarez Tapia.
  ([CVE-2018-0737])

  _Billy Brumley_

- Make EVP_PKEY_asn1_new() a bit stricter about its input. A NULL pem_str
  parameter is no longer accepted, as it leads to a corrupt table. NULL
  pem_str is reserved for alias entries only.

  _Richard Levitte_

- Revert blinding in ECDSA sign and instead make problematic addition
  length-invariant. Switch even to fixed-length Montgomery multiplication.

  _Andy Polyakov_

- Change generating and checking of primes so that the error rate of not
  being prime depends on the intended use based on the size of the input.
  For larger primes this will result in more rounds of Miller-Rabin.
  The maximal error rate for primes with more than 1080 bits is lowered
  to 2^-128.

  _Kurt Roeckx, Annie Yousar_

- Increase the number of Miller-Rabin rounds for DSA key generating to 64.

  _Kurt Roeckx_

- Add blinding to ECDSA and DSA signatures to protect against side channel
  attacks discovered by Keegan Ryan (NCC Group).

  _Matt Caswell_

- When unlocking a pass phrase protected PEM file or PKCS#8 container, we
  now allow empty (zero character) pass phrases.

  _Richard Levitte_

- Certificate time validation (X509_cmp_time) enforces stricter
  compliance with RFC 5280. Fractional seconds and timezone offsets
  are no longer allowed.

  _Emilia Käsper_

- Fixed a text canonicalisation bug in CMS

  Where a CMS detached signature is used with text content the text goes
  through a canonicalisation process first prior to signing or verifying a
  signature. This process strips trailing space at the end of lines, converts
  line terminators to CRLF and removes additional trailing line terminators
  at the end of a file. A bug in the canonicalisation process meant that
  some characters, such as form-feed, were incorrectly treated as whitespace
  and removed. This is contrary to the specification (RFC5485). This fix
  could mean that detached text data signed with an earlier version of
  OpenSSL 1.1.0 may fail to verify using the fixed version, or text data
  signed with a fixed OpenSSL may fail to verify with an earlier version of
  OpenSSL 1.1.0. A workaround is to only verify the canonicalised text data
  and use the "-binary" flag (for the "cms" command line application) or set
  the SMIME_BINARY/PKCS7_BINARY/CMS_BINARY flags (if using CMS_verify()).

  _Matt Caswell_

### Changes between 1.1.0g and 1.1.0h [27 Mar 2018]

- Constructed ASN.1 types with a recursive definition could exceed the stack

  Constructed ASN.1 types with a recursive definition (such as can be found
  in PKCS7) could eventually exceed the stack given malicious input with
  excessive recursion. This could result in a Denial Of Service attack. There
  are no such structures used within SSL/TLS that come from untrusted sources
  so this is considered safe.

  This issue was reported to OpenSSL on 4th January 2018 by the OSS-fuzz
  project.
  ([CVE-2018-0739])

  _Matt Caswell_

- Incorrect CRYPTO_memcmp on HP-UX PA-RISC

  Because of an implementation bug the PA-RISC CRYPTO_memcmp function is
  effectively reduced to only comparing the least significant bit of each
  byte. This allows an attacker to forge messages that would be considered as
  authenticated in an amount of tries lower than that guaranteed by the
  security claims of the scheme. The module can only be compiled by the
  HP-UX assembler, so that only HP-UX PA-RISC targets are affected.

  This issue was reported to OpenSSL on 2nd March 2018 by Peter Waltenberg
  (IBM).
  ([CVE-2018-0733])

  _Andy Polyakov_

- Add a build target 'build_all_generated', to build all generated files
  and only that. This can be used to prepare everything that requires
  things like perl for a system that lacks perl and then move everything
  to that system and do the rest of the build there.

  _Richard Levitte_

- Backport SSL_OP_NO_RENGOTIATION

  OpenSSL 1.0.2 and below had the ability to disable renegotiation using the
  (undocumented) SSL3_FLAGS_NO_RENEGOTIATE_CIPHERS flag. Due to the opacity
  changes this is no longer possible in 1.1.0. Therefore, the new
  SSL_OP_NO_RENEGOTIATION option from 1.1.1-dev has been backported to
  1.1.0 to provide equivalent functionality.

  Note that if an application built against 1.1.0h headers (or above) is run
  using an older version of 1.1.0 (prior to 1.1.0h) then the option will be
  accepted but nothing will happen, i.e. renegotiation will not be prevented.

  _Matt Caswell_

- Removed the OS390-Unix config target. It relied on a script that doesn't
  exist.

  _Rich Salz_

- rsaz_1024_mul_avx2 overflow bug on x86_64

  There is an overflow bug in the AVX2 Montgomery multiplication procedure
  used in exponentiation with 1024-bit moduli. No EC algorithms are affected.
  Analysis suggests that attacks against RSA and DSA as a result of this
  defect would be very difficult to perform and are not believed likely.
  Attacks against DH1024 are considered just feasible, because most of the
  work necessary to deduce information about a private key may be performed
  offline. The amount of resources required for such an attack would be
  significant. However, for an attack on TLS to be meaningful, the server
  would have to share the DH1024 private key among multiple clients, which is
  no longer an option since CVE-2016-0701.

  This only affects processors that support the AVX2 but not ADX extensions
  like Intel Haswell (4th generation).

  This issue was reported to OpenSSL by David Benjamin (Google). The issue
  was originally found via the OSS-Fuzz project.
  ([CVE-2017-3738])

  _Andy Polyakov_

### Changes between 1.1.0f and 1.1.0g [2 Nov 2017]

- bn_sqrx8x_internal carry bug on x86_64

  There is a carry propagating bug in the x86_64 Montgomery squaring
  procedure. No EC algorithms are affected. Analysis suggests that attacks
  against RSA and DSA as a result of this defect would be very difficult to
  perform and are not believed likely. Attacks against DH are considered just
  feasible (although very difficult) because most of the work necessary to
  deduce information about a private key may be performed offline. The amount
  of resources required for such an attack would be very significant and
  likely only accessible to a limited number of attackers. An attacker would
  additionally need online access to an unpatched system using the target
  private key in a scenario with persistent DH parameters and a private
  key that is shared between multiple clients.

  This only affects processors that support the BMI1, BMI2 and ADX extensions
  like Intel Broadwell (5th generation) and later or AMD Ryzen.

  This issue was reported to OpenSSL by the OSS-Fuzz project.
  ([CVE-2017-3736])

  _Andy Polyakov_

- Malformed X.509 IPAddressFamily could cause OOB read

  If an X.509 certificate has a malformed IPAddressFamily extension,
  OpenSSL could do a one-byte buffer overread. The most likely result
  would be an erroneous display of the certificate in text format.

  This issue was reported to OpenSSL by the OSS-Fuzz project.
  ([CVE-2017-3735])

  _Rich Salz_

### Changes between 1.1.0e and 1.1.0f [25 May 2017]

- Have 'config' recognise 64-bit mingw and choose 'mingw64' as the target
  platform rather than 'mingw'.

  _Richard Levitte_

- Remove the VMS-specific reimplementation of gmtime from crypto/o_times.c.
  VMS C's RTL has a fully up to date gmtime() and gmtime_r() since V7.1,
  which is the minimum version we support.

  _Richard Levitte_

### Changes between 1.1.0d and 1.1.0e [16 Feb 2017]

- Encrypt-Then-Mac renegotiation crash

  During a renegotiation handshake if the Encrypt-Then-Mac extension is
  negotiated where it was not in the original handshake (or vice-versa) then
  this can cause OpenSSL to crash (dependent on ciphersuite). Both clients
  and servers are affected.

  This issue was reported to OpenSSL by Joe Orton (Red Hat).
  ([CVE-2017-3733])

  _Matt Caswell_

### Changes between 1.1.0c and 1.1.0d [26 Jan 2017]

- Truncated packet could crash via OOB read

  If one side of an SSL/TLS path is running on a 32-bit host and a specific
  cipher is being used, then a truncated packet can cause that host to
  perform an out-of-bounds read, usually resulting in a crash.

  This issue was reported to OpenSSL by Robert Święcki of Google.
  ([CVE-2017-3731])

  _Andy Polyakov_

- Bad (EC)DHE parameters cause a client crash

  If a malicious server supplies bad parameters for a DHE or ECDHE key
  exchange then this can result in the client attempting to dereference a
  NULL pointer leading to a client crash. This could be exploited in a Denial
  of Service attack.

  This issue was reported to OpenSSL by Guido Vranken.
  ([CVE-2017-3730])

  _Matt Caswell_

- BN_mod_exp may produce incorrect results on x86_64

  There is a carry propagating bug in the x86_64 Montgomery squaring
  procedure. No EC algorithms are affected. Analysis suggests that attacks
  against RSA and DSA as a result of this defect would be very difficult to
  perform and are not believed likely. Attacks against DH are considered just
  feasible (although very difficult) because most of the work necessary to
  deduce information about a private key may be performed offline. The amount
  of resources required for such an attack would be very significant and
  likely only accessible to a limited number of attackers. An attacker would
  additionally need online access to an unpatched system using the target
  private key in a scenario with persistent DH parameters and a private
  key that is shared between multiple clients. For example this can occur by
  default in OpenSSL DHE based SSL/TLS ciphersuites. Note: This issue is very
  similar to CVE-2015-3193 but must be treated as a separate problem.

  This issue was reported to OpenSSL by the OSS-Fuzz project.
  ([CVE-2017-3732])

  _Andy Polyakov_

### Changes between 1.1.0b and 1.1.0c [10 Nov 2016]

- ChaCha20/Poly1305 heap-buffer-overflow

  TLS connections using `*-CHACHA20-POLY1305` ciphersuites are susceptible to
  a DoS attack by corrupting larger payloads. This can result in an OpenSSL
  crash. This issue is not considered to be exploitable beyond a DoS.

  This issue was reported to OpenSSL by Robert Święcki (Google Security Team)
  ([CVE-2016-7054])

  _Richard Levitte_

- CMS Null dereference

  Applications parsing invalid CMS structures can crash with a NULL pointer
  dereference. This is caused by a bug in the handling of the ASN.1 CHOICE
  type in OpenSSL 1.1.0 which can result in a NULL value being passed to the
  structure callback if an attempt is made to free certain invalid encodings.
  Only CHOICE structures using a callback which do not handle NULL value are
  affected.

  This issue was reported to OpenSSL by Tyler Nighswander of ForAllSecure.
  ([CVE-2016-7053])

  _Stephen Henson_

- Montgomery multiplication may produce incorrect results

  There is a carry propagating bug in the Broadwell-specific Montgomery
  multiplication procedure that handles input lengths divisible by, but
  longer than 256 bits. Analysis suggests that attacks against RSA, DSA
  and DH private keys are impossible. This is because the subroutine in
  question is not used in operations with the private key itself and an input
  of the attacker's direct choice. Otherwise the bug can manifest itself as
  transient authentication and key negotiation failures or reproducible
  erroneous outcome of public-key operations with specially crafted input.
  Among EC algorithms only Brainpool P-512 curves are affected and one
  presumably can attack ECDH key negotiation. Impact was not analyzed in
  detail, because pre-requisites for attack are considered unlikely. Namely
  multiple clients have to choose the curve in question and the server has to
  share the private key among them, neither of which is default behaviour.
  Even then only clients that chose the curve will be affected.

  This issue was publicly reported as transient failures and was not
  initially recognized as a security issue. Thanks to Richard Morgan for
  providing reproducible case.
  ([CVE-2016-7055])

  _Andy Polyakov_

- Removed automatic addition of RPATH in shared libraries and executables,
  as this was a remainder from OpenSSL 1.0.x and isn't needed any more.

  _Richard Levitte_

### Changes between 1.1.0a and 1.1.0b [26 Sep 2016]

- Fix Use After Free for large message sizes

  The patch applied to address CVE-2016-6307 resulted in an issue where if a
  message larger than approx 16k is received then the underlying buffer to
  store the incoming message is reallocated and moved. Unfortunately a
  dangling pointer to the old location is left which results in an attempt to
  write to the previously freed location. This is likely to result in a
  crash, however it could potentially lead to execution of arbitrary code.

  This issue only affects OpenSSL 1.1.0a.

  This issue was reported to OpenSSL by Robert Święcki.
  ([CVE-2016-6309])

  _Matt Caswell_

### Changes between 1.1.0 and 1.1.0a [22 Sep 2016]

- OCSP Status Request extension unbounded memory growth

  A malicious client can send an excessively large OCSP Status Request
  extension. If that client continually requests renegotiation, sending a
  large OCSP Status Request extension each time, then there will be unbounded
  memory growth on the server. This will eventually lead to a Denial Of
  Service attack through memory exhaustion. Servers with a default
  configuration are vulnerable even if they do not support OCSP. Builds using
  the "no-ocsp" build time option are not affected.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6304])

  _Matt Caswell_

- SSL_peek() hang on empty record

  OpenSSL 1.1.0 SSL/TLS will hang during a call to SSL_peek() if the peer
  sends an empty record. This could be exploited by a malicious peer in a
  Denial Of Service attack.

  This issue was reported to OpenSSL by Alex Gaynor.
  ([CVE-2016-6305])

  _Matt Caswell_

- Excessive allocation of memory in tls_get_message_header() and
  dtls1_preprocess_fragment()

  A (D)TLS message includes 3 bytes for its length in the header for the
  message. This would allow for messages up to 16Mb in length. Messages of
  this length are excessive and OpenSSL includes a check to ensure that a
  peer is sending reasonably sized messages in order to avoid too much memory
  being consumed to service a connection. A flaw in the logic of version
  1.1.0 means that memory for the message is allocated too early, prior to
  the excessive message length check. Due to way memory is allocated in
  OpenSSL this could mean an attacker could force up to 21Mb to be allocated
  to service a connection. This could lead to a Denial of Service through
  memory exhaustion. However, the excessive message length check still takes
  place, and this would cause the connection to immediately fail. Assuming
  that the application calls SSL_free() on the failed connection in a timely
  manner then the 21Mb of allocated memory will then be immediately freed
  again. Therefore, the excessive memory allocation will be transitory in
  nature. This then means that there is only a security impact if:
  1.  The application does not call SSL_free() in a timely manner in the event
      that the connection fails
      or
  2.  The application is working in a constrained environment where there is
      very little free memory
      or
  3.  The attacker initiates multiple connection attempts such that there are
      multiple connections in a state where memory has been allocated for the
      connection; SSL_free() has not yet been called; and there is insufficient
      memory to service the multiple requests.

  Except in the instance of (1) above any Denial Of Service is likely to be
  transitory because as soon as the connection fails the memory is
  subsequently freed again in the SSL_free() call. However there is an
  increased risk during this period of application crashes due to the lack of
  memory - which would then mean a more serious Denial of Service.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  (CVE-2016-6307 and CVE-2016-6308)

  _Matt Caswell_

- solaris-x86-cc, i.e. 32-bit configuration with vendor compiler,
  had to be removed. Primary reason is that vendor assembler can't
  assemble our modules with -KPIC flag. As result it, assembly
  support, was not even available as option. But its lack means
  lack of side-channel resistant code, which is incompatible with
  security by todays standards. Fortunately gcc is readily available
  prepackaged option, which we firmly point at...

  _Andy Polyakov_

### Changes between 1.0.2h and 1.1.0 [25 Aug 2016]

- Windows command-line tool supports UTF-8 opt-in option for arguments
  and console input. Setting OPENSSL_WIN32_UTF8 environment variable
  (to any value) allows Windows user to access PKCS#12 file generated
  with Windows CryptoAPI and protected with non-ASCII password, as well
  as files generated under UTF-8 locale on Linux also protected with
  non-ASCII password.

  _Andy Polyakov_

- To mitigate the SWEET32 attack ([CVE-2016-2183]), 3DES cipher suites
  have been disabled by default and removed from DEFAULT, just like RC4.
  See the RC4 item below to re-enable both.

  _Rich Salz_

- The method for finding the storage location for the Windows RAND seed file
  has changed. First we check %RANDFILE%. If that is not set then we check
  the directories %HOME%, %USERPROFILE% and %SYSTEMROOT% in that order. If
  all else fails we fall back to C:\.

  _Matt Caswell_

- The EVP_EncryptUpdate() function has had its return type changed from void
  to int. A return of 0 indicates and error while a return of 1 indicates
  success.

  _Matt Caswell_

- The flags RSA_FLAG_NO_CONSTTIME, DSA_FLAG_NO_EXP_CONSTTIME and
  DH_FLAG_NO_EXP_CONSTTIME which previously provided the ability to switch
  off the constant time implementation for RSA, DSA and DH have been made
  no-ops and deprecated.

  _Matt Caswell_

- Windows RAND implementation was simplified to only get entropy by
  calling CryptGenRandom(). Various other RAND-related tickets
  were also closed.

  _Joseph Wylie Yandle, Rich Salz_

- The stack and lhash API's were renamed to start with `OPENSSL_SK_`
  and `OPENSSL_LH_`, respectively. The old names are available
  with API compatibility. They new names are now completely documented.

  _Rich Salz_

- Unify TYPE_up_ref(obj) methods signature.
  SSL_CTX_up_ref(), SSL_up_ref(), X509_up_ref(), EVP_PKEY_up_ref(),
  X509_CRL_up_ref(), X509_OBJECT_up_ref_count() methods are now returning an
  int (instead of void) like all others TYPE_up_ref() methods.
  So now these methods also check the return value of CRYPTO_atomic_add(),
  and the validity of object reference counter.

  *fdasilvayy@gmail.com*

- With Windows Visual Studio builds, the .pdb files are installed
  alongside the installed libraries and executables. For a static
  library installation, ossl_static.pdb is the associate compiler
  generated .pdb file to be used when linking programs.

  _Richard Levitte_

- Remove openssl.spec. Packaging files belong with the packagers.

  _Richard Levitte_

- Automatic Darwin/OSX configuration has had a refresh, it will now
  recognise x86_64 architectures automatically. You can still decide
  to build for a different bitness with the environment variable
  KERNEL_BITS (can be 32 or 64), for example:

          KERNEL_BITS=32 ./config

  _Richard Levitte_

- Change default algorithms in pkcs8 utility to use PKCS#5 v2.0,
  256 bit AES and HMAC with SHA256.

  _Steve Henson_

- Remove support for MIPS o32 ABI on IRIX (and IRIX only).

  _Andy Polyakov_

- Triple-DES ciphers have been moved from HIGH to MEDIUM.

  _Rich Salz_

- To enable users to have their own config files and build file templates,
  Configure looks in the directory indicated by the environment variable
  OPENSSL_LOCAL_CONFIG_DIR as well as the in-source Configurations/
  directory. On VMS, OPENSSL_LOCAL_CONFIG_DIR is expected to be a logical
  name and is used as is.

  _Richard Levitte_

- The following datatypes were made opaque: X509_OBJECT, X509_STORE_CTX,
  X509_STORE, X509_LOOKUP, and X509_LOOKUP_METHOD. The unused type
  X509_CERT_FILE_CTX was removed.

  _Rich Salz_

- "shared" builds are now the default. To create only static libraries use
  the "no-shared" Configure option.

  _Matt Caswell_

- Remove the no-aes, no-hmac, no-rsa, no-sha and no-md5 Configure options.
  All of these option have not worked for some while and are fundamental
  algorithms.

  _Matt Caswell_

- Make various cleanup routines no-ops and mark them as deprecated. Most
  global cleanup functions are no longer required because they are handled
  via auto-deinit (see OPENSSL_init_crypto and OPENSSL_init_ssl man pages).
  Explicitly de-initing can cause problems (e.g. where a library that uses
  OpenSSL de-inits, but an application is still using it). The affected
  functions are CONF_modules_free(), ENGINE_cleanup(), OBJ_cleanup(),
  EVP_cleanup(), BIO_sock_cleanup(), CRYPTO_cleanup_all_ex_data(),
  RAND_cleanup(), SSL_COMP_free_compression_methods(), ERR_free_strings() and
  COMP_zlib_cleanup().

  _Matt Caswell_

- --strict-warnings no longer enables runtime debugging options
  such as REF_DEBUG. Instead, debug options are automatically
  enabled with '--debug' builds.

  _Andy Polyakov, Emilia Käsper_

- Made DH and DH_METHOD opaque. The structures for managing DH objects
  have been moved out of the public header files. New functions for managing
  these have been added.

  _Matt Caswell_

- Made RSA and RSA_METHOD opaque. The structures for managing RSA
  objects have been moved out of the public header files. New
  functions for managing these have been added.

  _Richard Levitte_

- Made DSA and DSA_METHOD opaque. The structures for managing DSA objects
  have been moved out of the public header files. New functions for managing
  these have been added.

  _Matt Caswell_

- Made BIO and BIO_METHOD opaque. The structures for managing BIOs have been
  moved out of the public header files. New functions for managing these
  have been added.

  _Matt Caswell_

- Removed no-rijndael as a config option. Rijndael is an old name for AES.

  _Matt Caswell_

- Removed the mk1mf build scripts.

  _Richard Levitte_

- Headers are now wrapped, if necessary, with OPENSSL_NO_xxx, so
  it is always safe to #include a header now.

  _Rich Salz_

- Removed the aged BC-32 config and all its supporting scripts

  _Richard Levitte_

- Removed support for Ultrix, Netware, and OS/2.

  _Rich Salz_

- Add support for HKDF.

  _Alessandro Ghedini_

- Add support for blake2b and blake2s

  _Bill Cox_

- Added support for "pipelining". Ciphers that have the
  EVP_CIPH_FLAG_PIPELINE flag set have a capability to process multiple
  encryptions/decryptions simultaneously. There are currently no built-in
  ciphers with this property but the expectation is that engines will be able
  to offer it to significantly improve throughput. Support has been extended
  into libssl so that multiple records for a single connection can be
  processed in one go (for >=TLS 1.1).

  _Matt Caswell_

- Added the AFALG engine. This is an async capable engine which is able to
  offload work to the Linux kernel. In this initial version it only supports
  AES128-CBC. The kernel must be version 4.1.0 or greater.

  _Catriona Lucey_

- OpenSSL now uses a new threading API. It is no longer necessary to
  set locking callbacks to use OpenSSL in a multi-threaded environment. There
  are two supported threading models: pthreads and windows threads. It is
  also possible to configure OpenSSL at compile time for "no-threads". The
  old threading API should no longer be used. The functions have been
  replaced with "no-op" compatibility macros.

  _Alessandro Ghedini, Matt Caswell_

- Modify behavior of ALPN to invoke callback after SNI/servername
  callback, such that updates to the SSL_CTX affect ALPN.

  _Todd Short_

- Add SSL_CIPHER queries for authentication and key-exchange.

  _Todd Short_

- Changes to the DEFAULT cipherlist:
  - Prefer (EC)DHE handshakes over plain RSA.
  - Prefer AEAD ciphers over legacy ciphers.
  - Prefer ECDSA over RSA when both certificates are available.
  - Prefer TLSv1.2 ciphers/PRF.
  - Remove DSS, SEED, IDEA, CAMELLIA, and AES-CCM from the
    default cipherlist.

  _Emilia Käsper_

- Change the ECC default curve list to be this, in order: x25519,
  secp256r1, secp521r1, secp384r1.

  _Rich Salz_

- RC4 based libssl ciphersuites are now classed as "weak" ciphers and are
  disabled by default. They can be re-enabled using the
  enable-weak-ssl-ciphers option to Configure.

  _Matt Caswell_

- If the server has ALPN configured, but supports no protocols that the
  client advertises, send a fatal "no_application_protocol" alert.
  This behaviour is SHALL in RFC 7301, though it isn't universally
  implemented by other servers.

  _Emilia Käsper_

- Add X25519 support.
  Add ASN.1 and EVP_PKEY methods for X25519. This includes support
  for public and private key encoding using the format documented in
  draft-ietf-curdle-pkix-02. The corresponding EVP_PKEY method supports
  key generation and key derivation.

  TLS support complies with draft-ietf-tls-rfc4492bis-08 and uses
  X25519(29).

  _Steve Henson_

- Deprecate SRP_VBASE_get_by_user.
  SRP_VBASE_get_by_user had inconsistent memory management behaviour.
  In order to fix an unavoidable memory leak ([CVE-2016-0798]),
  SRP_VBASE_get_by_user was changed to ignore the "fake user" SRP
  seed, even if the seed is configured.

  Users should use SRP_VBASE_get1_by_user instead. Note that in
  SRP_VBASE_get1_by_user, caller must free the returned value. Note
  also that even though configuring the SRP seed attempts to hide
  invalid usernames by continuing the handshake with fake
  credentials, this behaviour is not constant time and no strong
  guarantees are made that the handshake is indistinguishable from
  that of a valid user.

  _Emilia Käsper_

- Configuration change; it's now possible to build dynamic engines
  without having to build shared libraries and vice versa. This
  only applies to the engines in `engines/`, those in `crypto/engine/`
  will always be built into libcrypto (i.e. "static").

  Building dynamic engines is enabled by default; to disable, use
  the configuration option "disable-dynamic-engine".

  The only requirements for building dynamic engines are the
  presence of the DSO module and building with position independent
  code, so they will also automatically be disabled if configuring
  with "disable-dso" or "disable-pic".

  The macros OPENSSL_NO_STATIC_ENGINE and OPENSSL_NO_DYNAMIC_ENGINE
  are also taken away from openssl/opensslconf.h, as they are
  irrelevant.

  _Richard Levitte_

- Configuration change; if there is a known flag to compile
  position independent code, it will always be applied on the
  libcrypto and libssl object files, and never on the application
  object files. This means other libraries that use routines from
  libcrypto / libssl can be made into shared libraries regardless
  of how OpenSSL was configured.

  If this isn't desirable, the configuration options "disable-pic"
  or "no-pic" can be used to disable the use of PIC. This will
  also disable building shared libraries and dynamic engines.

  _Richard Levitte_

- Removed JPAKE code. It was experimental and has no wide use.

  _Rich Salz_

- The INSTALL_PREFIX Makefile variable has been renamed to
  DESTDIR. That makes for less confusion on what this variable
  is for. Also, the configuration option --install_prefix is
  removed.

  _Richard Levitte_

- Heartbeat for TLS has been removed and is disabled by default
  for DTLS; configure with enable-heartbeats. Code that uses the
  old #define's might need to be updated.

  _Emilia Käsper, Rich Salz_

- Rename REF_CHECK to REF_DEBUG.

  _Rich Salz_

- New "unified" build system

  The "unified" build system is aimed to be a common system for all
  platforms we support. With it comes new support for VMS.

  This system builds supports building in a different directory tree
  than the source tree. It produces one Makefile (for unix family
  or lookalikes), or one descrip.mms (for VMS).

  The source of information to make the Makefile / descrip.mms is
  small files called 'build.info', holding the necessary
  information for each directory with source to compile, and a
  template in Configurations, like unix-Makefile.tmpl or
  descrip.mms.tmpl.

  With this change, the library names were also renamed on Windows
  and on VMS. They now have names that are closer to the standard
  on Unix, and include the major version number, and in certain
  cases, the architecture they are built for. See "Notes on shared
  libraries" in INSTALL.

  We rely heavily on the perl module Text::Template.

  _Richard Levitte_

- Added support for auto-initialisation and de-initialisation of the library.
  OpenSSL no longer requires explicit init or deinit routines to be called,
  except in certain circumstances. See the OPENSSL_init_crypto() and
  OPENSSL_init_ssl() man pages for further information.

  _Matt Caswell_

- The arguments to the DTLSv1_listen function have changed. Specifically the
  "peer" argument is now expected to be a BIO_ADDR object.

- Rewrite of BIO networking library. The BIO library lacked consistent
  support of IPv6, and adding it required some more extensive
  modifications. This introduces the BIO_ADDR and BIO_ADDRINFO types,
  which hold all types of addresses and chains of address information.
  It also introduces a new API, with functions like BIO_socket,
  BIO_connect, BIO_listen, BIO_lookup and a rewrite of BIO_accept.
  The source/sink BIOs BIO_s_connect, BIO_s_accept and BIO_s_datagram
  have been adapted accordingly.

  _Richard Levitte_

- RSA_padding_check_PKCS1_type_1 now accepts inputs with and without
  the leading 0-byte.

  _Emilia Käsper_

- CRIME protection: disable compression by default, even if OpenSSL is
  compiled with zlib enabled. Applications can still enable compression
  by calling SSL_CTX_clear_options(ctx, SSL_OP_NO_COMPRESSION), or by
  using the SSL_CONF library to configure compression.

  _Emilia Käsper_

- The signature of the session callback configured with
  SSL_CTX_sess_set_get_cb was changed. The read-only input buffer
  was explicitly marked as `const unsigned char*` instead of
  `unsigned char*`.

  _Emilia Käsper_

- Always DPURIFY. Remove the use of uninitialized memory in the
  RNG, and other conditional uses of DPURIFY. This makes -DPURIFY a no-op.

  _Emilia Käsper_

- Removed many obsolete configuration items, including
  DES_PTR, DES_RISC1, DES_RISC2, DES_INT
  MD2_CHAR, MD2_INT, MD2_LONG
  BF_PTR, BF_PTR2
  IDEA_SHORT, IDEA_LONG
  RC2_SHORT, RC2_LONG, RC4_LONG, RC4_CHUNK, RC4_INDEX

  _Rich Salz, with advice from Andy Polyakov_

- Many BN internals have been moved to an internal header file.

  _Rich Salz with help from Andy Polyakov_

- Configuration and writing out the results from it has changed.
  Files such as Makefile include/openssl/opensslconf.h and are now
  produced through general templates, such as Makefile.in and
  crypto/opensslconf.h.in and some help from the perl module
  Text::Template.

  Also, the center of configuration information is no longer
  Makefile. Instead, Configure produces a perl module in
  configdata.pm which holds most of the config data (in the hash
  table %config), the target data that comes from the target
  configuration in one of the `Configurations/*.conf` files (in
  %target).

  _Richard Levitte_

- To clarify their intended purposes, the Configure options
  --prefix and --openssldir change their semantics, and become more
  straightforward and less interdependent.

  --prefix shall be used exclusively to give the location INSTALLTOP
  where programs, scripts, libraries, include files and manuals are
  going to be installed. The default is now /usr/local.

  --openssldir shall be used exclusively to give the default
  location OPENSSLDIR where certificates, private keys, CRLs are
  managed. This is also where the default openssl.cnf gets
  installed.
  If the directory given with this option is a relative path, the
  values of both the --prefix value and the --openssldir value will
  be combined to become OPENSSLDIR.
  The default for --openssldir is INSTALLTOP/ssl.

  Anyone who uses --openssldir to specify where OpenSSL is to be
  installed MUST change to use --prefix instead.

  _Richard Levitte_

- The GOST engine was out of date and therefore it has been removed. An up
  to date GOST engine is now being maintained in an external repository.
  See: <https://github.com/openssl/openssl/wiki/Binaries>. Libssl still retains
  support for GOST ciphersuites (these are only activated if a GOST engine
  is present).

  _Matt Caswell_

- EGD is no longer supported by default; use enable-egd when
  configuring.

  _Ben Kaduk and Rich Salz_

- The distribution now has Makefile.in files, which are used to
  create Makefile's when Configure is run. _Configure must be run
  before trying to build now._

  _Rich Salz_

- The return value for SSL_CIPHER_description() for error conditions
  has changed.

  _Rich Salz_

- Support for RFC6698/RFC7671 DANE TLSA peer authentication.

  Obtaining and performing DNSSEC validation of TLSA records is
  the application's responsibility. The application provides
  the TLSA records of its choice to OpenSSL, and these are then
  used to authenticate the peer.

  The TLSA records need not even come from DNS. They can, for
  example, be used to implement local end-entity certificate or
  trust-anchor "pinning", where the "pin" data takes the form
  of TLSA records, which can augment or replace verification
  based on the usual WebPKI public certification authorities.

  _Viktor Dukhovni_

- Revert default OPENSSL_NO_DEPRECATED setting. Instead OpenSSL
  continues to support deprecated interfaces in default builds.
  However, applications are strongly advised to compile their
  source files with -DOPENSSL_API_COMPAT=0x10100000L, which hides
  the declarations of all interfaces deprecated in 0.9.8, 1.0.0
  or the 1.1.0 releases.

  In environments in which all applications have been ported to
  not use any deprecated interfaces OpenSSL's Configure script
  should be used with the --api=1.1.0 option to entirely remove
  support for the deprecated features from the library and
  unconditionally disable them in the installed headers.
  Essentially the same effect can be achieved with the "no-deprecated"
  argument to Configure, except that this will always restrict
  the build to just the latest API, rather than a fixed API
  version.

  As applications are ported to future revisions of the API,
  they should update their compile-time OPENSSL_API_COMPAT define
  accordingly, but in most cases should be able to continue to
  compile with later releases.

  The OPENSSL_API_COMPAT versions for 1.0.0, and 0.9.8 are
  0x10000000L and 0x00908000L, respectively. However those
  versions did not support the OPENSSL_API_COMPAT feature, and
  so applications are not typically tested for explicit support
  of just the undeprecated features of either release.

  _Viktor Dukhovni_

- Add support for setting the minimum and maximum supported protocol.
  It can bet set via the SSL_set_min_proto_version() and
  SSL_set_max_proto_version(), or via the SSL_CONF's MinProtocol and
  MaxProtocol. It's recommended to use the new APIs to disable
  protocols instead of disabling individual protocols using
  SSL_set_options() or SSL_CONF's Protocol. This change also
  removes support for disabling TLS 1.2 in the OpenSSL TLS
  client at compile time by defining OPENSSL_NO_TLS1_2_CLIENT.

  _Kurt Roeckx_

- Support for ChaCha20 and Poly1305 added to libcrypto and libssl.

  _Andy Polyakov_

- New EC_KEY_METHOD, this replaces the older ECDSA_METHOD and ECDH_METHOD
  and integrates ECDSA and ECDH functionality into EC. Implementations can
  now redirect key generation and no longer need to convert to or from
  ECDSA_SIG format.

  Note: the ecdsa.h and ecdh.h headers are now no longer needed and just
  include the ec.h header file instead.

  _Steve Henson_

- Remove support for all 40 and 56 bit ciphers. This includes all the export
  ciphers who are no longer supported and drops support the ephemeral RSA key
  exchange. The LOW ciphers currently doesn't have any ciphers in it.

  _Kurt Roeckx_

- Made EVP_MD_CTX, EVP_MD, EVP_CIPHER_CTX, EVP_CIPHER and HMAC_CTX
  opaque. For HMAC_CTX, the following constructors and destructors
  were added:

      HMAC_CTX *HMAC_CTX_new(void);
      void HMAC_CTX_free(HMAC_CTX *ctx);

  For EVP_MD and EVP_CIPHER, complete APIs to create, fill and
  destroy such methods has been added. See EVP_MD_meth_new(3) and
  EVP_CIPHER_meth_new(3) for documentation.

  Additional changes:
  1.  `EVP_MD_CTX_cleanup()`, `EVP_CIPHER_CTX_cleanup()` and
      `HMAC_CTX_cleanup()` were removed. `HMAC_CTX_reset()` and
      `EVP_MD_CTX_reset()` should be called instead to reinitialise
      an already created structure.
  2.  For consistency with the majority of our object creators and
      destructors, `EVP_MD_CTX_(create|destroy)` were renamed to
      `EVP_MD_CTX_(new|free)`. The old names are retained as macros
      for deprecated builds.

  _Richard Levitte_

- Added ASYNC support. Libcrypto now includes the async sub-library to enable
  cryptographic operations to be performed asynchronously as long as an
  asynchronous capable engine is used. See the ASYNC_start_job() man page for
  further details. Libssl has also had this capability integrated with the
  introduction of the new mode SSL_MODE_ASYNC and associated error
  SSL_ERROR_WANT_ASYNC. See the SSL_CTX_set_mode() and SSL_get_error() man
  pages. This work was developed in partnership with Intel Corp.

  _Matt Caswell_

- SSL*{CTX*}set_ecdh_auto() has been removed and ECDH is support is
  always enabled now. If you want to disable the support you should
  exclude it using the list of supported ciphers. This also means that the
  "-no_ecdhe" option has been removed from s_server.

  _Kurt Roeckx_

- SSL*{CTX}\_set_tmp_ecdh() which can set 1 EC curve now internally calls
  SSL*{CTX\_}set1_curves() which can set a list.

  _Kurt Roeckx_

- Remove support for SSL*{CTX*}set*tmp_ecdh_callback(). You should set the
  curve you want to support using SSL*{CTX\_}set1_curves().

  _Kurt Roeckx_

- State machine rewrite. The state machine code has been significantly
  refactored in order to remove much duplication of code and solve issues
  with the old code (see [ssl/statem/README.md](ssl/statem/README.md) for
  further details). This change does have some associated API changes.
  Notably the SSL_state() function has been removed and replaced by
  SSL_get_state which now returns an "OSSL_HANDSHAKE_STATE" instead of an int.
  SSL_set_state() has been removed altogether. The previous handshake states
  defined in ssl.h and ssl3.h have also been removed.

  _Matt Caswell_

- All instances of the string "ssleay" in the public API were replaced
  with OpenSSL (case-matching; e.g., OPENSSL_VERSION for #define's)
  Some error codes related to internal RSA_eay API's were renamed.

  _Rich Salz_

- The demo files in crypto/threads were moved to demo/threads.

  _Rich Salz_

- Removed obsolete engines: 4758cca, aep, atalla, cswift, nuron, gmp,
  sureware and ubsec.

  _Matt Caswell, Rich Salz_

- New ASN.1 embed macro.

  New ASN.1 macro ASN1_EMBED. This is the same as ASN1_SIMPLE except the
  structure is not allocated: it is part of the parent. That is instead of

          FOO *x;

  it must be:

          FOO x;

  This reduces memory fragmentation and make it impossible to accidentally
  set a mandatory field to NULL.

  This currently only works for some fields specifically a SEQUENCE, CHOICE,
  or ASN1_STRING type which is part of a parent SEQUENCE. Since it is
  equivalent to ASN1_SIMPLE it cannot be tagged, OPTIONAL, SET OF or
  SEQUENCE OF.

  _Steve Henson_

- Remove EVP_CHECK_DES_KEY, a compile-time option that never compiled.

  _Emilia Käsper_

- Removed DES and RC4 ciphersuites from DEFAULT. Also removed RC2 although
  in 1.0.2 EXPORT was already removed and the only RC2 ciphersuite is also
  an EXPORT one. COMPLEMENTOFDEFAULT has been updated accordingly to add
  DES and RC4 ciphersuites.

  _Matt Caswell_

- Rewrite EVP_DecodeUpdate (base64 decoding) to fix several bugs.
  This changes the decoding behaviour for some invalid messages,
  though the change is mostly in the more lenient direction, and
  legacy behaviour is preserved as much as possible.

  _Emilia Käsper_

- Fix no-stdio build.
  _David Woodhouse <David.Woodhouse@intel.com> and also_
  _Ivan Nestlerode <ivan.nestlerode@sonos.com>_

- New testing framework
  The testing framework has been largely rewritten and is now using
  perl and the perl modules Test::Harness and an extended variant of
  Test::More called OpenSSL::Test to do its work. All test scripts in
  test/ have been rewritten into test recipes, and all direct calls to
  executables in test/Makefile have become individual recipes using the
  simplified testing OpenSSL::Test::Simple.

  For documentation on our testing modules, do:

          perldoc test/testlib/OpenSSL/Test/Simple.pm
          perldoc test/testlib/OpenSSL/Test.pm

  _Richard Levitte_

- Revamped memory debug; only -DCRYPTO_MDEBUG and -DCRYPTO_MDEBUG_ABORT
  are used; the latter aborts on memory leaks (usually checked on exit).
  Some undocumented "set malloc, etc., hooks" functions were removed
  and others were changed. All are now documented.

  _Rich Salz_

- In DSA_generate_parameters_ex, if the provided seed is too short,
  return an error

  _Rich Salz and Ismo Puustinen <ismo.puustinen@intel.com>_

- Rewrite PSK to support ECDHE_PSK, DHE_PSK and RSA_PSK. Add ciphersuites
  from RFC4279, RFC4785, RFC5487, RFC5489.

  Thanks to Christian J. Dietrich and Giuseppe D'Angelo for the
  original RSA_PSK patch.

  _Steve Henson_

- Dropped support for the SSL3_FLAGS_DELAY_CLIENT_FINISHED flag. This SSLeay
  era flag was never set throughout the codebase (only read). Also removed
  SSL3_FLAGS_POP_BUFFER which was only used if
  SSL3_FLAGS_DELAY_CLIENT_FINISHED was also set.

  _Matt Caswell_

- Changed the default name options in the "ca", "crl", "req" and "x509"
  to be "oneline" instead of "compat".

  _Richard Levitte_

- Remove SSL_OP_TLS_BLOCK_PADDING_BUG. This is SSLeay legacy, we're
  not aware of clients that still exhibit this bug, and the workaround
  hasn't been working properly for a while.

  _Emilia Käsper_

- The return type of BIO_number_read() and BIO_number_written() as well as
  the corresponding num_read and num_write members in the BIO structure has
  changed from unsigned long to uint64_t. On platforms where an unsigned
  long is 32 bits (e.g. Windows) these counters could overflow if >4Gb is
  transferred.

  _Matt Caswell_

- Given the pervasive nature of TLS extensions it is inadvisable to run
  OpenSSL without support for them. It also means that maintaining
  the OPENSSL_NO_TLSEXT option within the code is very invasive (and probably
  not well tested). Therefore, the OPENSSL_NO_TLSEXT option has been removed.

  _Matt Caswell_

- Removed support for the two export grade static DH ciphersuites
  EXP-DH-RSA-DES-CBC-SHA and EXP-DH-DSS-DES-CBC-SHA. These two ciphersuites
  were newly added (along with a number of other static DH ciphersuites) to
  1.0.2. However the two export ones have _never_ worked since they were
  introduced. It seems strange in any case to be adding new export
  ciphersuites, and given "logjam" it also does not seem correct to fix them.

  _Matt Caswell_

- Version negotiation has been rewritten. In particular SSLv23_method(),
  SSLv23_client_method() and SSLv23_server_method() have been deprecated,
  and turned into macros which simply call the new preferred function names
  TLS_method(), TLS_client_method() and TLS_server_method(). All new code
  should use the new names instead. Also as part of this change the ssl23.h
  header file has been removed.

  _Matt Caswell_

- Support for Kerberos ciphersuites in TLS (RFC2712) has been removed. This
  code and the associated standard is no longer considered fit-for-purpose.

  _Matt Caswell_

- RT2547 was closed. When generating a private key, try to make the
  output file readable only by the owner. This behavior change might
  be noticeable when interacting with other software.

- Documented all exdata functions. Added CRYPTO_free_ex_index.
  Added a test.

  _Rich Salz_

- Added HTTP GET support to the ocsp command.

  _Rich Salz_

- Changed default digest for the dgst and enc commands from MD5 to
  sha256

  _Rich Salz_

- RAND_pseudo_bytes has been deprecated. Users should use RAND_bytes instead.

  _Matt Caswell_

- Added support for TLS extended master secret from
  draft-ietf-tls-session-hash-03.txt. Thanks for Alfredo Pironti for an
  initial patch which was a great help during development.

  _Steve Henson_

- All libssl internal structures have been removed from the public header
  files, and the OPENSSL_NO_SSL_INTERN option has been removed (since it is
  now redundant). Users should not attempt to access internal structures
  directly. Instead they should use the provided API functions.

  _Matt Caswell_

- config has been changed so that by default OPENSSL_NO_DEPRECATED is used.
  Access to deprecated functions can be re-enabled by running config with
  "enable-deprecated". In addition applications wishing to use deprecated
  functions must define OPENSSL_USE_DEPRECATED. Note that this new behaviour
  will, by default, disable some transitive includes that previously existed
  in the header files (e.g. ec.h will no longer, by default, include bn.h)

  _Matt Caswell_

- Added support for OCB mode. OpenSSL has been granted a patent license
  compatible with the OpenSSL license for use of OCB. Details are available
  at <https://www.openssl.org/source/OCB-patent-grant-OpenSSL.pdf>. Support
  for OCB can be removed by calling config with no-ocb.

  _Matt Caswell_

- SSLv2 support has been removed. It still supports receiving an SSLv2
  compatible client hello.

  _Kurt Roeckx_

- Increased the minimal RSA keysize from 256 to 512 bits [Rich Salz],
  done while fixing the error code for the key-too-small case.

  _Annie Yousar <a.yousar@informatik.hu-berlin.de>_

- CA.sh has been removed; use CA.pl instead.

  _Rich Salz_

- Removed old DES API.

  _Rich Salz_

- Remove various unsupported platforms:
  Sony NEWS4
  BEOS and BEOS_R5
  NeXT
  SUNOS
  MPE/iX
  Sinix/ReliantUNIX RM400
  DGUX
  NCR
  Tandem
  Cray
  16-bit platforms such as WIN16

  _Rich Salz_

- Clean up OPENSSL_NO_xxx #define's
  - Use setbuf() and remove OPENSSL_NO_SETVBUF_IONBF
  - Rename OPENSSL_SYSNAME_xxx to OPENSSL_SYS_xxx
  - OPENSSL_NO_EC{DH,DSA} merged into OPENSSL_NO_EC
  - OPENSSL_NO_RIPEMD160, OPENSSL_NO_RIPEMD merged into OPENSSL_NO_RMD160
  - OPENSSL_NO_FP_API merged into OPENSSL_NO_STDIO
  - Remove OPENSSL_NO_BIO OPENSSL_NO_BUFFER OPENSSL_NO_CHAIN_VERIFY
    OPENSSL_NO_EVP OPENSSL_NO_FIPS_ERR OPENSSL_NO_HASH_COMP
    OPENSSL_NO_LHASH OPENSSL_NO_OBJECT OPENSSL_NO_SPEED OPENSSL_NO_STACK
    OPENSSL_NO_X509 OPENSSL_NO_X509_VERIFY
  - Remove MS_STATIC; it's a relic from platforms <32 bits.

  _Rich Salz_

- Cleaned up dead code
  Remove all but one '#ifdef undef' which is to be looked at.

  _Rich Salz_

- Clean up calling of xxx_free routines.
  Just like free(), fix most of the xxx_free routines to accept
  NULL. Remove the non-null checks from callers. Save much code.

  _Rich Salz_

- Add secure heap for storage of private keys (when possible).
  Add BIO_s_secmem(), CBIGNUM, etc.
  Contributed by Akamai Technologies under our Corporate CLA.

  _Rich Salz_

- Experimental support for a new, fast, unbiased prime candidate generator,
  bn_probable_prime_dh_coprime(). Not currently used by any prime generator.

  _Felix Laurie von Massenbach <felix@erbridge.co.uk>_

- New output format NSS in the sess_id command line tool. This allows
  exporting the session id and the master key in NSS keylog format.

  _Martin Kaiser <martin@kaiser.cx>_

- Harmonize version and its documentation. -f flag is used to display
  compilation flags.

  _mancha <mancha1@zoho.com>_

- Fix eckey_priv_encode so it immediately returns an error upon a failure
  in i2d_ECPrivateKey. Thanks to Ted Unangst for feedback on this issue.

  _mancha <mancha1@zoho.com>_

- Fix some double frees. These are not thought to be exploitable.

  _mancha <mancha1@zoho.com>_

- A missing bounds check in the handling of the TLS heartbeat extension
  can be used to reveal up to 64k of memory to a connected client or
  server.

  Thanks for Neel Mehta of Google Security for discovering this bug and to
  Adam Langley <agl@chromium.org> and Bodo Moeller <bmoeller@acm.org> for
  preparing the fix ([CVE-2014-0160])

  _Adam Langley, Bodo Moeller_

- Fix for the attack described in the paper "Recovering OpenSSL
  ECDSA Nonces Using the FLUSH+RELOAD Cache Side-channel Attack"
  by Yuval Yarom and Naomi Benger. Details can be obtained from:
  <http://eprint.iacr.org/2014/140>

  Thanks to Yuval Yarom and Naomi Benger for discovering this
  flaw and to Yuval Yarom for supplying a fix ([CVE-2014-0076])

  _Yuval Yarom and Naomi Benger_

- Use algorithm specific chains in SSL_CTX_use_certificate_chain_file():
  this fixes a limitation in previous versions of OpenSSL.

  _Steve Henson_

- Experimental encrypt-then-mac support.

  Experimental support for encrypt then mac from
  draft-gutmann-tls-encrypt-then-mac-02.txt

  To enable it set the appropriate extension number (0x42 for the test
  server) using e.g. -DTLSEXT_TYPE_encrypt_then_mac=0x42

  For non-compliant peers (i.e. just about everything) this should have no
  effect.

  WARNING: EXPERIMENTAL, SUBJECT TO CHANGE.

  _Steve Henson_

- Add EVP support for key wrapping algorithms, to avoid problems with
  existing code the flag EVP_CIPHER_CTX_WRAP_ALLOW has to be set in
  the EVP_CIPHER_CTX or an error is returned. Add AES and DES3 wrap
  algorithms and include tests cases.

  _Steve Henson_

- Extend CMS code to support RSA-PSS signatures and RSA-OAEP for
  enveloped data.

  _Steve Henson_

- Extended RSA OAEP support via EVP_PKEY API. Options to specify digest,
  MGF1 digest and OAEP label.

  _Steve Henson_

- Make openssl verify return errors.

  _Chris Palmer <palmer@google.com> and Ben Laurie_

- New function ASN1_TIME_diff to calculate the difference between two
  ASN1_TIME structures or one structure and the current time.

  _Steve Henson_

- Update fips_test_suite to support multiple command line options. New
  test to induce all self test errors in sequence and check expected
  failures.

  _Steve Henson_

- Add FIPS*{rsa,dsa,ecdsa}*{sign,verify} functions which digest and
  sign or verify all in one operation.

  _Steve Henson_

- Add fips_algvs: a multicall fips utility incorporating all the algorithm
  test programs and fips_test_suite. Includes functionality to parse
  the minimal script output of fipsalgest.pl directly.

  _Steve Henson_

- Add authorisation parameter to FIPS_module_mode_set().

  _Steve Henson_

- Add FIPS selftest for ECDH algorithm using P-224 and B-233 curves.

  _Steve Henson_

- Use separate DRBG fields for internal and external flags. New function
  FIPS_drbg_health_check() to perform on demand health checking. Add
  generation tests to fips_test_suite with reduced health check interval to
  demonstrate periodic health checking. Add "nodh" option to
  fips_test_suite to skip very slow DH test.

  _Steve Henson_

- New function FIPS_get_cipherbynid() to lookup FIPS supported ciphers
  based on NID.

  _Steve Henson_

- More extensive health check for DRBG checking many more failure modes.
  New function FIPS_selftest_drbg_all() to handle every possible DRBG
  combination: call this in fips_test_suite.

  _Steve Henson_

- Add support for canonical generation of DSA parameter 'g'. See
  FIPS 186-3 A.2.3.

- Add support for HMAC DRBG from SP800-90. Update DRBG algorithm test and
  POST to handle HMAC cases.

  _Steve Henson_

- Add functions FIPS_module_version() and FIPS_module_version_text()
  to return numerical and string versions of the FIPS module number.

  _Steve Henson_

- Rename FIPS_mode_set and FIPS_mode to FIPS_module_mode_set and
  FIPS_module_mode. FIPS_mode and FIPS_mode_set will be implemented
  outside the validated module in the FIPS capable OpenSSL.

  _Steve Henson_

- Minor change to DRBG entropy callback semantics. In some cases
  there is no multiple of the block length between min_len and
  max_len. Allow the callback to return more than max_len bytes
  of entropy but discard any extra: it is the callback's responsibility
  to ensure that the extra data discarded does not impact the
  requested amount of entropy.

  _Steve Henson_

- Add PRNG security strength checks to RSA, DSA and ECDSA using
  information in FIPS186-3, SP800-57 and SP800-131A.

  _Steve Henson_

- CCM support via EVP. Interface is very similar to GCM case except we
  must supply all data in one chunk (i.e. no update, final) and the
  message length must be supplied if AAD is used. Add algorithm test
  support.

  _Steve Henson_

- Initial version of POST overhaul. Add POST callback to allow the status
  of POST to be monitored and/or failures induced. Modify fips_test_suite
  to use callback. Always run all selftests even if one fails.

  _Steve Henson_

- XTS support including algorithm test driver in the fips_gcmtest program.
  Note: this does increase the maximum key length from 32 to 64 bytes but
  there should be no binary compatibility issues as existing applications
  will never use XTS mode.

  _Steve Henson_

- Extensive reorganisation of FIPS PRNG behaviour. Remove all dependencies
  to OpenSSL RAND code and replace with a tiny FIPS RAND API which also
  performs algorithm blocking for unapproved PRNG types. Also do not
  set PRNG type in FIPS_mode_set(): leave this to the application.
  Add default OpenSSL DRBG handling: sets up FIPS PRNG and seeds with
  the standard OpenSSL PRNG: set additional data to a date time vector.

  _Steve Henson_

- Rename old X9.31 PRNG functions of the form `FIPS_rand*` to `FIPS_x931*`.
  This shouldn't present any incompatibility problems because applications
  shouldn't be using these directly and any that are will need to rethink
  anyway as the X9.31 PRNG is now deprecated by FIPS 140-2

  _Steve Henson_

- Extensive self tests and health checking required by SP800-90 DRBG.
  Remove strength parameter from FIPS_drbg_instantiate and always
  instantiate at maximum supported strength.

  _Steve Henson_

- Add ECDH code to fips module and fips_ecdhvs for primitives only testing.

  _Steve Henson_

- New algorithm test program fips_dhvs to handle DH primitives only testing.

  _Steve Henson_

- New function DH_compute_key_padded() to compute a DH key and pad with
  leading zeroes if needed: this complies with SP800-56A et al.

  _Steve Henson_

- Initial implementation of SP800-90 DRBGs for Hash and CTR. Not used by
  anything, incomplete, subject to change and largely untested at present.

  _Steve Henson_

- Modify fipscanisteronly build option to only build the necessary object
  files by filtering FIPS_EX_OBJ through a perl script in crypto/Makefile.

  _Steve Henson_

- Add experimental option FIPSSYMS to give all symbols in
  fipscanister.o and FIPS or fips prefix. This will avoid
  conflicts with future versions of OpenSSL. Add perl script
  util/fipsas.pl to preprocess assembly language source files
  and rename any affected symbols.

  _Steve Henson_

- Add selftest checks and algorithm block of non-fips algorithms in
  FIPS mode. Remove DES2 from selftests.

  _Steve Henson_

- Add ECDSA code to fips module. Add tiny fips_ecdsa_check to just
  return internal method without any ENGINE dependencies. Add new
  tiny fips sign and verify functions.

  _Steve Henson_

- New build option no-ec2m to disable characteristic 2 code.

  _Steve Henson_

- New build option "fipscanisteronly". This only builds fipscanister.o
  and (currently) associated fips utilities. Uses the file Makefile.fips
  instead of Makefile.org as the prototype.

  _Steve Henson_

- Add some FIPS mode restrictions to GCM. Add internal IV generator.
  Update fips_gcmtest to use IV generator.

  _Steve Henson_

- Initial, experimental EVP support for AES-GCM. AAD can be input by
  setting output buffer to NULL. The `*Final` function must be
  called although it will not retrieve any additional data. The tag
  can be set or retrieved with a ctrl. The IV length is by default 12
  bytes (96 bits) but can be set to an alternative value. If the IV
  length exceeds the maximum IV length (currently 16 bytes) it cannot be
  set before the key.

  _Steve Henson_

- New flag in ciphers: EVP_CIPH_FLAG_CUSTOM_CIPHER. This means the
  underlying do_cipher function handles all cipher semantics itself
  including padding and finalisation. This is useful if (for example)
  an ENGINE cipher handles block padding itself. The behaviour of
  do_cipher is subtly changed if this flag is set: the return value
  is the number of characters written to the output buffer (zero is
  no longer an error code) or a negative error code. Also if the
  input buffer is NULL and length 0 finalisation should be performed.

  _Steve Henson_

- If a candidate issuer certificate is already part of the constructed
  path ignore it: new debug notification X509_V_ERR_PATH_LOOP for this case.

  _Steve Henson_

- Improve forward-security support: add functions

          void SSL_CTX_set_not_resumable_session_callback(
                   SSL_CTX *ctx, int (*cb)(SSL *ssl, int is_forward_secure))
          void SSL_set_not_resumable_session_callback(
                   SSL *ssl, int (*cb)(SSL *ssl, int is_forward_secure))

  for use by SSL/TLS servers; the callback function will be called whenever a
  new session is created, and gets to decide whether the session may be
  cached to make it resumable (return 0) or not (return 1). (As by the
  SSL/TLS protocol specifications, the session_id sent by the server will be
  empty to indicate that the session is not resumable; also, the server will
  not generate RFC 4507 (RFC 5077) session tickets.)

  A simple reasonable callback implementation is to return is_forward_secure.
  This parameter will be set to 1 or 0 depending on the ciphersuite selected
  by the SSL/TLS server library, indicating whether it can provide forward
  security.

  _Emilia Käsper <emilia.kasper@esat.kuleuven.be> (Google)_

- New -verify_name option in command line utilities to set verification
  parameters by name.

  _Steve Henson_

- Initial CMAC implementation. WARNING: EXPERIMENTAL, API MAY CHANGE.
  Add CMAC pkey methods.

  _Steve Henson_

- Experimental renegotiation in s_server -www mode. If the client
  browses /reneg connection is renegotiated. If /renegcert it is
  renegotiated requesting a certificate.

  _Steve Henson_

- Add an "external" session cache for debugging purposes to s_server. This
  should help trace issues which normally are only apparent in deployed
  multi-process servers.

  _Steve Henson_

- Extensive audit of libcrypto with DEBUG_UNUSED. Fix many cases where
  return value is ignored. NB. The functions RAND_add(), RAND_seed(),
  BIO_set_cipher() and some obscure PEM functions were changed so they
  can now return an error. The RAND changes required a change to the
  RAND_METHOD structure.

  _Steve Henson_

- New macro `__owur` for "OpenSSL Warn Unused Result". This makes use of
  a gcc attribute to warn if the result of a function is ignored. This
  is enable if DEBUG_UNUSED is set. Add to several functions in evp.h
  whose return value is often ignored.

  _Steve Henson_

- New -noct, -requestct, -requirect and -ctlogfile options for s_client.
  These allow SCTs (signed certificate timestamps) to be requested and
  validated when establishing a connection.

  _Rob Percival <robpercival@google.com>_

- SSLv3 is by default disabled at build-time. Builds that are not
  configured with "enable-ssl3" will not support SSLv3.

  _Kurt Roeckx_

## OpenSSL 1.0.2

### Changes between 1.0.2s and 1.0.2t [10 Sep 2019]

- For built-in EC curves, ensure an EC_GROUP built from the curve name is
  used even when parsing explicit parameters, when loading a encoded key
  or calling `EC_GROUP_new_from_ecpkparameters()`/
  `EC_GROUP_new_from_ecparameters()`.
  This prevents bypass of security hardening and performance gains,
  especially for curves with specialized EC_METHODs.
  By default, if a key encoded with explicit parameters is loaded and later
  encoded, the output is still encoded with explicit parameters, even if
  internally a "named" EC_GROUP is used for computation.

  _Nicola Tuveri_

- Compute ECC cofactors if not provided during EC_GROUP construction. Before
  this change, EC_GROUP_set_generator would accept order and/or cofactor as
  NULL. After this change, only the cofactor parameter can be NULL. It also
  does some minimal sanity checks on the passed order.
  ([CVE-2019-1547])

  _Billy Bob Brumley_

- Fixed a padding oracle in PKCS7_dataDecode and CMS_decrypt_set1_pkey.
  An attack is simple, if the first CMS_recipientInfo is valid but the
  second CMS_recipientInfo is chosen ciphertext. If the second
  recipientInfo decodes to PKCS #1 v1.5 form plaintext, the correct
  encryption key will be replaced by garbage, and the message cannot be
  decoded, but if the RSA decryption fails, the correct encryption key is
  used and the recipient will not notice the attack.
  As a work around for this potential attack the length of the decrypted
  key must be equal to the cipher default key length, in case the
  certificate is not given and all recipientInfo are tried out.
  The old behaviour can be re-enabled in the CMS code by setting the
  CMS_DEBUG_DECRYPT flag.
  ([CVE-2019-1563])

  _Bernd Edlinger_

- Document issue with installation paths in diverse Windows builds

  '/usr/local/ssl' is an unsafe prefix for location to install OpenSSL
  binaries and run-time config file.
  ([CVE-2019-1552])

  _Richard Levitte_

### Changes between 1.0.2r and 1.0.2s [28 May 2019]

- Change the default RSA, DSA and DH size to 2048 bit instead of 1024.
  This changes the size when using the `genpkey` command when no size is given.
  It fixes an omission in earlier changes that changed all RSA, DSA and DH
  generation commands to use 2048 bits by default.

  _Kurt Roeckx_

- Add FIPS support for Android Arm 64-bit

  Support for Android Arm 64-bit was added to the OpenSSL FIPS Object
  Module in Version 2.0.10. For some reason, the corresponding target
  'android64-aarch64' was missing OpenSSL 1.0.2, whence it could not be
  built with FIPS support on Android Arm 64-bit. This omission has been
  fixed.

  _Matthias St. Pierre_

### Changes between 1.0.2q and 1.0.2r [26 Feb 2019]

- 0-byte record padding oracle

  If an application encounters a fatal protocol error and then calls
  SSL_shutdown() twice (once to send a close_notify, and once to receive one)
  then OpenSSL can respond differently to the calling application if a 0 byte
  record is received with invalid padding compared to if a 0 byte record is
  received with an invalid MAC. If the application then behaves differently
  based on that in a way that is detectable to the remote peer, then this
  amounts to a padding oracle that could be used to decrypt data.

  In order for this to be exploitable "non-stitched" ciphersuites must be in
  use. Stitched ciphersuites are optimised implementations of certain
  commonly used ciphersuites. Also the application must call SSL_shutdown()
  twice even if a protocol error has occurred (applications should not do
  this but some do anyway).

  This issue was discovered by Juraj Somorovsky, Robert Merget and Nimrod
  Aviram, with additional investigation by Steven Collison and Andrew
  Hourselt. It was reported to OpenSSL on 10th December 2018.
  ([CVE-2019-1559])

  _Matt Caswell_

- Move strictness check from EVP_PKEY_asn1_new() to EVP_PKEY_asn1_add0().

  _Richard Levitte_

### Changes between 1.0.2p and 1.0.2q [20 Nov 2018]

- Microarchitecture timing vulnerability in ECC scalar multiplication

  OpenSSL ECC scalar multiplication, used in e.g. ECDSA and ECDH, has been
  shown to be vulnerable to a microarchitecture timing side channel attack.
  An attacker with sufficient access to mount local timing attacks during
  ECDSA signature generation could recover the private key.

  This issue was reported to OpenSSL on 26th October 2018 by Alejandro
  Cabrera Aldaya, Billy Brumley, Sohaib ul Hassan, Cesar Pereida Garcia and
  Nicola Tuveri.
  ([CVE-2018-5407])

  _Billy Brumley_

- Timing vulnerability in DSA signature generation

  The OpenSSL DSA signature algorithm has been shown to be vulnerable to a
  timing side channel attack. An attacker could use variations in the signing
  algorithm to recover the private key.

  This issue was reported to OpenSSL on 16th October 2018 by Samuel Weiser.
  ([CVE-2018-0734])

  _Paul Dale_

- Resolve a compatibility issue in EC_GROUP handling with the FIPS Object
  Module, accidentally introduced while backporting security fixes from the
  development branch and hindering the use of ECC in FIPS mode.

  _Nicola Tuveri_

### Changes between 1.0.2o and 1.0.2p [14 Aug 2018]

- Client DoS due to large DH parameter

  During key agreement in a TLS handshake using a DH(E) based ciphersuite a
  malicious server can send a very large prime value to the client. This will
  cause the client to spend an unreasonably long period of time generating a
  key for this prime resulting in a hang until the client has finished. This
  could be exploited in a Denial Of Service attack.

  This issue was reported to OpenSSL on 5th June 2018 by Guido Vranken
  ([CVE-2018-0732])

  _Guido Vranken_

- Cache timing vulnerability in RSA Key Generation

  The OpenSSL RSA Key generation algorithm has been shown to be vulnerable to
  a cache timing side channel attack. An attacker with sufficient access to
  mount cache timing attacks during the RSA key generation process could
  recover the private key.

  This issue was reported to OpenSSL on 4th April 2018 by Alejandro Cabrera
  Aldaya, Billy Brumley, Cesar Pereida Garcia and Luis Manuel Alvarez Tapia.
  ([CVE-2018-0737])

  _Billy Brumley_

- Make EVP_PKEY_asn1_new() a bit stricter about its input. A NULL pem_str
  parameter is no longer accepted, as it leads to a corrupt table. NULL
  pem_str is reserved for alias entries only.

  _Richard Levitte_

- Revert blinding in ECDSA sign and instead make problematic addition
  length-invariant. Switch even to fixed-length Montgomery multiplication.

  _Andy Polyakov_

- Change generating and checking of primes so that the error rate of not
  being prime depends on the intended use based on the size of the input.
  For larger primes this will result in more rounds of Miller-Rabin.
  The maximal error rate for primes with more than 1080 bits is lowered
  to 2^-128.

  _Kurt Roeckx, Annie Yousar_

- Increase the number of Miller-Rabin rounds for DSA key generating to 64.

  _Kurt Roeckx_

- Add blinding to ECDSA and DSA signatures to protect against side channel
  attacks discovered by Keegan Ryan (NCC Group).

  _Matt Caswell_

- When unlocking a pass phrase protected PEM file or PKCS#8 container, we
  now allow empty (zero character) pass phrases.

  _Richard Levitte_

- Certificate time validation (X509_cmp_time) enforces stricter
  compliance with RFC 5280. Fractional seconds and timezone offsets
  are no longer allowed.

  _Emilia Käsper_

### Changes between 1.0.2n and 1.0.2o [27 Mar 2018]

- Constructed ASN.1 types with a recursive definition could exceed the stack

  Constructed ASN.1 types with a recursive definition (such as can be found
  in PKCS7) could eventually exceed the stack given malicious input with
  excessive recursion. This could result in a Denial Of Service attack. There
  are no such structures used within SSL/TLS that come from untrusted sources
  so this is considered safe.

  This issue was reported to OpenSSL on 4th January 2018 by the OSS-fuzz
  project.
  ([CVE-2018-0739])

  _Matt Caswell_

### Changes between 1.0.2m and 1.0.2n [7 Dec 2017]

- Read/write after SSL object in error state

  OpenSSL 1.0.2 (starting from version 1.0.2b) introduced an "error state"
  mechanism. The intent was that if a fatal error occurred during a handshake
  then OpenSSL would move into the error state and would immediately fail if
  you attempted to continue the handshake. This works as designed for the
  explicit handshake functions (SSL_do_handshake(), SSL_accept() and
  SSL_connect()), however due to a bug it does not work correctly if
  SSL_read() or SSL_write() is called directly. In that scenario, if the
  handshake fails then a fatal error will be returned in the initial function
  call. If SSL_read()/SSL_write() is subsequently called by the application
  for the same SSL object then it will succeed and the data is passed without
  being decrypted/encrypted directly from the SSL/TLS record layer.

  In order to exploit this issue an application bug would have to be present
  that resulted in a call to SSL_read()/SSL_write() being issued after having
  already received a fatal error.

  This issue was reported to OpenSSL by David Benjamin (Google).
  ([CVE-2017-3737])

  _Matt Caswell_

- rsaz_1024_mul_avx2 overflow bug on x86_64

  There is an overflow bug in the AVX2 Montgomery multiplication procedure
  used in exponentiation with 1024-bit moduli. No EC algorithms are affected.
  Analysis suggests that attacks against RSA and DSA as a result of this
  defect would be very difficult to perform and are not believed likely.
  Attacks against DH1024 are considered just feasible, because most of the
  work necessary to deduce information about a private key may be performed
  offline. The amount of resources required for such an attack would be
  significant. However, for an attack on TLS to be meaningful, the server
  would have to share the DH1024 private key among multiple clients, which is
  no longer an option since CVE-2016-0701.

  This only affects processors that support the AVX2 but not ADX extensions
  like Intel Haswell (4th generation).

  This issue was reported to OpenSSL by David Benjamin (Google). The issue
  was originally found via the OSS-Fuzz project.
  ([CVE-2017-3738])

  _Andy Polyakov_

### Changes between 1.0.2l and 1.0.2m [2 Nov 2017]

- bn_sqrx8x_internal carry bug on x86_64

  There is a carry propagating bug in the x86_64 Montgomery squaring
  procedure. No EC algorithms are affected. Analysis suggests that attacks
  against RSA and DSA as a result of this defect would be very difficult to
  perform and are not believed likely. Attacks against DH are considered just
  feasible (although very difficult) because most of the work necessary to
  deduce information about a private key may be performed offline. The amount
  of resources required for such an attack would be very significant and
  likely only accessible to a limited number of attackers. An attacker would
  additionally need online access to an unpatched system using the target
  private key in a scenario with persistent DH parameters and a private
  key that is shared between multiple clients.

  This only affects processors that support the BMI1, BMI2 and ADX extensions
  like Intel Broadwell (5th generation) and later or AMD Ryzen.

  This issue was reported to OpenSSL by the OSS-Fuzz project.
  ([CVE-2017-3736])

  _Andy Polyakov_

- Malformed X.509 IPAddressFamily could cause OOB read

  If an X.509 certificate has a malformed IPAddressFamily extension,
  OpenSSL could do a one-byte buffer overread. The most likely result
  would be an erroneous display of the certificate in text format.

  This issue was reported to OpenSSL by the OSS-Fuzz project.

  _Rich Salz_

### Changes between 1.0.2k and 1.0.2l [25 May 2017]

- Have 'config' recognise 64-bit mingw and choose 'mingw64' as the target
  platform rather than 'mingw'.

  _Richard Levitte_

### Changes between 1.0.2j and 1.0.2k [26 Jan 2017]

- Truncated packet could crash via OOB read

  If one side of an SSL/TLS path is running on a 32-bit host and a specific
  cipher is being used, then a truncated packet can cause that host to
  perform an out-of-bounds read, usually resulting in a crash.

  This issue was reported to OpenSSL by Robert Święcki of Google.
  ([CVE-2017-3731])

  _Andy Polyakov_

- BN_mod_exp may produce incorrect results on x86_64

  There is a carry propagating bug in the x86_64 Montgomery squaring
  procedure. No EC algorithms are affected. Analysis suggests that attacks
  against RSA and DSA as a result of this defect would be very difficult to
  perform and are not believed likely. Attacks against DH are considered just
  feasible (although very difficult) because most of the work necessary to
  deduce information about a private key may be performed offline. The amount
  of resources required for such an attack would be very significant and
  likely only accessible to a limited number of attackers. An attacker would
  additionally need online access to an unpatched system using the target
  private key in a scenario with persistent DH parameters and a private
  key that is shared between multiple clients. For example this can occur by
  default in OpenSSL DHE based SSL/TLS ciphersuites. Note: This issue is very
  similar to CVE-2015-3193 but must be treated as a separate problem.

  This issue was reported to OpenSSL by the OSS-Fuzz project.
  ([CVE-2017-3732])

  _Andy Polyakov_

- Montgomery multiplication may produce incorrect results

  There is a carry propagating bug in the Broadwell-specific Montgomery
  multiplication procedure that handles input lengths divisible by, but
  longer than 256 bits. Analysis suggests that attacks against RSA, DSA
  and DH private keys are impossible. This is because the subroutine in
  question is not used in operations with the private key itself and an input
  of the attacker's direct choice. Otherwise the bug can manifest itself as
  transient authentication and key negotiation failures or reproducible
  erroneous outcome of public-key operations with specially crafted input.
  Among EC algorithms only Brainpool P-512 curves are affected and one
  presumably can attack ECDH key negotiation. Impact was not analyzed in
  detail, because pre-requisites for attack are considered unlikely. Namely
  multiple clients have to choose the curve in question and the server has to
  share the private key among them, neither of which is default behaviour.
  Even then only clients that chose the curve will be affected.

  This issue was publicly reported as transient failures and was not
  initially recognized as a security issue. Thanks to Richard Morgan for
  providing reproducible case.
  ([CVE-2016-7055])

  _Andy Polyakov_

- OpenSSL now fails if it receives an unrecognised record type in TLS1.0
  or TLS1.1. Previously this only happened in SSLv3 and TLS1.2. This is to
  prevent issues where no progress is being made and the peer continually
  sends unrecognised record types, using up resources processing them.

  _Matt Caswell_

### Changes between 1.0.2i and 1.0.2j [26 Sep 2016]

- Missing CRL sanity check

  A bug fix which included a CRL sanity check was added to OpenSSL 1.1.0
  but was omitted from OpenSSL 1.0.2i. As a result any attempt to use
  CRLs in OpenSSL 1.0.2i will crash with a null pointer exception.

  This issue only affects the OpenSSL 1.0.2i
  ([CVE-2016-7052])

  _Matt Caswell_

### Changes between 1.0.2h and 1.0.2i [22 Sep 2016]

- OCSP Status Request extension unbounded memory growth

  A malicious client can send an excessively large OCSP Status Request
  extension. If that client continually requests renegotiation, sending a
  large OCSP Status Request extension each time, then there will be unbounded
  memory growth on the server. This will eventually lead to a Denial Of
  Service attack through memory exhaustion. Servers with a default
  configuration are vulnerable even if they do not support OCSP. Builds using
  the "no-ocsp" build time option are not affected.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6304])

  _Matt Caswell_

- In order to mitigate the SWEET32 attack, the DES ciphers were moved from
  HIGH to MEDIUM.

  This issue was reported to OpenSSL Karthikeyan Bhargavan and Gaetan
  Leurent (INRIA)
  ([CVE-2016-2183])

  _Rich Salz_

- OOB write in MDC2_Update()

  An overflow can occur in MDC2_Update() either if called directly or
  through the EVP_DigestUpdate() function using MDC2. If an attacker
  is able to supply very large amounts of input data after a previous
  call to EVP_EncryptUpdate() with a partial block then a length check
  can overflow resulting in a heap corruption.

  The amount of data needed is comparable to SIZE_MAX which is impractical
  on most platforms.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6303])

  _Stephen Henson_

- Malformed SHA512 ticket DoS

  If a server uses SHA512 for TLS session ticket HMAC it is vulnerable to a
  DoS attack where a malformed ticket will result in an OOB read which will
  ultimately crash.

  The use of SHA512 in TLS session tickets is comparatively rare as it requires
  a custom server callback and ticket lookup mechanism.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6302])

  _Stephen Henson_

- OOB write in BN_bn2dec()

  The function BN_bn2dec() does not check the return value of BN_div_word().
  This can cause an OOB write if an application uses this function with an
  overly large BIGNUM. This could be a problem if an overly large certificate
  or CRL is printed out from an untrusted source. TLS is not affected because
  record limits will reject an oversized certificate before it is parsed.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-2182])

  _Stephen Henson_

- OOB read in TS_OBJ_print_bio()

  The function TS_OBJ_print_bio() misuses OBJ_obj2txt(): the return value is
  the total length the OID text representation would use and not the amount
  of data written. This will result in OOB reads when large OIDs are
  presented.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-2180])

  _Stephen Henson_

- Pointer arithmetic undefined behaviour

  Avoid some undefined pointer arithmetic

  A common idiom in the codebase is to check limits in the following manner:
  "p + len > limit"

  Where "p" points to some malloc'd data of SIZE bytes and
  limit == p + SIZE

  "len" here could be from some externally supplied data (e.g. from a TLS
  message).

  The rules of C pointer arithmetic are such that "p + len" is only well
  defined where len <= SIZE. Therefore the above idiom is actually
  undefined behaviour.

  For example this could cause problems if some malloc implementation
  provides an address for "p" such that "p + len" actually overflows for
  values of len that are too big and therefore p + len < limit.

  This issue was reported to OpenSSL by Guido Vranken
  ([CVE-2016-2177])

  _Matt Caswell_

- Constant time flag not preserved in DSA signing

  Operations in the DSA signing algorithm should run in constant time in
  order to avoid side channel attacks. A flaw in the OpenSSL DSA
  implementation means that a non-constant time codepath is followed for
  certain operations. This has been demonstrated through a cache-timing
  attack to be sufficient for an attacker to recover the private DSA key.

  This issue was reported by César Pereida (Aalto University), Billy Brumley
  (Tampere University of Technology), and Yuval Yarom (The University of
  Adelaide and NICTA).
  ([CVE-2016-2178])

  _César Pereida_

- DTLS buffered message DoS

  In a DTLS connection where handshake messages are delivered out-of-order
  those messages that OpenSSL is not yet ready to process will be buffered
  for later use. Under certain circumstances, a flaw in the logic means that
  those messages do not get removed from the buffer even though the handshake
  has been completed. An attacker could force up to approx. 15 messages to
  remain in the buffer when they are no longer required. These messages will
  be cleared when the DTLS connection is closed. The default maximum size for
  a message is 100k. Therefore, the attacker could force an additional 1500k
  to be consumed per connection. By opening many simultaneous connections an
  attacker could cause a DoS attack through memory exhaustion.

  This issue was reported to OpenSSL by Quan Luo.
  ([CVE-2016-2179])

  _Matt Caswell_

- DTLS replay protection DoS

  A flaw in the DTLS replay attack protection mechanism means that records
  that arrive for future epochs update the replay protection "window" before
  the MAC for the record has been validated. This could be exploited by an
  attacker by sending a record for the next epoch (which does not have to
  decrypt or have a valid MAC), with a very large sequence number. This means
  that all subsequent legitimate packets are dropped causing a denial of
  service for a specific DTLS connection.

  This issue was reported to OpenSSL by the OCAP audit team.
  ([CVE-2016-2181])

  _Matt Caswell_

- Certificate message OOB reads

  In OpenSSL 1.0.2 and earlier some missing message length checks can result
  in OOB reads of up to 2 bytes beyond an allocated buffer. There is a
  theoretical DoS risk but this has not been observed in practice on common
  platforms.

  The messages affected are client certificate, client certificate request
  and server certificate. As a result the attack can only be performed
  against a client or a server which enables client authentication.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6306])

  _Stephen Henson_

### Changes between 1.0.2g and 1.0.2h [3 May 2016]

- Prevent padding oracle in AES-NI CBC MAC check

  A MITM attacker can use a padding oracle attack to decrypt traffic
  when the connection uses an AES CBC cipher and the server support
  AES-NI.

  This issue was introduced as part of the fix for Lucky 13 padding
  attack ([CVE-2013-0169]). The padding check was rewritten to be in
  constant time by making sure that always the same bytes are read and
  compared against either the MAC or padding bytes. But it no longer
  checked that there was enough data to have both the MAC and padding
  bytes.

  This issue was reported by Juraj Somorovsky using TLS-Attacker.

  _Kurt Roeckx_

- Fix EVP_EncodeUpdate overflow

  An overflow can occur in the EVP_EncodeUpdate() function which is used for
  Base64 encoding of binary data. If an attacker is able to supply very large
  amounts of input data then a length check can overflow resulting in a heap
  corruption.

  Internally to OpenSSL the EVP_EncodeUpdate() function is primarily used by
  the `PEM_write_bio*` family of functions. These are mainly used within the
  OpenSSL command line applications, so any application which processes data
  from an untrusted source and outputs it as a PEM file should be considered
  vulnerable to this issue. User applications that call these APIs directly
  with large amounts of untrusted data may also be vulnerable.

  This issue was reported by Guido Vranken.
  ([CVE-2016-2105])

  _Matt Caswell_

- Fix EVP_EncryptUpdate overflow

  An overflow can occur in the EVP_EncryptUpdate() function. If an attacker
  is able to supply very large amounts of input data after a previous call to
  EVP_EncryptUpdate() with a partial block then a length check can overflow
  resulting in a heap corruption. Following an analysis of all OpenSSL
  internal usage of the EVP_EncryptUpdate() function all usage is one of two
  forms. The first form is where the EVP_EncryptUpdate() call is known to be
  the first called function after an EVP_EncryptInit(), and therefore that
  specific call must be safe. The second form is where the length passed to
  EVP_EncryptUpdate() can be seen from the code to be some small value and
  therefore there is no possibility of an overflow. Since all instances are
  one of these two forms, it is believed that there can be no overflows in
  internal code due to this problem. It should be noted that
  EVP_DecryptUpdate() can call EVP_EncryptUpdate() in certain code paths.
  Also EVP_CipherUpdate() is a synonym for EVP_EncryptUpdate(). All instances
  of these calls have also been analysed too and it is believed there are no
  instances in internal usage where an overflow could occur.

  This issue was reported by Guido Vranken.
  ([CVE-2016-2106])

  _Matt Caswell_

- Prevent ASN.1 BIO excessive memory allocation

  When ASN.1 data is read from a BIO using functions such as d2i_CMS_bio()
  a short invalid encoding can cause allocation of large amounts of memory
  potentially consuming excessive resources or exhausting memory.

  Any application parsing untrusted data through d2i BIO functions is
  affected. The memory based functions such as d2i*X509() are \_not* affected.
  Since the memory based functions are used by the TLS library, TLS
  applications are not affected.

  This issue was reported by Brian Carpenter.
  ([CVE-2016-2109])

  _Stephen Henson_

- EBCDIC overread

  ASN1 Strings that are over 1024 bytes can cause an overread in applications
  using the X509_NAME_oneline() function on EBCDIC systems. This could result
  in arbitrary stack data being returned in the buffer.

  This issue was reported by Guido Vranken.
  ([CVE-2016-2176])

  _Matt Caswell_

- Modify behavior of ALPN to invoke callback after SNI/servername
  callback, such that updates to the SSL_CTX affect ALPN.

  _Todd Short_

- Remove LOW from the DEFAULT cipher list. This removes singles DES from the
  default.

  _Kurt Roeckx_

- Only remove the SSLv2 methods with the no-ssl2-method option. When the
  methods are enabled and ssl2 is disabled the methods return NULL.

  _Kurt Roeckx_

### Changes between 1.0.2f and 1.0.2g [1 Mar 2016]

- Disable weak ciphers in SSLv3 and up in default builds of OpenSSL.
  Builds that are not configured with "enable-weak-ssl-ciphers" will not
  provide any "EXPORT" or "LOW" strength ciphers.

  _Viktor Dukhovni_

- Disable SSLv2 default build, default negotiation and weak ciphers. SSLv2
  is by default disabled at build-time. Builds that are not configured with
  "enable-ssl2" will not support SSLv2. Even if "enable-ssl2" is used,
  users who want to negotiate SSLv2 via the version-flexible SSLv23_method()
  will need to explicitly call either of:

      SSL_CTX_clear_options(ctx, SSL_OP_NO_SSLv2);

  or
  SSL_clear_options(ssl, SSL_OP_NO_SSLv2);

  as appropriate. Even if either of those is used, or the application
  explicitly uses the version-specific SSLv2_method() or its client and
  server variants, SSLv2 ciphers vulnerable to exhaustive search key
  recovery have been removed. Specifically, the SSLv2 40-bit EXPORT
  ciphers, and SSLv2 56-bit DES are no longer available.
  ([CVE-2016-0800])

  _Viktor Dukhovni_

- Fix a double-free in DSA code

  A double free bug was discovered when OpenSSL parses malformed DSA private
  keys and could lead to a DoS attack or memory corruption for applications
  that receive DSA private keys from untrusted sources. This scenario is
  considered rare.

  This issue was reported to OpenSSL by Adam Langley(Google/BoringSSL) using
  libFuzzer.
  ([CVE-2016-0705])

  _Stephen Henson_

- Disable SRP fake user seed to address a server memory leak.

  Add a new method SRP_VBASE_get1_by_user that handles the seed properly.

  SRP_VBASE_get_by_user had inconsistent memory management behaviour.
  In order to fix an unavoidable memory leak, SRP_VBASE_get_by_user
  was changed to ignore the "fake user" SRP seed, even if the seed
  is configured.

  Users should use SRP_VBASE_get1_by_user instead. Note that in
  SRP_VBASE_get1_by_user, caller must free the returned value. Note
  also that even though configuring the SRP seed attempts to hide
  invalid usernames by continuing the handshake with fake
  credentials, this behaviour is not constant time and no strong
  guarantees are made that the handshake is indistinguishable from
  that of a valid user.
  ([CVE-2016-0798])

  _Emilia Käsper_

- Fix BN_hex2bn/BN_dec2bn NULL pointer deref/heap corruption

  In the BN_hex2bn function the number of hex digits is calculated using an
  int value `i`. Later `bn_expand` is called with a value of `i * 4`. For
  large values of `i` this can result in `bn_expand` not allocating any
  memory because `i * 4` is negative. This can leave the internal BIGNUM data
  field as NULL leading to a subsequent NULL ptr deref. For very large values
  of `i`, the calculation `i * 4` could be a positive value smaller than `i`.
  In this case memory is allocated to the internal BIGNUM data field, but it
  is insufficiently sized leading to heap corruption. A similar issue exists
  in BN_dec2bn. This could have security consequences if BN_hex2bn/BN_dec2bn
  is ever called by user applications with very large untrusted hex/dec data.
  This is anticipated to be a rare occurrence.

  All OpenSSL internal usage of these functions use data that is not expected
  to be untrusted, e.g. config file data or application command line
  arguments. If user developed applications generate config file data based
  on untrusted data then it is possible that this could also lead to security
  consequences. This is also anticipated to be rare.

  This issue was reported to OpenSSL by Guido Vranken.
  ([CVE-2016-0797])

  _Matt Caswell_

- Fix memory issues in `BIO_*printf` functions

  The internal `fmtstr` function used in processing a "%s" format string in
  the `BIO_*printf` functions could overflow while calculating the length of a
  string and cause an OOB read when printing very long strings.

  Additionally the internal `doapr_outch` function can attempt to write to an
  OOB memory location (at an offset from the NULL pointer) in the event of a
  memory allocation failure. In 1.0.2 and below this could be caused where
  the size of a buffer to be allocated is greater than INT_MAX. E.g. this
  could be in processing a very long "%s" format string. Memory leaks can
  also occur.

  The first issue may mask the second issue dependent on compiler behaviour.
  These problems could enable attacks where large amounts of untrusted data
  is passed to the `BIO_*printf` functions. If applications use these functions
  in this way then they could be vulnerable. OpenSSL itself uses these
  functions when printing out human-readable dumps of ASN.1 data. Therefore
  applications that print this data could be vulnerable if the data is from
  untrusted sources. OpenSSL command line applications could also be
  vulnerable where they print out ASN.1 data, or if untrusted data is passed
  as command line arguments.

  Libssl is not considered directly vulnerable. Additionally certificates etc
  received via remote connections via libssl are also unlikely to be able to
  trigger these issues because of message size limits enforced within libssl.

  This issue was reported to OpenSSL Guido Vranken.
  ([CVE-2016-0799])

  _Matt Caswell_

- Side channel attack on modular exponentiation

  A side-channel attack was found which makes use of cache-bank conflicts on
  the Intel Sandy-Bridge microarchitecture which could lead to the recovery
  of RSA keys. The ability to exploit this issue is limited as it relies on
  an attacker who has control of code in a thread running on the same
  hyper-threaded core as the victim thread which is performing decryptions.

  This issue was reported to OpenSSL by Yuval Yarom, The University of
  Adelaide and NICTA, Daniel Genkin, Technion and Tel Aviv University, and
  Nadia Heninger, University of Pennsylvania with more information at
  <http://cachebleed.info>.
  ([CVE-2016-0702])

  _Andy Polyakov_

- Change the `req` command to generate a 2048-bit RSA/DSA key by default,
  if no keysize is specified with default_bits. This fixes an
  omission in an earlier change that changed all RSA/DSA key generation
  commands to use 2048 bits by default.

  _Emilia Käsper_

### Changes between 1.0.2e and 1.0.2f [28 Jan 2016]

- DH small subgroups

  Historically OpenSSL only ever generated DH parameters based on "safe"
  primes. More recently (in version 1.0.2) support was provided for
  generating X9.42 style parameter files such as those required for RFC 5114
  support. The primes used in such files may not be "safe". Where an
  application is using DH configured with parameters based on primes that are
  not "safe" then an attacker could use this fact to find a peer's private
  DH exponent. This attack requires that the attacker complete multiple
  handshakes in which the peer uses the same private DH exponent. For example
  this could be used to discover a TLS server's private DH exponent if it's
  reusing the private DH exponent or it's using a static DH ciphersuite.

  OpenSSL provides the option SSL_OP_SINGLE_DH_USE for ephemeral DH (DHE) in
  TLS. It is not on by default. If the option is not set then the server
  reuses the same private DH exponent for the life of the server process and
  would be vulnerable to this attack. It is believed that many popular
  applications do set this option and would therefore not be at risk.

  The fix for this issue adds an additional check where a "q" parameter is
  available (as is the case in X9.42 based parameters). This detects the
  only known attack, and is the only possible defense for static DH
  ciphersuites. This could have some performance impact.

  Additionally the SSL_OP_SINGLE_DH_USE option has been switched on by
  default and cannot be disabled. This could have some performance impact.

  This issue was reported to OpenSSL by Antonio Sanso (Adobe).
  ([CVE-2016-0701])

  _Matt Caswell_

- SSLv2 doesn't block disabled ciphers

  A malicious client can negotiate SSLv2 ciphers that have been disabled on
  the server and complete SSLv2 handshakes even if all SSLv2 ciphers have
  been disabled, provided that the SSLv2 protocol was not also disabled via
  SSL_OP_NO_SSLv2.

  This issue was reported to OpenSSL on 26th December 2015 by Nimrod Aviram
  and Sebastian Schinzel.
  ([CVE-2015-3197])

  _Viktor Dukhovni_

### Changes between 1.0.2d and 1.0.2e [3 Dec 2015]

- BN_mod_exp may produce incorrect results on x86_64

  There is a carry propagating bug in the x86_64 Montgomery squaring
  procedure. No EC algorithms are affected. Analysis suggests that attacks
  against RSA and DSA as a result of this defect would be very difficult to
  perform and are not believed likely. Attacks against DH are considered just
  feasible (although very difficult) because most of the work necessary to
  deduce information about a private key may be performed offline. The amount
  of resources required for such an attack would be very significant and
  likely only accessible to a limited number of attackers. An attacker would
  additionally need online access to an unpatched system using the target
  private key in a scenario with persistent DH parameters and a private
  key that is shared between multiple clients. For example this can occur by
  default in OpenSSL DHE based SSL/TLS ciphersuites.

  This issue was reported to OpenSSL by Hanno Böck.
  ([CVE-2015-3193])

  _Andy Polyakov_

- Certificate verify crash with missing PSS parameter

  The signature verification routines will crash with a NULL pointer
  dereference if presented with an ASN.1 signature using the RSA PSS
  algorithm and absent mask generation function parameter. Since these
  routines are used to verify certificate signature algorithms this can be
  used to crash any certificate verification operation and exploited in a
  DoS attack. Any application which performs certificate verification is
  vulnerable including OpenSSL clients and servers which enable client
  authentication.

  This issue was reported to OpenSSL by Loïc Jonas Etienne (Qnective AG).
  ([CVE-2015-3194])

  _Stephen Henson_

- X509_ATTRIBUTE memory leak

  When presented with a malformed X509_ATTRIBUTE structure OpenSSL will leak
  memory. This structure is used by the PKCS#7 and CMS routines so any
  application which reads PKCS#7 or CMS data from untrusted sources is
  affected. SSL/TLS is not affected.

  This issue was reported to OpenSSL by Adam Langley (Google/BoringSSL) using
  libFuzzer.
  ([CVE-2015-3195])

  _Stephen Henson_

- Rewrite EVP_DecodeUpdate (base64 decoding) to fix several bugs.
  This changes the decoding behaviour for some invalid messages,
  though the change is mostly in the more lenient direction, and
  legacy behaviour is preserved as much as possible.

  _Emilia Käsper_

- In DSA_generate_parameters_ex, if the provided seed is too short,
  return an error

  _Rich Salz and Ismo Puustinen <ismo.puustinen@intel.com>_

### Changes between 1.0.2c and 1.0.2d [9 Jul 2015]

- Alternate chains certificate forgery

  During certificate verification, OpenSSL will attempt to find an
  alternative certificate chain if the first attempt to build such a chain
  fails. An error in the implementation of this logic can mean that an
  attacker could cause certain checks on untrusted certificates to be
  bypassed, such as the CA flag, enabling them to use a valid leaf
  certificate to act as a CA and "issue" an invalid certificate.

  This issue was reported to OpenSSL by Adam Langley/David Benjamin
  (Google/BoringSSL).

  _Matt Caswell_

### Changes between 1.0.2b and 1.0.2c [12 Jun 2015]

- Fix HMAC ABI incompatibility. The previous version introduced an ABI
  incompatibility in the handling of HMAC. The previous ABI has now been
  restored.

  _Matt Caswell_

### Changes between 1.0.2a and 1.0.2b [11 Jun 2015]

- Malformed ECParameters causes infinite loop

  When processing an ECParameters structure OpenSSL enters an infinite loop
  if the curve specified is over a specially malformed binary polynomial
  field.

  This can be used to perform denial of service against any
  system which processes public keys, certificate requests or
  certificates. This includes TLS clients and TLS servers with
  client authentication enabled.

  This issue was reported to OpenSSL by Joseph Barr-Pixton.
  ([CVE-2015-1788])

  _Andy Polyakov_

- Exploitable out-of-bounds read in X509_cmp_time

  X509_cmp_time does not properly check the length of the ASN1_TIME
  string and can read a few bytes out of bounds. In addition,
  X509_cmp_time accepts an arbitrary number of fractional seconds in the
  time string.

  An attacker can use this to craft malformed certificates and CRLs of
  various sizes and potentially cause a segmentation fault, resulting in
  a DoS on applications that verify certificates or CRLs. TLS clients
  that verify CRLs are affected. TLS clients and servers with client
  authentication enabled may be affected if they use custom verification
  callbacks.

  This issue was reported to OpenSSL by Robert Swiecki (Google), and
  independently by Hanno Böck.
  ([CVE-2015-1789])

  _Emilia Käsper_

- PKCS7 crash with missing EnvelopedContent

  The PKCS#7 parsing code does not handle missing inner EncryptedContent
  correctly. An attacker can craft malformed ASN.1-encoded PKCS#7 blobs
  with missing content and trigger a NULL pointer dereference on parsing.

  Applications that decrypt PKCS#7 data or otherwise parse PKCS#7
  structures from untrusted sources are affected. OpenSSL clients and
  servers are not affected.

  This issue was reported to OpenSSL by Michal Zalewski (Google).
  ([CVE-2015-1790])

  _Emilia Käsper_

- CMS verify infinite loop with unknown hash function

  When verifying a signedData message the CMS code can enter an infinite loop
  if presented with an unknown hash function OID. This can be used to perform
  denial of service against any system which verifies signedData messages using
  the CMS code.
  This issue was reported to OpenSSL by Johannes Bauer.
  ([CVE-2015-1792])

  _Stephen Henson_

- Race condition handling NewSessionTicket

  If a NewSessionTicket is received by a multi-threaded client when attempting to
  reuse a previous ticket then a race condition can occur potentially leading to
  a double free of the ticket data.
  ([CVE-2015-1791])

  _Matt Caswell_

- Only support 256-bit or stronger elliptic curves with the
  'ecdh_auto' setting (server) or by default (client). Of supported
  curves, prefer P-256 (both).

  _Emilia Kasper_

### Changes between 1.0.2 and 1.0.2a [19 Mar 2015]

- ClientHello sigalgs DoS fix

  If a client connects to an OpenSSL 1.0.2 server and renegotiates with an
  invalid signature algorithms extension a NULL pointer dereference will
  occur. This can be exploited in a DoS attack against the server.

  This issue was was reported to OpenSSL by David Ramos of Stanford
  University.
  ([CVE-2015-0291])

  _Stephen Henson and Matt Caswell_

- Multiblock corrupted pointer fix

  OpenSSL 1.0.2 introduced the "multiblock" performance improvement. This
  feature only applies on 64 bit x86 architecture platforms that support AES
  NI instructions. A defect in the implementation of "multiblock" can cause
  OpenSSL's internal write buffer to become incorrectly set to NULL when
  using non-blocking IO. Typically, when the user application is using a
  socket BIO for writing, this will only result in a failed connection.
  However if some other BIO is used then it is likely that a segmentation
  fault will be triggered, thus enabling a potential DoS attack.

  This issue was reported to OpenSSL by Daniel Danner and Rainer Mueller.
  ([CVE-2015-0290])

  _Matt Caswell_

- Segmentation fault in DTLSv1_listen fix

  The DTLSv1_listen function is intended to be stateless and processes the
  initial ClientHello from many peers. It is common for user code to loop
  over the call to DTLSv1_listen until a valid ClientHello is received with
  an associated cookie. A defect in the implementation of DTLSv1_listen means
  that state is preserved in the SSL object from one invocation to the next
  that can lead to a segmentation fault. Errors processing the initial
  ClientHello can trigger this scenario. An example of such an error could be
  that a DTLS1.0 only client is attempting to connect to a DTLS1.2 only
  server.

  This issue was reported to OpenSSL by Per Allansson.
  ([CVE-2015-0207])

  _Matt Caswell_

- Segmentation fault in ASN1_TYPE_cmp fix

  The function ASN1_TYPE_cmp will crash with an invalid read if an attempt is
  made to compare ASN.1 boolean types. Since ASN1_TYPE_cmp is used to check
  certificate signature algorithm consistency this can be used to crash any
  certificate verification operation and exploited in a DoS attack. Any
  application which performs certificate verification is vulnerable including
  OpenSSL clients and servers which enable client authentication.
  ([CVE-2015-0286])

  _Stephen Henson_

- Segmentation fault for invalid PSS parameters fix

  The signature verification routines will crash with a NULL pointer
  dereference if presented with an ASN.1 signature using the RSA PSS
  algorithm and invalid parameters. Since these routines are used to verify
  certificate signature algorithms this can be used to crash any
  certificate verification operation and exploited in a DoS attack. Any
  application which performs certificate verification is vulnerable including
  OpenSSL clients and servers which enable client authentication.

  This issue was was reported to OpenSSL by Brian Carpenter.
  ([CVE-2015-0208])

  _Stephen Henson_

- ASN.1 structure reuse memory corruption fix

  Reusing a structure in ASN.1 parsing may allow an attacker to cause
  memory corruption via an invalid write. Such reuse is and has been
  strongly discouraged and is believed to be rare.

  Applications that parse structures containing CHOICE or ANY DEFINED BY
  components may be affected. Certificate parsing (d2i_X509 and related
  functions) are however not affected. OpenSSL clients and servers are
  not affected.
  ([CVE-2015-0287])

  _Stephen Henson_

- PKCS7 NULL pointer dereferences fix

  The PKCS#7 parsing code does not handle missing outer ContentInfo
  correctly. An attacker can craft malformed ASN.1-encoded PKCS#7 blobs with
  missing content and trigger a NULL pointer dereference on parsing.

  Applications that verify PKCS#7 signatures, decrypt PKCS#7 data or
  otherwise parse PKCS#7 structures from untrusted sources are
  affected. OpenSSL clients and servers are not affected.

  This issue was reported to OpenSSL by Michal Zalewski (Google).
  ([CVE-2015-0289])

  _Emilia Käsper_

- DoS via reachable assert in SSLv2 servers fix

  A malicious client can trigger an OPENSSL_assert (i.e., an abort) in
  servers that both support SSLv2 and enable export cipher suites by sending
  a specially crafted SSLv2 CLIENT-MASTER-KEY message.

  This issue was discovered by Sean Burford (Google) and Emilia Käsper
  (OpenSSL development team).
  ([CVE-2015-0293])

  _Emilia Käsper_

- Empty CKE with client auth and DHE fix

  If client auth is used then a server can seg fault in the event of a DHE
  ciphersuite being selected and a zero length ClientKeyExchange message
  being sent by the client. This could be exploited in a DoS attack.
  ([CVE-2015-1787])

  _Matt Caswell_

- Handshake with unseeded PRNG fix

  Under certain conditions an OpenSSL 1.0.2 client can complete a handshake
  with an unseeded PRNG. The conditions are:
  - The client is on a platform where the PRNG has not been seeded
    automatically, and the user has not seeded manually
  - A protocol specific client method version has been used (i.e. not
    SSL_client_methodv23)
  - A ciphersuite is used that does not require additional random data from
    the PRNG beyond the initial ClientHello client random (e.g. PSK-RC4-SHA).

  If the handshake succeeds then the client random that has been used will
  have been generated from a PRNG with insufficient entropy and therefore the
  output may be predictable.

  For example using the following command with an unseeded openssl will
  succeed on an unpatched platform:

  openssl s_client -psk 1a2b3c4d -tls1_2 -cipher PSK-RC4-SHA
  ([CVE-2015-0285])

  _Matt Caswell_

- Use After Free following d2i_ECPrivatekey error fix

  A malformed EC private key file consumed via the d2i_ECPrivateKey function
  could cause a use after free condition. This, in turn, could cause a double
  free in several private key parsing functions (such as d2i_PrivateKey
  or EVP_PKCS82PKEY) and could lead to a DoS attack or memory corruption
  for applications that receive EC private keys from untrusted
  sources. This scenario is considered rare.

  This issue was discovered by the BoringSSL project and fixed in their
  commit 517073cd4b.
  ([CVE-2015-0209])

  _Matt Caswell_

- X509_to_X509_REQ NULL pointer deref fix

  The function X509_to_X509_REQ will crash with a NULL pointer dereference if
  the certificate key is invalid. This function is rarely used in practice.

  This issue was discovered by Brian Carpenter.
  ([CVE-2015-0288])

  _Stephen Henson_

- Removed the export ciphers from the DEFAULT ciphers

  _Kurt Roeckx_

### Changes between 1.0.1l and 1.0.2 [22 Jan 2015]

- Facilitate "universal" ARM builds targeting range of ARM ISAs, e.g.
  ARMv5 through ARMv8, as opposite to "locking" it to single one.
  So far those who have to target multiple platforms would compromise
  and argue that binary targeting say ARMv5 would still execute on
  ARMv8. "Universal" build resolves this compromise by providing
  near-optimal performance even on newer platforms.

  _Andy Polyakov_

- Accelerated NIST P-256 elliptic curve implementation for x86_64
  (other platforms pending).

  _Shay Gueron & Vlad Krasnov (Intel Corp), Andy Polyakov_

- Add support for the SignedCertificateTimestampList certificate and
  OCSP response extensions from RFC6962.

  _Rob Stradling_

- Fix ec_GFp_simple_points_make_affine (thus, EC_POINTs_mul etc.)
  for corner cases. (Certain input points at infinity could lead to
  bogus results, with non-infinity inputs mapped to infinity too.)

  _Bodo Moeller_

- Initial support for PowerISA 2.0.7, first implemented in POWER8.
  This covers AES, SHA256/512 and GHASH. "Initial" means that most
  common cases are optimized and there still is room for further
  improvements. Vector Permutation AES for Altivec is also added.

  _Andy Polyakov_

- Add support for little-endian ppc64 Linux target.

  _Marcelo Cerri (IBM)_

- Initial support for AMRv8 ISA crypto extensions. This covers AES,
  SHA1, SHA256 and GHASH. "Initial" means that most common cases
  are optimized and there still is room for further improvements.
  Both 32- and 64-bit modes are supported.

  _Andy Polyakov, Ard Biesheuvel (Linaro)_

- Improved ARMv7 NEON support.

  _Andy Polyakov_

- Support for SPARC Architecture 2011 crypto extensions, first
  implemented in SPARC T4. This covers AES, DES, Camellia, SHA1,
  SHA256/512, MD5, GHASH and modular exponentiation.

  _Andy Polyakov, David Miller_

- Accelerated modular exponentiation for Intel processors, a.k.a.
  RSAZ.

  _Shay Gueron & Vlad Krasnov (Intel Corp)_

- Support for new and upcoming Intel processors, including AVX2,
  BMI and SHA ISA extensions. This includes additional "stitched"
  implementations, AESNI-SHA256 and GCM, and multi-buffer support
  for TLS encrypt.

  This work was sponsored by Intel Corp.

  _Andy Polyakov_

- Support for DTLS 1.2. This adds two sets of DTLS methods: DTLS*\*\_method()
  supports both DTLS 1.2 and 1.0 and should use whatever version the peer
  supports and DTLSv1_2*\*\_method() which supports DTLS 1.2 only.

  _Steve Henson_

- Use algorithm specific chains in SSL_CTX_use_certificate_chain_file():
  this fixes a limitation in previous versions of OpenSSL.

  _Steve Henson_

- Extended RSA OAEP support via EVP_PKEY API. Options to specify digest,
  MGF1 digest and OAEP label.

  _Steve Henson_

- Add EVP support for key wrapping algorithms, to avoid problems with
  existing code the flag EVP_CIPHER_CTX_WRAP_ALLOW has to be set in
  the EVP_CIPHER_CTX or an error is returned. Add AES and DES3 wrap
  algorithms and include tests cases.

  _Steve Henson_

- Add functions to allocate and set the fields of an ECDSA_METHOD
  structure.

  _Douglas E. Engert, Steve Henson_

- New functions OPENSSL_gmtime_diff and ASN1_TIME_diff to find the
  difference in days and seconds between two tm or ASN1_TIME structures.

  _Steve Henson_

- Add -rev test option to s_server to just reverse order of characters
  received by client and send back to server. Also prints an abbreviated
  summary of the connection parameters.

  _Steve Henson_

- New option -brief for s_client and s_server to print out a brief summary
  of connection parameters.

  _Steve Henson_

- Add callbacks for arbitrary TLS extensions.

  _Trevor Perrin <trevp@trevp.net> and Ben Laurie_

- New option -crl_download in several openssl utilities to download CRLs
  from CRLDP extension in certificates.

  _Steve Henson_

- New options -CRL and -CRLform for s_client and s_server for CRLs.

  _Steve Henson_

- New function X509_CRL_diff to generate a delta CRL from the difference
  of two full CRLs. Add support to "crl" utility.

  _Steve Henson_

- New functions to set lookup_crls function and to retrieve
  X509_STORE from X509_STORE_CTX.

  _Steve Henson_

- Print out deprecated issuer and subject unique ID fields in
  certificates.

  _Steve Henson_

- Extend OCSP I/O functions so they can be used for simple general purpose
  HTTP as well as OCSP. New wrapper function which can be used to download
  CRLs using the OCSP API.

  _Steve Henson_

- Delegate command line handling in s_client/s_server to SSL_CONF APIs.

  _Steve Henson_

- `SSL_CONF*` functions. These provide a common framework for application
  configuration using configuration files or command lines.

  _Steve Henson_

- SSL/TLS tracing code. This parses out SSL/TLS records using the
  message callback and prints the results. Needs compile time option
  "enable-ssl-trace". New options to s_client and s_server to enable
  tracing.

  _Steve Henson_

- New ctrl and macro to retrieve supported points extensions.
  Print out extension in s_server and s_client.

  _Steve Henson_

- New functions to retrieve certificate signature and signature
  OID NID.

  _Steve Henson_

- Add functions to retrieve and manipulate the raw cipherlist sent by a
  client to OpenSSL.

  _Steve Henson_

- New Suite B modes for TLS code. These use and enforce the requirements
  of RFC6460: restrict ciphersuites, only permit Suite B algorithms and
  only use Suite B curves. The Suite B modes can be set by using the
  strings "SUITEB128", "SUITEB192" or "SUITEB128ONLY" for the cipherstring.

  _Steve Henson_

- New chain verification flags for Suite B levels of security. Check
  algorithms are acceptable when flags are set in X509_verify_cert.

  _Steve Henson_

- Make tls1_check_chain return a set of flags indicating checks passed
  by a certificate chain. Add additional tests to handle client
  certificates: checks for matching certificate type and issuer name
  comparison.

  _Steve Henson_

- If an attempt is made to use a signature algorithm not in the peer
  preference list abort the handshake. If client has no suitable
  signature algorithms in response to a certificate request do not
  use the certificate.

  _Steve Henson_

- If server EC tmp key is not in client preference list abort handshake.

  _Steve Henson_

- Add support for certificate stores in CERT structure. This makes it
  possible to have different stores per SSL structure or one store in
  the parent SSL_CTX. Include distinct stores for certificate chain
  verification and chain building. New ctrl SSL_CTRL_BUILD_CERT_CHAIN
  to build and store a certificate chain in CERT structure: returning
  an error if the chain cannot be built: this will allow applications
  to test if a chain is correctly configured.

  Note: if the CERT based stores are not set then the parent SSL_CTX
  store is used to retain compatibility with existing behaviour.

  _Steve Henson_

- New function ssl_set_client_disabled to set a ciphersuite disabled
  mask based on the current session, check mask when sending client
  hello and checking the requested ciphersuite.

  _Steve Henson_

- New ctrls to retrieve and set certificate types in a certificate
  request message. Print out received values in s_client. If certificate
  types is not set with custom values set sensible values based on
  supported signature algorithms.

  _Steve Henson_

- Support for distinct client and server supported signature algorithms.

  _Steve Henson_

- Add certificate callback. If set this is called whenever a certificate
  is required by client or server. An application can decide which
  certificate chain to present based on arbitrary criteria: for example
  supported signature algorithms. Add very simple example to s_server.
  This fixes many of the problems and restrictions of the existing client
  certificate callback: for example you can now clear an existing
  certificate and specify the whole chain.

  _Steve Henson_

- Add new "valid_flags" field to CERT_PKEY structure which determines what
  the certificate can be used for (if anything). Set valid_flags field
  in new tls1_check_chain function. Simplify ssl_set_cert_masks which used
  to have similar checks in it.

  Add new "cert_flags" field to CERT structure and include a "strict mode".
  This enforces some TLS certificate requirements (such as only permitting
  certificate signature algorithms contained in the supported algorithms
  extension) which some implementations ignore: this option should be used
  with caution as it could cause interoperability issues.

  _Steve Henson_

- Update and tidy signature algorithm extension processing. Work out
  shared signature algorithms based on preferences and peer algorithms
  and print them out in s_client and s_server. Abort handshake if no
  shared signature algorithms.

  _Steve Henson_

- Add new functions to allow customised supported signature algorithms
  for SSL and SSL_CTX structures. Add options to s_client and s_server
  to support them.

  _Steve Henson_

- New function SSL_certs_clear() to delete all references to certificates
  from an SSL structure. Before this once a certificate had been added
  it couldn't be removed.

  _Steve Henson_

- Integrate hostname, email address and IP address checking with certificate
  verification. New verify options supporting checking in openssl utility.

  _Steve Henson_

- Fixes and wildcard matching support to hostname and email checking
  functions. Add manual page.

  _Florian Weimer (Red Hat Product Security Team)_

- New functions to check a hostname email or IP address against a
  certificate. Add options x509 utility to print results of checks against
  a certificate.

  _Steve Henson_

- Fix OCSP checking.

  _Rob Stradling <rob.stradling@comodo.com> and Ben Laurie_

- Initial experimental support for explicitly trusted non-root CAs.
  OpenSSL still tries to build a complete chain to a root but if an
  intermediate CA has a trust setting included that is used. The first
  setting is used: whether to trust (e.g., -addtrust option to the x509
  utility) or reject.

  _Steve Henson_

- Add -trusted_first option which attempts to find certificates in the
  trusted store even if an untrusted chain is also supplied.

  _Steve Henson_

- MIPS assembly pack updates: support for MIPS32r2 and SmartMIPS ASE,
  platform support for Linux and Android.

  _Andy Polyakov_

- Support for linux-x32, ILP32 environment in x86_64 framework.

  _Andy Polyakov_

- Experimental multi-implementation support for FIPS capable OpenSSL.
  When in FIPS mode the approved implementations are used as normal,
  when not in FIPS mode the internal unapproved versions are used instead.
  This means that the FIPS capable OpenSSL isn't forced to use the
  (often lower performance) FIPS implementations outside FIPS mode.

  _Steve Henson_

- Transparently support X9.42 DH parameters when calling
  PEM_read_bio_DHparameters. This means existing applications can handle
  the new parameter format automatically.

  _Steve Henson_

- Initial experimental support for X9.42 DH parameter format: mainly
  to support use of 'q' parameter for RFC5114 parameters.

  _Steve Henson_

- Add DH parameters from RFC5114 including test data to dhtest.

  _Steve Henson_

- Support for automatic EC temporary key parameter selection. If enabled
  the most preferred EC parameters are automatically used instead of
  hardcoded fixed parameters. Now a server just has to call:
  SSL_CTX_set_ecdh_auto(ctx, 1) and the server will automatically
  support ECDH and use the most appropriate parameters.

  _Steve Henson_

- Enhance and tidy EC curve and point format TLS extension code. Use
  static structures instead of allocation if default values are used.
  New ctrls to set curves we wish to support and to retrieve shared curves.
  Print out shared curves in s_server. New options to s_server and s_client
  to set list of supported curves.

  _Steve Henson_

- New ctrls to retrieve supported signature algorithms and
  supported curve values as an array of NIDs. Extend openssl utility
  to print out received values.

  _Steve Henson_

- Add new APIs EC_curve_nist2nid and EC_curve_nid2nist which convert
  between NIDs and the more common NIST names such as "P-256". Enhance
  ecparam utility and ECC method to recognise the NIST names for curves.

  _Steve Henson_

- Enhance SSL/TLS certificate chain handling to support different
  chains for each certificate instead of one chain in the parent SSL_CTX.

  _Steve Henson_

- Support for fixed DH ciphersuite client authentication: where both
  server and client use DH certificates with common parameters.

  _Steve Henson_

- Support for fixed DH ciphersuites: those requiring DH server
  certificates.

  _Steve Henson_

- New function i2d_re_X509_tbs for re-encoding the TBS portion of
  the certificate.
  Note: Related 1.0.2-beta specific macros X509_get_cert_info,
  X509_CINF_set_modified, X509_CINF_get_issuer, X509_CINF_get_extensions and
  X509_CINF_get_signature were reverted post internal team review.

## OpenSSL 1.0.1

### Changes between 1.0.1t and 1.0.1u [22 Sep 2016]

- OCSP Status Request extension unbounded memory growth

  A malicious client can send an excessively large OCSP Status Request
  extension. If that client continually requests renegotiation, sending a
  large OCSP Status Request extension each time, then there will be unbounded
  memory growth on the server. This will eventually lead to a Denial Of
  Service attack through memory exhaustion. Servers with a default
  configuration are vulnerable even if they do not support OCSP. Builds using
  the "no-ocsp" build time option are not affected.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6304])

  _Matt Caswell_

- In order to mitigate the SWEET32 attack, the DES ciphers were moved from
  HIGH to MEDIUM.

  This issue was reported to OpenSSL Karthikeyan Bhargavan and Gaetan
  Leurent (INRIA)
  ([CVE-2016-2183])

  _Rich Salz_

- OOB write in MDC2_Update()

  An overflow can occur in MDC2_Update() either if called directly or
  through the EVP_DigestUpdate() function using MDC2. If an attacker
  is able to supply very large amounts of input data after a previous
  call to EVP_EncryptUpdate() with a partial block then a length check
  can overflow resulting in a heap corruption.

  The amount of data needed is comparable to SIZE_MAX which is impractical
  on most platforms.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6303])

  _Stephen Henson_

- Malformed SHA512 ticket DoS

  If a server uses SHA512 for TLS session ticket HMAC it is vulnerable to a
  DoS attack where a malformed ticket will result in an OOB read which will
  ultimately crash.

  The use of SHA512 in TLS session tickets is comparatively rare as it requires
  a custom server callback and ticket lookup mechanism.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6302])

  _Stephen Henson_

- OOB write in BN_bn2dec()

  The function BN_bn2dec() does not check the return value of BN_div_word().
  This can cause an OOB write if an application uses this function with an
  overly large BIGNUM. This could be a problem if an overly large certificate
  or CRL is printed out from an untrusted source. TLS is not affected because
  record limits will reject an oversized certificate before it is parsed.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-2182])

  _Stephen Henson_

- OOB read in TS_OBJ_print_bio()

  The function TS_OBJ_print_bio() misuses OBJ_obj2txt(): the return value is
  the total length the OID text representation would use and not the amount
  of data written. This will result in OOB reads when large OIDs are
  presented.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-2180])

  _Stephen Henson_

- Pointer arithmetic undefined behaviour

  Avoid some undefined pointer arithmetic

  A common idiom in the codebase is to check limits in the following manner:
  "p + len > limit"

  Where "p" points to some malloc'd data of SIZE bytes and
  limit == p + SIZE

  "len" here could be from some externally supplied data (e.g. from a TLS
  message).

  The rules of C pointer arithmetic are such that "p + len" is only well
  defined where len <= SIZE. Therefore, the above idiom is actually
  undefined behaviour.

  For example this could cause problems if some malloc implementation
  provides an address for "p" such that "p + len" actually overflows for
  values of len that are too big and therefore p + len < limit.

  This issue was reported to OpenSSL by Guido Vranken
  ([CVE-2016-2177])

  _Matt Caswell_

- Constant time flag not preserved in DSA signing

  Operations in the DSA signing algorithm should run in constant time in
  order to avoid side channel attacks. A flaw in the OpenSSL DSA
  implementation means that a non-constant time codepath is followed for
  certain operations. This has been demonstrated through a cache-timing
  attack to be sufficient for an attacker to recover the private DSA key.

  This issue was reported by César Pereida (Aalto University), Billy Brumley
  (Tampere University of Technology), and Yuval Yarom (The University of
  Adelaide and NICTA).
  ([CVE-2016-2178])

  _César Pereida_

- DTLS buffered message DoS

  In a DTLS connection where handshake messages are delivered out-of-order
  those messages that OpenSSL is not yet ready to process will be buffered
  for later use. Under certain circumstances, a flaw in the logic means that
  those messages do not get removed from the buffer even though the handshake
  has been completed. An attacker could force up to approx. 15 messages to
  remain in the buffer when they are no longer required. These messages will
  be cleared when the DTLS connection is closed. The default maximum size for
  a message is 100k. Therefore, the attacker could force an additional 1500k
  to be consumed per connection. By opening many simultaneous connections an
  attacker could cause a DoS attack through memory exhaustion.

  This issue was reported to OpenSSL by Quan Luo.
  ([CVE-2016-2179])

  _Matt Caswell_

- DTLS replay protection DoS

  A flaw in the DTLS replay attack protection mechanism means that records
  that arrive for future epochs update the replay protection "window" before
  the MAC for the record has been validated. This could be exploited by an
  attacker by sending a record for the next epoch (which does not have to
  decrypt or have a valid MAC), with a very large sequence number. This means
  that all subsequent legitimate packets are dropped causing a denial of
  service for a specific DTLS connection.

  This issue was reported to OpenSSL by the OCAP audit team.
  ([CVE-2016-2181])

  _Matt Caswell_

- Certificate message OOB reads

  In OpenSSL 1.0.2 and earlier some missing message length checks can result
  in OOB reads of up to 2 bytes beyond an allocated buffer. There is a
  theoretical DoS risk but this has not been observed in practice on common
  platforms.

  The messages affected are client certificate, client certificate request
  and server certificate. As a result the attack can only be performed
  against a client or a server which enables client authentication.

  This issue was reported to OpenSSL by Shi Lei (Gear Team, Qihoo 360 Inc.)
  ([CVE-2016-6306])

  _Stephen Henson_

### Changes between 1.0.1s and 1.0.1t [3 May 2016]

- Prevent padding oracle in AES-NI CBC MAC check

  A MITM attacker can use a padding oracle attack to decrypt traffic
  when the connection uses an AES CBC cipher and the server support
  AES-NI.

  This issue was introduced as part of the fix for Lucky 13 padding
  attack ([CVE-2013-0169]). The padding check was rewritten to be in
  constant time by making sure that always the same bytes are read and
  compared against either the MAC or padding bytes. But it no longer
  checked that there was enough data to have both the MAC and padding
  bytes.

  This issue was reported by Juraj Somorovsky using TLS-Attacker.
  ([CVE-2016-2107])

  _Kurt Roeckx_

- Fix EVP_EncodeUpdate overflow

  An overflow can occur in the EVP_EncodeUpdate() function which is used for
  Base64 encoding of binary data. If an attacker is able to supply very large
  amounts of input data then a length check can overflow resulting in a heap
  corruption.

  Internally to OpenSSL the EVP_EncodeUpdate() function is primarily used by
  the `PEM_write_bio*` family of functions. These are mainly used within the
  OpenSSL command line applications, so any application which processes data
  from an untrusted source and outputs it as a PEM file should be considered
  vulnerable to this issue. User applications that call these APIs directly
  with large amounts of untrusted data may also be vulnerable.

  This issue was reported by Guido Vranken.
  ([CVE-2016-2105])

  _Matt Caswell_

- Fix EVP_EncryptUpdate overflow

  An overflow can occur in the EVP_EncryptUpdate() function. If an attacker
  is able to supply very large amounts of input data after a previous call to
  EVP_EncryptUpdate() with a partial block then a length check can overflow
  resulting in a heap corruption. Following an analysis of all OpenSSL
  internal usage of the EVP_EncryptUpdate() function all usage is one of two
  forms. The first form is where the EVP_EncryptUpdate() call is known to be
  the first called function after an EVP_EncryptInit(), and therefore that
  specific call must be safe. The second form is where the length passed to
  EVP_EncryptUpdate() can be seen from the code to be some small value and
  therefore there is no possibility of an overflow. Since all instances are
  one of these two forms, it is believed that there can be no overflows in
  internal code due to this problem. It should be noted that
  EVP_DecryptUpdate() can call EVP_EncryptUpdate() in certain code paths.
  Also EVP_CipherUpdate() is a synonym for EVP_EncryptUpdate(). All instances
  of these calls have also been analysed too and it is believed there are no
  instances in internal usage where an overflow could occur.

  This issue was reported by Guido Vranken.
  ([CVE-2016-2106])

  _Matt Caswell_

- Prevent ASN.1 BIO excessive memory allocation

  When ASN.1 data is read from a BIO using functions such as d2i_CMS_bio()
  a short invalid encoding can casuse allocation of large amounts of memory
  potentially consuming excessive resources or exhausting memory.

  Any application parsing untrusted data through d2i BIO functions is
  affected. The memory based functions such as d2i*X509() are \_not* affected.
  Since the memory based functions are used by the TLS library, TLS
  applications are not affected.

  This issue was reported by Brian Carpenter.
  ([CVE-2016-2109])

  _Stephen Henson_

- EBCDIC overread

  ASN1 Strings that are over 1024 bytes can cause an overread in applications
  using the X509_NAME_oneline() function on EBCDIC systems. This could result
  in arbitrary stack data being returned in the buffer.

  This issue was reported by Guido Vranken.
  ([CVE-2016-2176])

  _Matt Caswell_

- Modify behavior of ALPN to invoke callback after SNI/servername
  callback, such that updates to the SSL_CTX affect ALPN.

  _Todd Short_

- Remove LOW from the DEFAULT cipher list. This removes singles DES from the
  default.

  _Kurt Roeckx_

- Only remove the SSLv2 methods with the no-ssl2-method option. When the
  methods are enabled and ssl2 is disabled the methods return NULL.

  _Kurt Roeckx_

### Changes between 1.0.1r and 1.0.1s [1 Mar 2016]

- Disable weak ciphers in SSLv3 and up in default builds of OpenSSL.
  Builds that are not configured with "enable-weak-ssl-ciphers" will not
  provide any "EXPORT" or "LOW" strength ciphers.

  _Viktor Dukhovni_

- Disable SSLv2 default build, default negotiation and weak ciphers. SSLv2
  is by default disabled at build-time. Builds that are not configured with
  "enable-ssl2" will not support SSLv2. Even if "enable-ssl2" is used,
  users who want to negotiate SSLv2 via the version-flexible SSLv23_method()
  will need to explicitly call either of:

      SSL_CTX_clear_options(ctx, SSL_OP_NO_SSLv2);

  or
  SSL_clear_options(ssl, SSL_OP_NO_SSLv2);

  as appropriate. Even if either of those is used, or the application
  explicitly uses the version-specific SSLv2_method() or its client and
  server variants, SSLv2 ciphers vulnerable to exhaustive search key
  recovery have been removed. Specifically, the SSLv2 40-bit EXPORT
  ciphers, and SSLv2 56-bit DES are no longer available.
  ([CVE-2016-0800])

  _Viktor Dukhovni_

- Fix a double-free in DSA code

  A double free bug was discovered when OpenSSL parses malformed DSA private
  keys and could lead to a DoS attack or memory corruption for applications
  that receive DSA private keys from untrusted sources. This scenario is
  considered rare.

  This issue was reported to OpenSSL by Adam Langley(Google/BoringSSL) using
  libFuzzer.
  ([CVE-2016-0705])

  _Stephen Henson_

- Disable SRP fake user seed to address a server memory leak.

  Add a new method SRP_VBASE_get1_by_user that handles the seed properly.

  SRP_VBASE_get_by_user had inconsistent memory management behaviour.
  In order to fix an unavoidable memory leak, SRP_VBASE_get_by_user
  was changed to ignore the "fake user" SRP seed, even if the seed
  is configured.

  Users should use SRP_VBASE_get1_by_user instead. Note that in
  SRP_VBASE_get1_by_user, caller must free the returned value. Note
  also that even though configuring the SRP seed attempts to hide
  invalid usernames by continuing the handshake with fake
  credentials, this behaviour is not constant time and no strong
  guarantees are made that the handshake is indistinguishable from
  that of a valid user.
  ([CVE-2016-0798])

  _Emilia Käsper_

- Fix BN_hex2bn/BN_dec2bn NULL pointer deref/heap corruption

  In the BN_hex2bn function the number of hex digits is calculated using an
  int value `i`. Later `bn_expand` is called with a value of `i * 4`. For
  large values of `i` this can result in `bn_expand` not allocating any
  memory because `i * 4` is negative. This can leave the internal BIGNUM data
  field as NULL leading to a subsequent NULL ptr deref. For very large values
  of `i`, the calculation `i * 4` could be a positive value smaller than `i`.
  In this case memory is allocated to the internal BIGNUM data field, but it
  is insufficiently sized leading to heap corruption. A similar issue exists
  in BN_dec2bn. This could have security consequences if BN_hex2bn/BN_dec2bn
  is ever called by user applications with very large untrusted hex/dec data.
  This is anticipated to be a rare occurrence.

  All OpenSSL internal usage of these functions use data that is not expected
  to be untrusted, e.g. config file data or application command line
  arguments. If user developed applications generate config file data based
  on untrusted data then it is possible that this could also lead to security
  consequences. This is also anticipated to be rare.

  This issue was reported to OpenSSL by Guido Vranken.
  ([CVE-2016-0797])

  _Matt Caswell_

- Fix memory issues in `BIO_*printf` functions

  The internal `fmtstr` function used in processing a "%s" format string in
  the `BIO_*printf` functions could overflow while calculating the length of a
  string and cause an OOB read when printing very long strings.

  Additionally the internal `doapr_outch` function can attempt to write to an
  OOB memory location (at an offset from the NULL pointer) in the event of a
  memory allocation failure. In 1.0.2 and below this could be caused where
  the size of a buffer to be allocated is greater than INT_MAX. E.g. this
  could be in processing a very long "%s" format string. Memory leaks can
  also occur.

  The first issue may mask the second issue dependent on compiler behaviour.
  These problems could enable attacks where large amounts of untrusted data
  is passed to the `BIO_*printf` functions. If applications use these functions
  in this way then they could be vulnerable. OpenSSL itself uses these
  functions when printing out human-readable dumps of ASN.1 data. Therefore
  applications that print this data could be vulnerable if the data is from
  untrusted sources. OpenSSL command line applications could also be
  vulnerable where they print out ASN.1 data, or if untrusted data is passed
  as command line arguments.

  Libssl is not considered directly vulnerable. Additionally certificates etc
  received via remote connections via libssl are also unlikely to be able to
  trigger these issues because of message size limits enforced within libssl.

  This issue was reported to OpenSSL Guido Vranken.
  ([CVE-2016-0799])

  _Matt Caswell_

- Side channel attack on modular exponentiation

  A side-channel attack was found which makes use of cache-bank conflicts on
  the Intel Sandy-Bridge microarchitecture which could lead to the recovery
  of RSA keys. The ability to exploit this issue is limited as it relies on
  an attacker who has control of code in a thread running on the same
  hyper-threaded core as the victim thread which is performing decryptions.

  This issue was reported to OpenSSL by Yuval Yarom, The University of
  Adelaide and NICTA, Daniel Genkin, Technion and Tel Aviv University, and
  Nadia Heninger, University of Pennsylvania with more information at
  <http://cachebleed.info>.
  ([CVE-2016-0702])

  _Andy Polyakov_

- Change the req command to generate a 2048-bit RSA/DSA key by default,
  if no keysize is specified with default_bits. This fixes an
  omission in an earlier change that changed all RSA/DSA key generation
  commands to use 2048 bits by default.

  _Emilia Käsper_

### Changes between 1.0.1q and 1.0.1r [28 Jan 2016]

- Protection for DH small subgroup attacks

  As a precautionary measure the SSL_OP_SINGLE_DH_USE option has been
  switched on by default and cannot be disabled. This could have some
  performance impact.

  _Matt Caswell_

- SSLv2 doesn't block disabled ciphers

  A malicious client can negotiate SSLv2 ciphers that have been disabled on
  the server and complete SSLv2 handshakes even if all SSLv2 ciphers have
  been disabled, provided that the SSLv2 protocol was not also disabled via
  SSL_OP_NO_SSLv2.

  This issue was reported to OpenSSL on 26th December 2015 by Nimrod Aviram
  and Sebastian Schinzel.
  ([CVE-2015-3197])

  _Viktor Dukhovni_

- Reject DH handshakes with parameters shorter than 1024 bits.

  _Kurt Roeckx_

### Changes between 1.0.1p and 1.0.1q [3 Dec 2015]

- Certificate verify crash with missing PSS parameter

  The signature verification routines will crash with a NULL pointer
  dereference if presented with an ASN.1 signature using the RSA PSS
  algorithm and absent mask generation function parameter. Since these
  routines are used to verify certificate signature algorithms this can be
  used to crash any certificate verification operation and exploited in a
  DoS attack. Any application which performs certificate verification is
  vulnerable including OpenSSL clients and servers which enable client
  authentication.

  This issue was reported to OpenSSL by Loïc Jonas Etienne (Qnective AG).
  ([CVE-2015-3194])

  _Stephen Henson_

- X509_ATTRIBUTE memory leak

  When presented with a malformed X509_ATTRIBUTE structure OpenSSL will leak
  memory. This structure is used by the PKCS#7 and CMS routines so any
  application which reads PKCS#7 or CMS data from untrusted sources is
  affected. SSL/TLS is not affected.

  This issue was reported to OpenSSL by Adam Langley (Google/BoringSSL) using
  libFuzzer.
  ([CVE-2015-3195])

  _Stephen Henson_

- Rewrite EVP_DecodeUpdate (base64 decoding) to fix several bugs.
  This changes the decoding behaviour for some invalid messages,
  though the change is mostly in the more lenient direction, and
  legacy behaviour is preserved as much as possible.

  _Emilia Käsper_

- In DSA_generate_parameters_ex, if the provided seed is too short,
  use a random seed, as already documented.

  _Rich Salz and Ismo Puustinen <ismo.puustinen@intel.com>_

### Changes between 1.0.1o and 1.0.1p [9 Jul 2015]

- Alternate chains certificate forgery

  During certificate verification, OpenSSL will attempt to find an
  alternative certificate chain if the first attempt to build such a chain
  fails. An error in the implementation of this logic can mean that an
  attacker could cause certain checks on untrusted certificates to be
  bypassed, such as the CA flag, enabling them to use a valid leaf
  certificate to act as a CA and "issue" an invalid certificate.

  This issue was reported to OpenSSL by Adam Langley/David Benjamin
  (Google/BoringSSL).
  ([CVE-2015-1793])

  _Matt Caswell_

- Race condition handling PSK identify hint

  If PSK identity hints are received by a multi-threaded client then
  the values are wrongly updated in the parent SSL_CTX structure. This can
  result in a race condition potentially leading to a double free of the
  identify hint data.
  ([CVE-2015-3196])

  _Stephen Henson_

### Changes between 1.0.1n and 1.0.1o [12 Jun 2015]

- Fix HMAC ABI incompatibility. The previous version introduced an ABI
  incompatibility in the handling of HMAC. The previous ABI has now been
  restored.

### Changes between 1.0.1m and 1.0.1n [11 Jun 2015]

- Malformed ECParameters causes infinite loop

  When processing an ECParameters structure OpenSSL enters an infinite loop
  if the curve specified is over a specially malformed binary polynomial
  field.

  This can be used to perform denial of service against any
  system which processes public keys, certificate requests or
  certificates. This includes TLS clients and TLS servers with
  client authentication enabled.

  This issue was reported to OpenSSL by Joseph Barr-Pixton.
  ([CVE-2015-1788])

  _Andy Polyakov_

- Exploitable out-of-bounds read in X509_cmp_time

  X509_cmp_time does not properly check the length of the ASN1_TIME
  string and can read a few bytes out of bounds. In addition,
  X509_cmp_time accepts an arbitrary number of fractional seconds in the
  time string.

  An attacker can use this to craft malformed certificates and CRLs of
  various sizes and potentially cause a segmentation fault, resulting in
  a DoS on applications that verify certificates or CRLs. TLS clients
  that verify CRLs are affected. TLS clients and servers with client
  authentication enabled may be affected if they use custom verification
  callbacks.

  This issue was reported to OpenSSL by Robert Swiecki (Google), and
  independently by Hanno Böck.
  ([CVE-2015-1789])

  _Emilia Käsper_

- PKCS7 crash with missing EnvelopedContent

  The PKCS#7 parsing code does not handle missing inner EncryptedContent
  correctly. An attacker can craft malformed ASN.1-encoded PKCS#7 blobs
  with missing content and trigger a NULL pointer dereference on parsing.

  Applications that decrypt PKCS#7 data or otherwise parse PKCS#7
  structures from untrusted sources are affected. OpenSSL clients and
  servers are not affected.

  This issue was reported to OpenSSL by Michal Zalewski (Google).
  ([CVE-2015-1790])

  _Emilia Käsper_

- CMS verify infinite loop with unknown hash function

  When verifying a signedData message the CMS code can enter an infinite loop
  if presented with an unknown hash function OID. This can be used to perform
  denial of service against any system which verifies signedData messages using
  the CMS code.
  This issue was reported to OpenSSL by Johannes Bauer.
  ([CVE-2015-1792])

  _Stephen Henson_

- Race condition handling NewSessionTicket

  If a NewSessionTicket is received by a multi-threaded client when attempting to
  reuse a previous ticket then a race condition can occur potentially leading to
  a double free of the ticket data.
  ([CVE-2015-1791])

  _Matt Caswell_

- Reject DH handshakes with parameters shorter than 768 bits.

  _Kurt Roeckx and Emilia Kasper_

- dhparam: generate 2048-bit parameters by default.

  _Kurt Roeckx and Emilia Kasper_

### Changes between 1.0.1l and 1.0.1m [19 Mar 2015]

- Segmentation fault in ASN1_TYPE_cmp fix

  The function ASN1_TYPE_cmp will crash with an invalid read if an attempt is
  made to compare ASN.1 boolean types. Since ASN1_TYPE_cmp is used to check
  certificate signature algorithm consistency this can be used to crash any
  certificate verification operation and exploited in a DoS attack. Any
  application which performs certificate verification is vulnerable including
  OpenSSL clients and servers which enable client authentication.
  ([CVE-2015-0286])

  _Stephen Henson_

- ASN.1 structure reuse memory corruption fix

  Reusing a structure in ASN.1 parsing may allow an attacker to cause
  memory corruption via an invalid write. Such reuse is and has been
  strongly discouraged and is believed to be rare.

  Applications that parse structures containing CHOICE or ANY DEFINED BY
  components may be affected. Certificate parsing (d2i_X509 and related
  functions) are however not affected. OpenSSL clients and servers are
  not affected.
  ([CVE-2015-0287])

  _Stephen Henson_

- PKCS7 NULL pointer dereferences fix

  The PKCS#7 parsing code does not handle missing outer ContentInfo
  correctly. An attacker can craft malformed ASN.1-encoded PKCS#7 blobs with
  missing content and trigger a NULL pointer dereference on parsing.

  Applications that verify PKCS#7 signatures, decrypt PKCS#7 data or
  otherwise parse PKCS#7 structures from untrusted sources are
  affected. OpenSSL clients and servers are not affected.

  This issue was reported to OpenSSL by Michal Zalewski (Google).
  ([CVE-2015-0289])

  _Emilia Käsper_

- DoS via reachable assert in SSLv2 servers fix

  A malicious client can trigger an OPENSSL_assert (i.e., an abort) in
  servers that both support SSLv2 and enable export cipher suites by sending
  a specially crafted SSLv2 CLIENT-MASTER-KEY message.

  This issue was discovered by Sean Burford (Google) and Emilia Käsper
  (OpenSSL development team).
  ([CVE-2015-0293])

  _Emilia Käsper_

- Use After Free following d2i_ECPrivatekey error fix

  A malformed EC private key file consumed via the d2i_ECPrivateKey function
  could cause a use after free condition. This, in turn, could cause a double
  free in several private key parsing functions (such as d2i_PrivateKey
  or EVP_PKCS82PKEY) and could lead to a DoS attack or memory corruption
  for applications that receive EC private keys from untrusted
  sources. This scenario is considered rare.

  This issue was discovered by the BoringSSL project and fixed in their
  commit 517073cd4b.
  ([CVE-2015-0209])

  _Matt Caswell_

- X509_to_X509_REQ NULL pointer deref fix

  The function X509_to_X509_REQ will crash with a NULL pointer dereference if
  the certificate key is invalid. This function is rarely used in practice.

  This issue was discovered by Brian Carpenter.
  ([CVE-2015-0288])

  _Stephen Henson_

- Removed the export ciphers from the DEFAULT ciphers

  _Kurt Roeckx_

### Changes between 1.0.1k and 1.0.1l [15 Jan 2015]

- Build fixes for the Windows and OpenVMS platforms

  _Matt Caswell and Richard Levitte_

### Changes between 1.0.1j and 1.0.1k [8 Jan 2015]

- Fix DTLS segmentation fault in dtls1_get_record. A carefully crafted DTLS
  message can cause a segmentation fault in OpenSSL due to a NULL pointer
  dereference. This could lead to a Denial Of Service attack. Thanks to
  Markus Stenberg of Cisco Systems, Inc. for reporting this issue.
  ([CVE-2014-3571])

  _Steve Henson_

- Fix DTLS memory leak in dtls1_buffer_record. A memory leak can occur in the
  dtls1_buffer_record function under certain conditions. In particular this
  could occur if an attacker sent repeated DTLS records with the same
  sequence number but for the next epoch. The memory leak could be exploited
  by an attacker in a Denial of Service attack through memory exhaustion.
  Thanks to Chris Mueller for reporting this issue.
  ([CVE-2015-0206])

  _Matt Caswell_

- Fix issue where no-ssl3 configuration sets method to NULL. When openssl is
  built with the no-ssl3 option and an SSL v3 ClientHello is received the ssl
  method would be set to NULL which could later result in a NULL pointer
  dereference. Thanks to Frank Schmirler for reporting this issue.
  ([CVE-2014-3569])

  _Kurt Roeckx_

- Abort handshake if server key exchange message is omitted for ephemeral
  ECDH ciphersuites.

  Thanks to Karthikeyan Bhargavan of the PROSECCO team at INRIA for
  reporting this issue.
  ([CVE-2014-3572])

  _Steve Henson_

- Remove non-export ephemeral RSA code on client and server. This code
  violated the TLS standard by allowing the use of temporary RSA keys in
  non-export ciphersuites and could be used by a server to effectively
  downgrade the RSA key length used to a value smaller than the server
  certificate. Thanks for Karthikeyan Bhargavan of the PROSECCO team at
  INRIA or reporting this issue.
  ([CVE-2015-0204])

  _Steve Henson_

- Fixed issue where DH client certificates are accepted without verification.
  An OpenSSL server will accept a DH certificate for client authentication
  without the certificate verify message. This effectively allows a client to
  authenticate without the use of a private key. This only affects servers
  which trust a client certificate authority which issues certificates
  containing DH keys: these are extremely rare and hardly ever encountered.
  Thanks for Karthikeyan Bhargavan of the PROSECCO team at INRIA or reporting
  this issue.
  ([CVE-2015-0205])

  _Steve Henson_

- Ensure that the session ID context of an SSL is updated when its
  SSL_CTX is updated via SSL_set_SSL_CTX.

  The session ID context is typically set from the parent SSL_CTX,
  and can vary with the CTX.

  _Adam Langley_

- Fix various certificate fingerprint issues.

  By using non-DER or invalid encodings outside the signed portion of a
  certificate the fingerprint can be changed without breaking the signature.
  Although no details of the signed portion of the certificate can be changed
  this can cause problems with some applications: e.g. those using the
  certificate fingerprint for blacklists.
  1.  Reject signatures with non zero unused bits.

  If the BIT STRING containing the signature has non zero unused bits reject
  the signature. All current signature algorithms require zero unused bits. 2. Check certificate algorithm consistency.

  Check the AlgorithmIdentifier inside TBS matches the one in the
  certificate signature. NB: this will result in signature failure
  errors for some broken certificates.

  Thanks to Konrad Kraszewski from Google for reporting this issue. 3. Check DSA/ECDSA signatures use DER.

  Re-encode DSA/ECDSA signatures and compare with the original received
  signature. Return an error if there is a mismatch.

  This will reject various cases including garbage after signature
  (thanks to Antti Karjalainen and Tuomo Untinen from the Codenomicon CROSS
  program for discovering this case) and use of BER or invalid ASN.1 INTEGERs
  (negative or with leading zeroes).

  Further analysis was conducted and fixes were developed by Stephen Henson
  of the OpenSSL core team.

  ([CVE-2014-8275])

  _Steve Henson_

- Correct Bignum squaring. Bignum squaring (BN_sqr) may produce incorrect
  results on some platforms, including x86_64. This bug occurs at random
  with a very low probability, and is not known to be exploitable in any
  way, though its exact impact is difficult to determine. Thanks to Pieter
  Wuille (Blockstream) who reported this issue and also suggested an initial
  fix. Further analysis was conducted by the OpenSSL development team and
  Adam Langley of Google. The final fix was developed by Andy Polyakov of
  the OpenSSL core team.
  ([CVE-2014-3570])

  _Andy Polyakov_

- Do not resume sessions on the server if the negotiated protocol
  version does not match the session's version. Resuming with a different
  version, while not strictly forbidden by the RFC, is of questionable
  sanity and breaks all known clients.

  _David Benjamin, Emilia Käsper_

- Tighten handling of the ChangeCipherSpec (CCS) message: reject
  early CCS messages during renegotiation. (Note that because
  renegotiation is encrypted, this early CCS was not exploitable.)

  _Emilia Käsper_

- Tighten client-side session ticket handling during renegotiation:
  ensure that the client only accepts a session ticket if the server sends
  the extension anew in the ServerHello. Previously, a TLS client would
  reuse the old extension state and thus accept a session ticket if one was
  announced in the initial ServerHello.

  Similarly, ensure that the client requires a session ticket if one
  was advertised in the ServerHello. Previously, a TLS client would
  ignore a missing NewSessionTicket message.

  _Emilia Käsper_

### Changes between 1.0.1i and 1.0.1j [15 Oct 2014]

- SRTP Memory Leak.

  A flaw in the DTLS SRTP extension parsing code allows an attacker, who
  sends a carefully crafted handshake message, to cause OpenSSL to fail
  to free up to 64k of memory causing a memory leak. This could be
  exploited in a Denial Of Service attack. This issue affects OpenSSL
  1.0.1 server implementations for both SSL/TLS and DTLS regardless of
  whether SRTP is used or configured. Implementations of OpenSSL that
  have been compiled with OPENSSL_NO_SRTP defined are not affected.

  The fix was developed by the OpenSSL team.
  ([CVE-2014-3513])

  _OpenSSL team_

- Session Ticket Memory Leak.

  When an OpenSSL SSL/TLS/DTLS server receives a session ticket the
  integrity of that ticket is first verified. In the event of a session
  ticket integrity check failing, OpenSSL will fail to free memory
  causing a memory leak. By sending a large number of invalid session
  tickets an attacker could exploit this issue in a Denial Of Service
  attack.
  ([CVE-2014-3567])

  _Steve Henson_

- Build option no-ssl3 is incomplete.

  When OpenSSL is configured with "no-ssl3" as a build option, servers
  could accept and complete an SSL 3.0 handshake, and clients could be
  configured to send them.
  ([CVE-2014-3568])

  _Akamai and the OpenSSL team_

- Add support for TLS_FALLBACK_SCSV.
  Client applications doing fallback retries should call
  SSL_set_mode(s, SSL_MODE_SEND_FALLBACK_SCSV).
  ([CVE-2014-3566])

  _Adam Langley, Bodo Moeller_

- Add additional DigestInfo checks.

  Re-encode DigestInto in DER and check against the original when
  verifying RSA signature: this will reject any improperly encoded
  DigestInfo structures.

  Note: this is a precautionary measure and no attacks are currently known.

  _Steve Henson_

### Changes between 1.0.1h and 1.0.1i [6 Aug 2014]

- Fix SRP buffer overrun vulnerability. Invalid parameters passed to the
  SRP code can be overrun an internal buffer. Add sanity check that
  g, A, B < N to SRP code.

  Thanks to Sean Devlin and Watson Ladd of Cryptography Services, NCC
  Group for discovering this issue.
  ([CVE-2014-3512])

  _Steve Henson_

- A flaw in the OpenSSL SSL/TLS server code causes the server to negotiate
  TLS 1.0 instead of higher protocol versions when the ClientHello message
  is badly fragmented. This allows a man-in-the-middle attacker to force a
  downgrade to TLS 1.0 even if both the server and the client support a
  higher protocol version, by modifying the client's TLS records.

  Thanks to David Benjamin and Adam Langley (Google) for discovering and
  researching this issue.
  ([CVE-2014-3511])

  _David Benjamin_

- OpenSSL DTLS clients enabling anonymous (EC)DH ciphersuites are subject
  to a denial of service attack. A malicious server can crash the client
  with a null pointer dereference (read) by specifying an anonymous (EC)DH
  ciphersuite and sending carefully crafted handshake messages.

  Thanks to Felix Gröbert (Google) for discovering and researching this
  issue.
  ([CVE-2014-3510])

  _Emilia Käsper_

- By sending carefully crafted DTLS packets an attacker could cause openssl
  to leak memory. This can be exploited through a Denial of Service attack.
  Thanks to Adam Langley for discovering and researching this issue.
  ([CVE-2014-3507])

  _Adam Langley_

- An attacker can force openssl to consume large amounts of memory whilst
  processing DTLS handshake messages. This can be exploited through a
  Denial of Service attack.
  Thanks to Adam Langley for discovering and researching this issue.
  ([CVE-2014-3506])

  _Adam Langley_

- An attacker can force an error condition which causes openssl to crash
  whilst processing DTLS packets due to memory being freed twice. This
  can be exploited through a Denial of Service attack.
  Thanks to Adam Langley and Wan-Teh Chang for discovering and researching
  this issue.
  ([CVE-2014-3505])

  _Adam Langley_

- If a multithreaded client connects to a malicious server using a resumed
  session and the server sends an ec point format extension it could write
  up to 255 bytes to freed memory.

  Thanks to Gabor Tyukasz (LogMeIn Inc) for discovering and researching this
  issue.
  ([CVE-2014-3509])

  _Gabor Tyukasz_

- A malicious server can crash an OpenSSL client with a null pointer
  dereference (read) by specifying an SRP ciphersuite even though it was not
  properly negotiated with the client. This can be exploited through a
  Denial of Service attack.

  Thanks to Joonas Kuorilehto and Riku Hietamäki (Codenomicon) for
  discovering and researching this issue.
  ([CVE-2014-5139])

  _Steve Henson_

- A flaw in OBJ_obj2txt may cause pretty printing functions such as
  X509_name_oneline, X509_name_print_ex et al. to leak some information
  from the stack. Applications may be affected if they echo pretty printing
  output to the attacker.

  Thanks to Ivan Fratric (Google) for discovering this issue.
  ([CVE-2014-3508])

  _Emilia Käsper, and Steve Henson_

- Fix ec_GFp_simple_points_make_affine (thus, EC_POINTs_mul etc.)
  for corner cases. (Certain input points at infinity could lead to
  bogus results, with non-infinity inputs mapped to infinity too.)

  _Bodo Moeller_

### Changes between 1.0.1g and 1.0.1h [5 Jun 2014]

- Fix for SSL/TLS MITM flaw. An attacker using a carefully crafted
  handshake can force the use of weak keying material in OpenSSL
  SSL/TLS clients and servers.

  Thanks to KIKUCHI Masashi (Lepidum Co. Ltd.) for discovering and
  researching this issue. ([CVE-2014-0224])

  _KIKUCHI Masashi, Steve Henson_

- Fix DTLS recursion flaw. By sending an invalid DTLS handshake to an
  OpenSSL DTLS client the code can be made to recurse eventually crashing
  in a DoS attack.

  Thanks to Imre Rad (Search-Lab Ltd.) for discovering this issue.
  ([CVE-2014-0221])

  _Imre Rad, Steve Henson_

- Fix DTLS invalid fragment vulnerability. A buffer overrun attack can
  be triggered by sending invalid DTLS fragments to an OpenSSL DTLS
  client or server. This is potentially exploitable to run arbitrary
  code on a vulnerable client or server.

  Thanks to Jüri Aedla for reporting this issue. ([CVE-2014-0195])

  _Jüri Aedla, Steve Henson_

- Fix bug in TLS code where clients enable anonymous ECDH ciphersuites
  are subject to a denial of service attack.

  Thanks to Felix Gröbert and Ivan Fratric at Google for discovering
  this issue. ([CVE-2014-3470])

  _Felix Gröbert, Ivan Fratric, Steve Henson_

- Harmonize version and its documentation. -f flag is used to display
  compilation flags.

  _mancha <mancha1@zoho.com>_

- Fix eckey_priv_encode so it immediately returns an error upon a failure
  in i2d_ECPrivateKey.

  _mancha <mancha1@zoho.com>_

- Fix some double frees. These are not thought to be exploitable.

  _mancha <mancha1@zoho.com>_

### Changes between 1.0.1f and 1.0.1g [7 Apr 2014]

- A missing bounds check in the handling of the TLS heartbeat extension
  can be used to reveal up to 64k of memory to a connected client or
  server.

  Thanks for Neel Mehta of Google Security for discovering this bug and to
  Adam Langley <agl@chromium.org> and Bodo Moeller <bmoeller@acm.org> for
  preparing the fix ([CVE-2014-0160])

  _Adam Langley, Bodo Moeller_

- Fix for the attack described in the paper "Recovering OpenSSL
  ECDSA Nonces Using the FLUSH+RELOAD Cache Side-channel Attack"
  by Yuval Yarom and Naomi Benger. Details can be obtained from:
  <http://eprint.iacr.org/2014/140>

  Thanks to Yuval Yarom and Naomi Benger for discovering this
  flaw and to Yuval Yarom for supplying a fix ([CVE-2014-0076])

  _Yuval Yarom and Naomi Benger_

- TLS pad extension: draft-agl-tls-padding-03

  Workaround for the "TLS hang bug" (see FAQ and PR#2771): if the
  TLS client Hello record length value would otherwise be > 255 and
  less that 512 pad with a dummy extension containing zeroes so it
  is at least 512 bytes long.

  _Adam Langley, Steve Henson_

### Changes between 1.0.1e and 1.0.1f [6 Jan 2014]

- Fix for TLS record tampering bug. A carefully crafted invalid
  handshake could crash OpenSSL with a NULL pointer exception.
  Thanks to Anton Johansson for reporting this issues.
  ([CVE-2013-4353])

- Keep original DTLS digest and encryption contexts in retransmission
  structures so we can use the previous session parameters if they need
  to be resent. ([CVE-2013-6450])

  _Steve Henson_

- Add option SSL_OP_SAFARI_ECDHE_ECDSA_BUG (part of SSL_OP_ALL) which
  avoids preferring ECDHE-ECDSA ciphers when the client appears to be
  Safari on OS X. Safari on OS X 10.8..10.8.3 advertises support for
  several ECDHE-ECDSA ciphers, but fails to negotiate them. The bug
  is fixed in OS X 10.8.4, but Apple have ruled out both hot fixing
  10.8..10.8.3 and forcing users to upgrade to 10.8.4 or newer.

  _Rob Stradling, Adam Langley_

### Changes between 1.0.1d and 1.0.1e [11 Feb 2013]

- Correct fix for CVE-2013-0169. The original didn't work on AES-NI
  supporting platforms or when small records were transferred.

  _Andy Polyakov, Steve Henson_

### Changes between 1.0.1c and 1.0.1d [5 Feb 2013]

- Make the decoding of SSLv3, TLS and DTLS CBC records constant time.

  This addresses the flaw in CBC record processing discovered by
  Nadhem Alfardan and Kenny Paterson. Details of this attack can be found
  at: <http://www.isg.rhul.ac.uk/tls/>

  Thanks go to Nadhem Alfardan and Kenny Paterson of the Information
  Security Group at Royal Holloway, University of London
  (www.isg.rhul.ac.uk) for discovering this flaw and Adam Langley and
  Emilia Käsper for the initial patch.
  ([CVE-2013-0169])

  _Emilia Käsper, Adam Langley, Ben Laurie, Andy Polyakov, Steve Henson_

- Fix flaw in AESNI handling of TLS 1.2 and 1.1 records for CBC mode
  ciphersuites which can be exploited in a denial of service attack.
  Thanks go to and to Adam Langley <agl@chromium.org> for discovering
  and detecting this bug and to Wolfgang Ettlinger
  <wolfgang.ettlinger@gmail.com> for independently discovering this issue.
  ([CVE-2012-2686])

  _Adam Langley_

- Return an error when checking OCSP signatures when key is NULL.
  This fixes a DoS attack. ([CVE-2013-0166])

  _Steve Henson_

- Make openssl verify return errors.

  _Chris Palmer <palmer@google.com> and Ben Laurie_

- Call OCSP Stapling callback after ciphersuite has been chosen, so
  the right response is stapled. Also change SSL_get_certificate()
  so it returns the certificate actually sent.
  See <http://rt.openssl.org/Ticket/Display.html?id=2836>.

  _Rob Stradling <rob.stradling@comodo.com>_

- Fix possible deadlock when decoding public keys.

  _Steve Henson_

- Don't use TLS 1.0 record version number in initial client hello
  if renegotiating.

  _Steve Henson_

### Changes between 1.0.1b and 1.0.1c [10 May 2012]

- Sanity check record length before skipping explicit IV in TLS
  1.2, 1.1 and DTLS to fix DoS attack.

  Thanks to Codenomicon for discovering this issue using Fuzz-o-Matic
  fuzzing as a service testing platform.
  ([CVE-2012-2333])

  _Steve Henson_

- Initialise tkeylen properly when encrypting CMS messages.
  Thanks to Solar Designer of Openwall for reporting this issue.

  _Steve Henson_

- In FIPS mode don't try to use composite ciphers as they are not
  approved.

  _Steve Henson_

### Changes between 1.0.1a and 1.0.1b [26 Apr 2012]

- OpenSSL 1.0.0 sets SSL_OP_ALL to 0x80000FFFL and OpenSSL 1.0.1 and
  1.0.1a set SSL_OP_NO_TLSv1_1 to 0x00000400L which would unfortunately
  mean any application compiled against OpenSSL 1.0.0 headers setting
  SSL_OP_ALL would also set SSL_OP_NO_TLSv1_1, unintentionally disabling
  TLS 1.1 also. Fix this by changing the value of SSL_OP_NO_TLSv1_1 to
  0x10000000L Any application which was previously compiled against
  OpenSSL 1.0.1 or 1.0.1a headers and which cares about SSL_OP_NO_TLSv1_1
  will need to be recompiled as a result. Letting be results in
  inability to disable specifically TLS 1.1 and in client context,
  in unlike event, limit maximum offered version to TLS 1.0 [see below].

  _Steve Henson_

- In order to ensure interoperability SSL*OP_NO_protocolX does not
  disable just protocol X, but all protocols above X \_if* there are
  protocols _below_ X still enabled. In more practical terms it means
  that if application wants to disable TLS1.0 in favor of TLS1.1 and
  above, it's not sufficient to pass `SSL_OP_NO_TLSv1`, one has to pass
  `SSL_OP_NO_TLSv1|SSL_OP_NO_SSLv3|SSL_OP_NO_SSLv2`. This applies to
  client side.

  _Andy Polyakov_

### Changes between 1.0.1 and 1.0.1a [19 Apr 2012]

- Check for potentially exploitable overflows in asn1_d2i_read_bio
  BUF_mem_grow and BUF_mem_grow_clean. Refuse attempts to shrink buffer
  in CRYPTO_realloc_clean.

  Thanks to Tavis Ormandy, Google Security Team, for discovering this
  issue and to Adam Langley <agl@chromium.org> for fixing it.
  ([CVE-2012-2110])

  _Adam Langley (Google), Tavis Ormandy, Google Security Team_

- Don't allow TLS 1.2 SHA-256 ciphersuites in TLS 1.0, 1.1 connections.

  _Adam Langley_

- Workarounds for some broken servers that "hang" if a client hello
  record length exceeds 255 bytes.
  1.  Do not use record version number > TLS 1.0 in initial client
      hello: some (but not all) hanging servers will now work.
  2.  If we set OPENSSL_MAX_TLS1_2_CIPHER_LENGTH this will truncate
      the number of ciphers sent in the client hello. This should be
      set to an even number, such as 50, for example by passing:
      -DOPENSSL_MAX_TLS1_2_CIPHER_LENGTH=50 to config or Configure.
      Most broken servers should now work.
  3.  If all else fails setting OPENSSL_NO_TLS1_2_CLIENT will disable
      TLS 1.2 client support entirely.

  _Steve Henson_

- Fix SEGV in Vector Permutation AES module observed in OpenSSH.

  _Andy Polyakov_

### Changes between 1.0.0h and 1.0.1 [14 Mar 2012]

- Add compatibility with old MDC2 signatures which use an ASN1 OCTET
  STRING form instead of a DigestInfo.

  _Steve Henson_

- The format used for MDC2 RSA signatures is inconsistent between EVP
  and the RSA_sign/RSA_verify functions. This was made more apparent when
  OpenSSL used RSA_sign/RSA_verify for some RSA signatures in particular
  those which went through EVP_PKEY_METHOD in 1.0.0 and later. Detect
  the correct format in RSA_verify so both forms transparently work.

  _Steve Henson_

- Some servers which support TLS 1.0 can choke if we initially indicate
  support for TLS 1.2 and later renegotiate using TLS 1.0 in the RSA
  encrypted premaster secret. As a workaround use the maximum permitted
  client version in client hello, this should keep such servers happy
  and still work with previous versions of OpenSSL.

  _Steve Henson_

- Add support for TLS/DTLS heartbeats.

  _Robin Seggelmann <seggelmann@fh-muenster.de>_

- Add support for SCTP.

  _Robin Seggelmann <seggelmann@fh-muenster.de>_

- Improved PRNG seeding for VOS.

  _Paul Green <Paul.Green@stratus.com>_

- Extensive assembler packs updates, most notably:
  - x86[_64]: AES-NI, PCLMULQDQ, RDRAND support;
  - x86[_64]: SSSE3 support (SHA1, vector-permutation AES);
  - x86_64: bit-sliced AES implementation;
  - ARM: NEON support, contemporary platforms optimizations;
  - s390x: z196 support;
  - `*`: GHASH and GF(2^m) multiplication implementations;

  _Andy Polyakov_

- Make TLS-SRP code conformant with RFC 5054 API cleanup
  (removal of unnecessary code)

  _Peter Sylvester <peter.sylvester@edelweb.fr>_

- Add TLS key material exporter from RFC 5705.

  _Eric Rescorla_

- Add DTLS-SRTP negotiation from RFC 5764.

  _Eric Rescorla_

- Add Next Protocol Negotiation,
  <http://tools.ietf.org/html/draft-agl-tls-nextprotoneg-00>. Can be
  disabled with a no-npn flag to config or Configure. Code donated
  by Google.

  _Adam Langley <agl@google.com> and Ben Laurie_

- Add optional 64-bit optimized implementations of elliptic curves NIST-P224,
  NIST-P256, NIST-P521, with constant-time single point multiplication on
  typical inputs. Compiler support for the nonstandard type `__uint128_t` is
  required to use this (present in gcc 4.4 and later, for 64-bit builds).
  Code made available under Apache License version 2.0.

  Specify "enable-ec_nistp_64_gcc_128" on the Configure (or config) command
  line to include this in your build of OpenSSL, and run "make depend" (or
  "make update"). This enables the following EC_METHODs:

          EC_GFp_nistp224_method()
          EC_GFp_nistp256_method()
          EC_GFp_nistp521_method()

  EC_GROUP_new_by_curve_name() will automatically use these (while
  EC_GROUP_new_curve_GFp() currently prefers the more flexible
  implementations).

  _Emilia Käsper, Adam Langley, Bodo Moeller (Google)_

- Use type ossl_ssize_t instead of ssize_t which isn't available on
  all platforms. Move ssize_t definition from e_os.h to the public
  header file e_os2.h as it now appears in public header file cms.h

  _Steve Henson_

- New -sigopt option to the ca, req and x509 utilities. Additional
  signature parameters can be passed using this option and in
  particular PSS.

  _Steve Henson_

- Add RSA PSS signing function. This will generate and set the
  appropriate AlgorithmIdentifiers for PSS based on those in the
  corresponding EVP_MD_CTX structure. No application support yet.

  _Steve Henson_

- Support for companion algorithm specific ASN1 signing routines.
  New function ASN1_item_sign_ctx() signs a pre-initialised
  EVP_MD_CTX structure and sets AlgorithmIdentifiers based on
  the appropriate parameters.

  _Steve Henson_

- Add new algorithm specific ASN1 verification initialisation function
  to EVP_PKEY_ASN1_METHOD: this is not in EVP_PKEY_METHOD since the ASN1
  handling will be the same no matter what EVP_PKEY_METHOD is used.
  Add a PSS handler to support verification of PSS signatures: checked
  against a number of sample certificates.

  _Steve Henson_

- Add signature printing for PSS. Add PSS OIDs.

  _Steve Henson, Martin Kaiser <lists@kaiser.cx>_

- Add algorithm specific signature printing. An individual ASN1 method
  can now print out signatures instead of the standard hex dump.

  More complex signatures (e.g. PSS) can print out more meaningful
  information. Include DSA version that prints out the signature
  parameters r, s.

  _Steve Henson_

- Password based recipient info support for CMS library: implementing
  RFC3211.

  _Steve Henson_

- Split password based encryption into PBES2 and PBKDF2 functions. This
  neatly separates the code into cipher and PBE sections and is required
  for some algorithms that split PBES2 into separate pieces (such as
  password based CMS).

  _Steve Henson_

- Session-handling fixes:
  - Fix handling of connections that are resuming with a session ID,
    but also support Session Tickets.
  - Fix a bug that suppressed issuing of a new ticket if the client
    presented a ticket with an expired session.
  - Try to set the ticket lifetime hint to something reasonable.
  - Make tickets shorter by excluding irrelevant information.
  - On the client side, don't ignore renewed tickets.

  _Adam Langley, Bodo Moeller (Google)_

- Fix PSK session representation.

  _Bodo Moeller_

- Add RC4-MD5 and AESNI-SHA1 "stitched" implementations.

  This work was sponsored by Intel.

  _Andy Polyakov_

- Add GCM support to TLS library. Some custom code is needed to split
  the IV between the fixed (from PRF) and explicit (from TLS record)
  portions. This adds all GCM ciphersuites supported by RFC5288 and
  RFC5289. Generalise some `AES*` cipherstrings to include GCM and
  add a special AESGCM string for GCM only.

  _Steve Henson_

- Expand range of ctrls for AES GCM. Permit setting invocation
  field on decrypt and retrieval of invocation field only on encrypt.

  _Steve Henson_

- Add HMAC ECC ciphersuites from RFC5289. Include SHA384 PRF support.
  As required by RFC5289 these ciphersuites cannot be used if for
  versions of TLS earlier than 1.2.

  _Steve Henson_

- For FIPS capable OpenSSL interpret a NULL default public key method
  as unset and return the appropriate default but do _not_ set the default.
  This means we can return the appropriate method in applications that
  switch between FIPS and non-FIPS modes.

  _Steve Henson_

- Redirect HMAC and CMAC operations to FIPS module in FIPS mode. If an
  ENGINE is used then we cannot handle that in the FIPS module so we
  keep original code iff non-FIPS operations are allowed.

  _Steve Henson_

- Add -attime option to openssl utilities.

  _Peter Eckersley <pde@eff.org>, Ben Laurie and Steve Henson_

- Redirect DSA and DH operations to FIPS module in FIPS mode.

  _Steve Henson_

- Redirect ECDSA and ECDH operations to FIPS module in FIPS mode. Also use
  FIPS EC methods unconditionally for now.

  _Steve Henson_

- New build option no-ec2m to disable characteristic 2 code.

  _Steve Henson_

- Backport libcrypto audit of return value checking from 1.1.0-dev; not
  all cases can be covered as some introduce binary incompatibilities.

  _Steve Henson_

- Redirect RSA operations to FIPS module including keygen,
  encrypt, decrypt, sign and verify. Block use of non FIPS RSA methods.

  _Steve Henson_

- Add similar low-level API blocking to ciphers.

  _Steve Henson_

- low-level digest APIs are not approved in FIPS mode: any attempt
  to use these will cause a fatal error. Applications that _really_ want
  to use them can use the `private_*` version instead.

  _Steve Henson_

- Redirect cipher operations to FIPS module for FIPS builds.

  _Steve Henson_

- Redirect digest operations to FIPS module for FIPS builds.

  _Steve Henson_

- Update build system to add "fips" flag which will link in fipscanister.o
  for static and shared library builds embedding a signature if needed.

  _Steve Henson_

- Output TLS supported curves in preference order instead of numerical
  order. This is currently hardcoded for the highest order curves first.
  This should be configurable so applications can judge speed vs strength.

  _Steve Henson_

- Add TLS v1.2 server support for client authentication.

  _Steve Henson_

- Add support for FIPS mode in ssl library: disable SSLv3, non-FIPS ciphers
  and enable MD5.

  _Steve Henson_

- Functions FIPS_mode_set() and FIPS_mode() which call the underlying
  FIPS modules versions.

  _Steve Henson_

- Add TLS v1.2 client side support for client authentication. Keep cache
  of handshake records longer as we don't know the hash algorithm to use
  until after the certificate request message is received.

  _Steve Henson_

- Initial TLS v1.2 client support. Add a default signature algorithms
  extension including all the algorithms we support. Parse new signature
  format in client key exchange. Relax some ECC signing restrictions for
  TLS v1.2 as indicated in RFC5246.

  _Steve Henson_

- Add server support for TLS v1.2 signature algorithms extension. Switch
  to new signature format when needed using client digest preference.
  All server ciphersuites should now work correctly in TLS v1.2. No client
  support yet and no support for client certificates.

  _Steve Henson_

- Initial TLS v1.2 support. Add new SHA256 digest to ssl code, switch
  to SHA256 for PRF when using TLS v1.2 and later. Add new SHA256 based
  ciphersuites. At present only RSA key exchange ciphersuites work with
  TLS v1.2. Add new option for TLS v1.2 replacing the old and obsolete
  SSL_OP_PKCS1_CHECK flags with SSL_OP_NO_TLSv1_2. New TLSv1.2 methods
  and version checking.

  _Steve Henson_

- New option OPENSSL_NO_SSL_INTERN. If an application can be compiled
  with this defined it will not be affected by any changes to ssl internal
  structures. Add several utility functions to allow openssl application
  to work with OPENSSL_NO_SSL_INTERN defined.

  _Steve Henson_

- A long standing patch to add support for SRP from EdelWeb (Peter
  Sylvester and Christophe Renou) was integrated.
  _Christophe Renou <christophe.renou@edelweb.fr>, Peter Sylvester
  <peter.sylvester@edelweb.fr>, Tom Wu <tjw@cs.stanford.edu>, and
  Ben Laurie_

- Add functions to copy EVP_PKEY_METHOD and retrieve flags and id.

  _Steve Henson_

- Permit abbreviated handshakes when renegotiating using the function
  SSL_renegotiate_abbreviated().

  _Robin Seggelmann <seggelmann@fh-muenster.de>_

- Add call to ENGINE_register_all_complete() to
  ENGINE_load_builtin_engines(), so some implementations get used
  automatically instead of needing explicit application support.

  _Steve Henson_

- Add support for TLS key exporter as described in RFC5705.

  _Robin Seggelmann <seggelmann@fh-muenster.de>, Steve Henson_

- Initial TLSv1.1 support. Since TLSv1.1 is very similar to TLS v1.0 only
  a few changes are required:

  Add SSL_OP_NO_TLSv1_1 flag.
  Add TLSv1_1 methods.
  Update version checking logic to handle version 1.1.
  Add explicit IV handling (ported from DTLS code).
  Add command line options to s_client/s_server.

  _Steve Henson_

## OpenSSL 1.0.0

### Changes between 1.0.0s and 1.0.0t [3 Dec 2015]

- X509_ATTRIBUTE memory leak

  When presented with a malformed X509_ATTRIBUTE structure OpenSSL will leak
  memory. This structure is used by the PKCS#7 and CMS routines so any
  application which reads PKCS#7 or CMS data from untrusted sources is
  affected. SSL/TLS is not affected.

  This issue was reported to OpenSSL by Adam Langley (Google/BoringSSL) using
  libFuzzer.
  ([CVE-2015-3195])

  _Stephen Henson_

- Race condition handling PSK identify hint

  If PSK identity hints are received by a multi-threaded client then
  the values are wrongly updated in the parent SSL_CTX structure. This can
  result in a race condition potentially leading to a double free of the
  identify hint data.
  ([CVE-2015-3196])

  _Stephen Henson_

### Changes between 1.0.0r and 1.0.0s [11 Jun 2015]

- Malformed ECParameters causes infinite loop

  When processing an ECParameters structure OpenSSL enters an infinite loop
  if the curve specified is over a specially malformed binary polynomial
  field.

  This can be used to perform denial of service against any
  system which processes public keys, certificate requests or
  certificates. This includes TLS clients and TLS servers with
  client authentication enabled.

  This issue was reported to OpenSSL by Joseph Barr-Pixton.
  ([CVE-2015-1788])

  _Andy Polyakov_

- Exploitable out-of-bounds read in X509_cmp_time

  X509_cmp_time does not properly check the length of the ASN1_TIME
  string and can read a few bytes out of bounds. In addition,
  X509_cmp_time accepts an arbitrary number of fractional seconds in the
  time string.

  An attacker can use this to craft malformed certificates and CRLs of
  various sizes and potentially cause a segmentation fault, resulting in
  a DoS on applications that verify certificates or CRLs. TLS clients
  that verify CRLs are affected. TLS clients and servers with client
  authentication enabled may be affected if they use custom verification
  callbacks.

  This issue was reported to OpenSSL by Robert Swiecki (Google), and
  independently by Hanno Böck.
  ([CVE-2015-1789])

  _Emilia Käsper_

- PKCS7 crash with missing EnvelopedContent

  The PKCS#7 parsing code does not handle missing inner EncryptedContent
  correctly. An attacker can craft malformed ASN.1-encoded PKCS#7 blobs
  with missing content and trigger a NULL pointer dereference on parsing.

  Applications that decrypt PKCS#7 data or otherwise parse PKCS#7
  structures from untrusted sources are affected. OpenSSL clients and
  servers are not affected.

  This issue was reported to OpenSSL by Michal Zalewski (Google).
  ([CVE-2015-1790])

  _Emilia Käsper_

- CMS verify infinite loop with unknown hash function

  When verifying a signedData message the CMS code can enter an infinite loop
  if presented with an unknown hash function OID. This can be used to perform
  denial of service against any system which verifies signedData messages using
  the CMS code.
  This issue was reported to OpenSSL by Johannes Bauer.
  ([CVE-2015-1792])

  _Stephen Henson_

- Race condition handling NewSessionTicket

  If a NewSessionTicket is received by a multi-threaded client when attempting to
  reuse a previous ticket then a race condition can occur potentially leading to
  a double free of the ticket data.
  ([CVE-2015-1791])

  _Matt Caswell_

### Changes between 1.0.0q and 1.0.0r [19 Mar 2015]

- Segmentation fault in ASN1_TYPE_cmp fix

  The function ASN1_TYPE_cmp will crash with an invalid read if an attempt is
  made to compare ASN.1 boolean types. Since ASN1_TYPE_cmp is used to check
  certificate signature algorithm consistency this can be used to crash any
  certificate verification operation and exploited in a DoS attack. Any
  application which performs certificate verification is vulnerable including
  OpenSSL clients and servers which enable client authentication.
  ([CVE-2015-0286])

  _Stephen Henson_

- ASN.1 structure reuse memory corruption fix

  Reusing a structure in ASN.1 parsing may allow an attacker to cause
  memory corruption via an invalid write. Such reuse is and has been
  strongly discouraged and is believed to be rare.

  Applications that parse structures containing CHOICE or ANY DEFINED BY
  components may be affected. Certificate parsing (d2i_X509 and related
  functions) are however not affected. OpenSSL clients and servers are
  not affected.
  ([CVE-2015-0287])

  _Stephen Henson_

- PKCS7 NULL pointer dereferences fix

  The PKCS#7 parsing code does not handle missing outer ContentInfo
  correctly. An attacker can craft malformed ASN.1-encoded PKCS#7 blobs with
  missing content and trigger a NULL pointer dereference on parsing.

  Applications that verify PKCS#7 signatures, decrypt PKCS#7 data or
  otherwise parse PKCS#7 structures from untrusted sources are
  affected. OpenSSL clients and servers are not affected.

  This issue was reported to OpenSSL by Michal Zalewski (Google).
  ([CVE-2015-0289])

  _Emilia Käsper_

- DoS via reachable assert in SSLv2 servers fix

  A malicious client can trigger an OPENSSL_assert (i.e., an abort) in
  servers that both support SSLv2 and enable export cipher suites by sending
  a specially crafted SSLv2 CLIENT-MASTER-KEY message.

  This issue was discovered by Sean Burford (Google) and Emilia Käsper
  (OpenSSL development team).
  ([CVE-2015-0293])

  _Emilia Käsper_

- Use After Free following d2i_ECPrivatekey error fix

  A malformed EC private key file consumed via the d2i_ECPrivateKey function
  could cause a use after free condition. This, in turn, could cause a double
  free in several private key parsing functions (such as d2i_PrivateKey
  or EVP_PKCS82PKEY) and could lead to a DoS attack or memory corruption
  for applications that receive EC private keys from untrusted
  sources. This scenario is considered rare.

  This issue was discovered by the BoringSSL project and fixed in their
  commit 517073cd4b.
  ([CVE-2015-0209])

  _Matt Caswell_

- X509_to_X509_REQ NULL pointer deref fix

  The function X509_to_X509_REQ will crash with a NULL pointer dereference if
  the certificate key is invalid. This function is rarely used in practice.

  This issue was discovered by Brian Carpenter.
  ([CVE-2015-0288])

  _Stephen Henson_

- Removed the export ciphers from the DEFAULT ciphers

  _Kurt Roeckx_

### Changes between 1.0.0p and 1.0.0q [15 Jan 2015]

- Build fixes for the Windows and OpenVMS platforms

  _Matt Caswell and Richard Levitte_

### Changes between 1.0.0o and 1.0.0p [8 Jan 2015]

- Fix DTLS segmentation fault in dtls1_get_record. A carefully crafted DTLS
  message can cause a segmentation fault in OpenSSL due to a NULL pointer
  dereference. This could lead to a Denial Of Service attack. Thanks to
  Markus Stenberg of Cisco Systems, Inc. for reporting this issue.
  ([CVE-2014-3571])

  _Steve Henson_

- Fix DTLS memory leak in dtls1_buffer_record. A memory leak can occur in the
  dtls1_buffer_record function under certain conditions. In particular this
  could occur if an attacker sent repeated DTLS records with the same
  sequence number but for the next epoch. The memory leak could be exploited
  by an attacker in a Denial of Service attack through memory exhaustion.
  Thanks to Chris Mueller for reporting this issue.
  ([CVE-2015-0206])

  _Matt Caswell_

- Fix issue where no-ssl3 configuration sets method to NULL. When openssl is
  built with the no-ssl3 option and an SSL v3 ClientHello is received the ssl
  method would be set to NULL which could later result in a NULL pointer
  dereference. Thanks to Frank Schmirler for reporting this issue.
  ([CVE-2014-3569])

  _Kurt Roeckx_

- Abort handshake if server key exchange message is omitted for ephemeral
  ECDH ciphersuites.

  Thanks to Karthikeyan Bhargavan of the PROSECCO team at INRIA for
  reporting this issue.
  ([CVE-2014-3572])

  _Steve Henson_

- Remove non-export ephemeral RSA code on client and server. This code
  violated the TLS standard by allowing the use of temporary RSA keys in
  non-export ciphersuites and could be used by a server to effectively
  downgrade the RSA key length used to a value smaller than the server
  certificate. Thanks for Karthikeyan Bhargavan of the PROSECCO team at
  INRIA or reporting this issue.
  ([CVE-2015-0204])

  _Steve Henson_

- Fixed issue where DH client certificates are accepted without verification.
  An OpenSSL server will accept a DH certificate for client authentication
  without the certificate verify message. This effectively allows a client to
  authenticate without the use of a private key. This only affects servers
  which trust a client certificate authority which issues certificates
  containing DH keys: these are extremely rare and hardly ever encountered.
  Thanks for Karthikeyan Bhargavan of the PROSECCO team at INRIA or reporting
  this issue.
  ([CVE-2015-0205])

  _Steve Henson_

- Correct Bignum squaring. Bignum squaring (BN_sqr) may produce incorrect
  results on some platforms, including x86_64. This bug occurs at random
  with a very low probability, and is not known to be exploitable in any
  way, though its exact impact is difficult to determine. Thanks to Pieter
  Wuille (Blockstream) who reported this issue and also suggested an initial
  fix. Further analysis was conducted by the OpenSSL development team and
  Adam Langley of Google. The final fix was developed by Andy Polyakov of
  the OpenSSL core team.
  ([CVE-2014-3570])

  _Andy Polyakov_

- Fix various certificate fingerprint issues.

  By using non-DER or invalid encodings outside the signed portion of a
  certificate the fingerprint can be changed without breaking the signature.
  Although no details of the signed portion of the certificate can be changed
  this can cause problems with some applications: e.g. those using the
  certificate fingerprint for blacklists.
  1.  Reject signatures with non zero unused bits.

  If the BIT STRING containing the signature has non zero unused bits reject
  the signature. All current signature algorithms require zero unused bits. 2. Check certificate algorithm consistency.

  Check the AlgorithmIdentifier inside TBS matches the one in the
  certificate signature. NB: this will result in signature failure
  errors for some broken certificates.

  Thanks to Konrad Kraszewski from Google for reporting this issue. 3. Check DSA/ECDSA signatures use DER.

  Re-encode DSA/ECDSA signatures and compare with the original received
  signature. Return an error if there is a mismatch.

  This will reject various cases including garbage after signature
  (thanks to Antti Karjalainen and Tuomo Untinen from the Codenomicon CROSS
  program for discovering this case) and use of BER or invalid ASN.1 INTEGERs
  (negative or with leading zeroes).

  Further analysis was conducted and fixes were developed by Stephen Henson
  of the OpenSSL core team.

  ([CVE-2014-8275])

  _Steve Henson_

### Changes between 1.0.0n and 1.0.0o [15 Oct 2014]

- Session Ticket Memory Leak.

  When an OpenSSL SSL/TLS/DTLS server receives a session ticket the
  integrity of that ticket is first verified. In the event of a session
  ticket integrity check failing, OpenSSL will fail to free memory
  causing a memory leak. By sending a large number of invalid session
  tickets an attacker could exploit this issue in a Denial Of Service
  attack.
  ([CVE-2014-3567])

  _Steve Henson_

- Build option no-ssl3 is incomplete.

  When OpenSSL is configured with "no-ssl3" as a build option, servers
  could accept and complete an SSL 3.0 handshake, and clients could be
  configured to send them.
  ([CVE-2014-3568])

  _Akamai and the OpenSSL team_

- Add support for TLS_FALLBACK_SCSV.
  Client applications doing fallback retries should call
  SSL_set_mode(s, SSL_MODE_SEND_FALLBACK_SCSV).
  ([CVE-2014-3566])

  _Adam Langley, Bodo Moeller_

- Add additional DigestInfo checks.

  Re-encode DigestInto in DER and check against the original when
  verifying RSA signature: this will reject any improperly encoded
  DigestInfo structures.

  Note: this is a precautionary measure and no attacks are currently known.

  _Steve Henson_

### Changes between 1.0.0m and 1.0.0n [6 Aug 2014]

- OpenSSL DTLS clients enabling anonymous (EC)DH ciphersuites are subject
  to a denial of service attack. A malicious server can crash the client
  with a null pointer dereference (read) by specifying an anonymous (EC)DH
  ciphersuite and sending carefully crafted handshake messages.

  Thanks to Felix Gröbert (Google) for discovering and researching this
  issue.
  ([CVE-2014-3510])

  _Emilia Käsper_

- By sending carefully crafted DTLS packets an attacker could cause openssl
  to leak memory. This can be exploited through a Denial of Service attack.
  Thanks to Adam Langley for discovering and researching this issue.
  ([CVE-2014-3507])

  _Adam Langley_

- An attacker can force openssl to consume large amounts of memory whilst
  processing DTLS handshake messages. This can be exploited through a
  Denial of Service attack.
  Thanks to Adam Langley for discovering and researching this issue.
  ([CVE-2014-3506])

  _Adam Langley_

- An attacker can force an error condition which causes openssl to crash
  whilst processing DTLS packets due to memory being freed twice. This
  can be exploited through a Denial of Service attack.
  Thanks to Adam Langley and Wan-Teh Chang for discovering and researching
  this issue.
  ([CVE-2014-3505])

  _Adam Langley_

- If a multithreaded client connects to a malicious server using a resumed
  session and the server sends an ec point format extension it could write
  up to 255 bytes to freed memory.

  Thanks to Gabor Tyukasz (LogMeIn Inc) for discovering and researching this
  issue.
  ([CVE-2014-3509])

  _Gabor Tyukasz_

- A flaw in OBJ_obj2txt may cause pretty printing functions such as
  X509_name_oneline, X509_name_print_ex et al. to leak some information
  from the stack. Applications may be affected if they echo pretty printing
  output to the attacker.

  Thanks to Ivan Fratric (Google) for discovering this issue.
  ([CVE-2014-3508])

  _Emilia Käsper, and Steve Henson_

- Fix ec_GFp_simple_points_make_affine (thus, EC_POINTs_mul etc.)
  for corner cases. (Certain input points at infinity could lead to
  bogus results, with non-infinity inputs mapped to infinity too.)

  _Bodo Moeller_

### Changes between 1.0.0l and 1.0.0m [5 Jun 2014]

- Fix for SSL/TLS MITM flaw. An attacker using a carefully crafted
  handshake can force the use of weak keying material in OpenSSL
  SSL/TLS clients and servers.

  Thanks to KIKUCHI Masashi (Lepidum Co. Ltd.) for discovering and
  researching this issue. ([CVE-2014-0224])

  _KIKUCHI Masashi, Steve Henson_

- Fix DTLS recursion flaw. By sending an invalid DTLS handshake to an
  OpenSSL DTLS client the code can be made to recurse eventually crashing
  in a DoS attack.

  Thanks to Imre Rad (Search-Lab Ltd.) for discovering this issue.
  ([CVE-2014-0221])

  _Imre Rad, Steve Henson_

- Fix DTLS invalid fragment vulnerability. A buffer overrun attack can
  be triggered by sending invalid DTLS fragments to an OpenSSL DTLS
  client or server. This is potentially exploitable to run arbitrary
  code on a vulnerable client or server.

  Thanks to Jüri Aedla for reporting this issue. ([CVE-2014-0195])

  _Jüri Aedla, Steve Henson_

- Fix bug in TLS code where clients enable anonymous ECDH ciphersuites
  are subject to a denial of service attack.

  Thanks to Felix Gröbert and Ivan Fratric at Google for discovering
  this issue. ([CVE-2014-3470])

  _Felix Gröbert, Ivan Fratric, Steve Henson_

- Harmonize version and its documentation. -f flag is used to display
  compilation flags.

  _mancha <mancha1@zoho.com>_

- Fix eckey_priv_encode so it immediately returns an error upon a failure
  in i2d_ECPrivateKey.

  _mancha <mancha1@zoho.com>_

- Fix some double frees. These are not thought to be exploitable.

  _mancha <mancha1@zoho.com>_

- Fix for the attack described in the paper "Recovering OpenSSL
  ECDSA Nonces Using the FLUSH+RELOAD Cache Side-channel Attack"
  by Yuval Yarom and Naomi Benger. Details can be obtained from:
  <http://eprint.iacr.org/2014/140>

  Thanks to Yuval Yarom and Naomi Benger for discovering this
  flaw and to Yuval Yarom for supplying a fix ([CVE-2014-0076])

  _Yuval Yarom and Naomi Benger_

### Changes between 1.0.0k and 1.0.0l [6 Jan 2014]

- Keep original DTLS digest and encryption contexts in retransmission
  structures so we can use the previous session parameters if they need
  to be resent. ([CVE-2013-6450])

  _Steve Henson_

- Add option SSL_OP_SAFARI_ECDHE_ECDSA_BUG (part of SSL_OP_ALL) which
  avoids preferring ECDHE-ECDSA ciphers when the client appears to be
  Safari on OS X. Safari on OS X 10.8..10.8.3 advertises support for
  several ECDHE-ECDSA ciphers, but fails to negotiate them. The bug
  is fixed in OS X 10.8.4, but Apple have ruled out both hot fixing
  10.8..10.8.3 and forcing users to upgrade to 10.8.4 or newer.

  _Rob Stradling, Adam Langley_

### Changes between 1.0.0j and 1.0.0k [5 Feb 2013]

- Make the decoding of SSLv3, TLS and DTLS CBC records constant time.

  This addresses the flaw in CBC record processing discovered by
  Nadhem Alfardan and Kenny Paterson. Details of this attack can be found
  at: <http://www.isg.rhul.ac.uk/tls/>

  Thanks go to Nadhem Alfardan and Kenny Paterson of the Information
  Security Group at Royal Holloway, University of London
  (www.isg.rhul.ac.uk) for discovering this flaw and Adam Langley and
  Emilia Käsper for the initial patch.
  ([CVE-2013-0169])

  _Emilia Käsper, Adam Langley, Ben Laurie, Andy Polyakov, Steve Henson_

- Return an error when checking OCSP signatures when key is NULL.
  This fixes a DoS attack. ([CVE-2013-0166])

  _Steve Henson_

- Call OCSP Stapling callback after ciphersuite has been chosen, so
  the right response is stapled. Also change SSL_get_certificate()
  so it returns the certificate actually sent.
  See <http://rt.openssl.org/Ticket/Display.html?id=2836>.
  (This is a backport)

  _Rob Stradling <rob.stradling@comodo.com>_

- Fix possible deadlock when decoding public keys.

  _Steve Henson_

### Changes between 1.0.0i and 1.0.0j [10 May 2012]

[NB: OpenSSL 1.0.0i and later 1.0.0 patch levels were released after
OpenSSL 1.0.1.]

- Sanity check record length before skipping explicit IV in DTLS
  to fix DoS attack.

  Thanks to Codenomicon for discovering this issue using Fuzz-o-Matic
  fuzzing as a service testing platform.
  ([CVE-2012-2333])

  _Steve Henson_

- Initialise tkeylen properly when encrypting CMS messages.
  Thanks to Solar Designer of Openwall for reporting this issue.

  _Steve Henson_

### Changes between 1.0.0h and 1.0.0i [19 Apr 2012]

- Check for potentially exploitable overflows in asn1_d2i_read_bio
  BUF_mem_grow and BUF_mem_grow_clean. Refuse attempts to shrink buffer
  in CRYPTO_realloc_clean.

  Thanks to Tavis Ormandy, Google Security Team, for discovering this
  issue and to Adam Langley <agl@chromium.org> for fixing it.
  ([CVE-2012-2110])

  _Adam Langley (Google), Tavis Ormandy, Google Security Team_

### Changes between 1.0.0g and 1.0.0h [12 Mar 2012]

- Fix MMA (Bleichenbacher's attack on PKCS #1 v1.5 RSA padding) weakness
  in CMS and PKCS7 code. When RSA decryption fails use a random key for
  content decryption and always return the same error. Note: this attack
  needs on average 2^20 messages so it only affects automated senders. The
  old behaviour can be re-enabled in the CMS code by setting the
  CMS_DEBUG_DECRYPT flag: this is useful for debugging and testing where
  an MMA defence is not necessary.
  Thanks to Ivan Nestlerode <inestlerode@us.ibm.com> for discovering
  this issue. ([CVE-2012-0884])

  _Steve Henson_

- Fix CVE-2011-4619: make sure we really are receiving a
  client hello before rejecting multiple SGC restarts. Thanks to
  Ivan Nestlerode <inestlerode@us.ibm.com> for discovering this bug.

  _Steve Henson_

### Changes between 1.0.0f and 1.0.0g [18 Jan 2012]

- Fix for DTLS DoS issue introduced by fix for CVE-2011-4109.
  Thanks to Antonio Martin, Enterprise Secure Access Research and
  Development, Cisco Systems, Inc. for discovering this bug and
  preparing a fix. ([CVE-2012-0050])

  _Antonio Martin_

### Changes between 1.0.0e and 1.0.0f [4 Jan 2012]

- Nadhem Alfardan and Kenny Paterson have discovered an extension
  of the Vaudenay padding oracle attack on CBC mode encryption
  which enables an efficient plaintext recovery attack against
  the OpenSSL implementation of DTLS. Their attack exploits timing
  differences arising during decryption processing. A research
  paper describing this attack can be found at:
  <http://www.isg.rhul.ac.uk/~kp/dtls.pdf>
  Thanks go to Nadhem Alfardan and Kenny Paterson of the Information
  Security Group at Royal Holloway, University of London
  (www.isg.rhul.ac.uk) for discovering this flaw and to Robin Seggelmann
  <seggelmann@fh-muenster.de> and Michael Tuexen <tuexen@fh-muenster.de>
  for preparing the fix. ([CVE-2011-4108])

  _Robin Seggelmann, Michael Tuexen_

- Clear bytes used for block padding of SSL 3.0 records.
  ([CVE-2011-4576])

  _Adam Langley (Google)_

- Only allow one SGC handshake restart for SSL/TLS. Thanks to George
  Kadianakis <desnacked@gmail.com> for discovering this issue and
  Adam Langley for preparing the fix. ([CVE-2011-4619])

  _Adam Langley (Google)_

- Check parameters are not NULL in GOST ENGINE. ([CVE-2012-0027])

  _Andrey Kulikov <amdeich@gmail.com>_

- Prevent malformed RFC3779 data triggering an assertion failure.
  Thanks to Andrew Chi, BBN Technologies, for discovering the flaw
  and Rob Austein <sra@hactrn.net> for fixing it. ([CVE-2011-4577])

  _Rob Austein <sra@hactrn.net>_

- Improved PRNG seeding for VOS.

  _Paul Green <Paul.Green@stratus.com>_

- Fix ssl_ciph.c set-up race.

  _Adam Langley (Google)_

- Fix spurious failures in ecdsatest.c.

  _Emilia Käsper (Google)_

- Fix the BIO_f_buffer() implementation (which was mixing different
  interpretations of the `..._len` fields).

  _Adam Langley (Google)_

- Fix handling of BN_BLINDING: now BN_BLINDING_invert_ex (rather than
  BN_BLINDING_invert_ex) calls BN_BLINDING_update, ensuring that concurrent
  threads won't reuse the same blinding coefficients.

  This also avoids the need to obtain the CRYPTO_LOCK_RSA_BLINDING
  lock to call BN_BLINDING_invert_ex, and avoids one use of
  BN_BLINDING_update for each BN_BLINDING structure (previously,
  the last update always remained unused).

  _Emilia Käsper (Google)_

- In ssl3_clear, preserve s3->init_extra along with s3->rbuf.

  _Bob Buckholz (Google)_

### Changes between 1.0.0d and 1.0.0e [6 Sep 2011]

- Fix bug where CRLs with nextUpdate in the past are sometimes accepted
  by initialising X509_STORE_CTX properly. ([CVE-2011-3207])

  _Kaspar Brand <ossl@velox.ch>_

- Fix SSL memory handling for (EC)DH ciphersuites, in particular
  for multi-threaded use of ECDH. ([CVE-2011-3210])

  _Adam Langley (Google)_

- Fix x509_name_ex_d2i memory leak on bad inputs.

  _Bodo Moeller_

- Remove hard coded ecdsaWithSHA1 signature tests in ssl code and check
  signature public key algorithm by using OID xref utilities instead.
  Before this you could only use some ECC ciphersuites with SHA1 only.

  _Steve Henson_

- Add protection against ECDSA timing attacks as mentioned in the paper
  by Billy Bob Brumley and Nicola Tuveri, see:
  <http://eprint.iacr.org/2011/232.pdf>

  _Billy Bob Brumley and Nicola Tuveri_

### Changes between 1.0.0c and 1.0.0d [8 Feb 2011]

- Fix parsing of OCSP stapling ClientHello extension. CVE-2011-0014

  _Neel Mehta, Adam Langley, Bodo Moeller (Google)_

- Fix bug in string printing code: if _any_ escaping is enabled we must
  escape the escape character (backslash) or the resulting string is
  ambiguous.

  _Steve Henson_

### Changes between 1.0.0b and 1.0.0c [2 Dec 2010]

- Disable code workaround for ancient and obsolete Netscape browsers
  and servers: an attacker can use it in a ciphersuite downgrade attack.
  Thanks to Martin Rex for discovering this bug. CVE-2010-4180

  _Steve Henson_

- Fixed J-PAKE implementation error, originally discovered by
  Sebastien Martini, further info and confirmation from Stefan
  Arentz and Feng Hao. Note that this fix is a security fix. CVE-2010-4252

  _Ben Laurie_

### Changes between 1.0.0a and 1.0.0b [16 Nov 2010]

- Fix extension code to avoid race conditions which can result in a buffer
  overrun vulnerability: resumed sessions must not be modified as they can
  be shared by multiple threads. CVE-2010-3864

  _Steve Henson_

- Fix WIN32 build system to correctly link an ENGINE directory into
  a DLL.

  _Steve Henson_

### Changes between 1.0.0 and 1.0.0a [01 Jun 2010]

- Check return value of int_rsa_verify in pkey_rsa_verifyrecover
  ([CVE-2010-1633])

  _Steve Henson, Peter-Michael Hager <hager@dortmund.net>_

### Changes between 0.9.8n and 1.0.0 [29 Mar 2010]

- Add "missing" function EVP_CIPHER_CTX_copy(). This copies a cipher
  context. The operation can be customised via the ctrl mechanism in
  case ENGINEs want to include additional functionality.

  _Steve Henson_

- Tolerate yet another broken PKCS#8 key format: private key value negative.

  _Steve Henson_

- Add new -subject_hash_old and -issuer_hash_old options to x509 utility to
  output hashes compatible with older versions of OpenSSL.

  _Willy Weisz <weisz@vcpc.univie.ac.at>_

- Fix compression algorithm handling: if resuming a session use the
  compression algorithm of the resumed session instead of determining
  it from client hello again. Don't allow server to change algorithm.

  _Steve Henson_

- Add load_crls() function to commands tidying load_certs() too. Add option
  to verify utility to allow additional CRLs to be included.

  _Steve Henson_

- Update OCSP request code to permit adding custom headers to the request:
  some responders need this.

  _Steve Henson_

- The function EVP_PKEY_sign() returns <=0 on error: check return code
  correctly.

  _Julia Lawall <julia@diku.dk>_

- Update verify callback code in `apps/s_cb.c` and `apps/verify.c`, it
  needlessly dereferenced structures, used obsolete functions and
  didn't handle all updated verify codes correctly.

  _Steve Henson_

- Disable MD2 in the default configuration.

  _Steve Henson_

- In BIO_pop() and BIO_push() use the ctrl argument (which was NULL) to
  indicate the initial BIO being pushed or popped. This makes it possible
  to determine whether the BIO is the one explicitly called or as a result
  of the ctrl being passed down the chain. Fix BIO_pop() and SSL BIOs so
  it handles reference counts correctly and doesn't zero out the I/O bio
  when it is not being explicitly popped. WARNING: applications which
  included workarounds for the old buggy behaviour will need to be modified
  or they could free up already freed BIOs.

  _Steve Henson_

- Extend the uni2asc/asc2uni => OPENSSL_uni2asc/OPENSSL_asc2uni
  renaming to all platforms (within the 0.9.8 branch, this was
  done conditionally on Netware platforms to avoid a name clash).

  _Guenter <lists@gknw.net>_

- Add ECDHE and PSK support to DTLS.

  _Michael Tuexen <tuexen@fh-muenster.de>_

- Add CHECKED_STACK_OF macro to safestack.h, otherwise safestack can't
  be used on C++.

  _Steve Henson_

- Add "missing" function EVP_MD_flags() (without this the only way to
  retrieve a digest flags is by accessing the structure directly. Update
  `EVP_MD_do_all*()` and `EVP_CIPHER_do_all*()` to include the name a digest
  or cipher is registered as in the "from" argument. Print out all
  registered digests in the dgst usage message instead of manually
  attempting to work them out.

  _Steve Henson_

- If no SSLv2 ciphers are used don't use an SSLv2 compatible client hello:
  this allows the use of compression and extensions. Change default cipher
  string to remove SSLv2 ciphersuites. This effectively avoids ancient SSLv2
  by default unless an application cipher string requests it.

  _Steve Henson_

- Alter match criteria in PKCS12_parse(). It used to try to use local
  key ids to find matching certificates and keys but some PKCS#12 files
  don't follow the (somewhat unwritten) rules and this strategy fails.
  Now just gather all certificates together and the first private key
  then look for the first certificate that matches the key.

  _Steve Henson_

- Support use of registered digest and cipher names for dgst and cipher
  commands instead of having to add each one as a special case. So now
  you can do:

          openssl sha256 foo

  as well as:

          openssl dgst -sha256 foo

  and this works for ENGINE based algorithms too.

  _Steve Henson_

- Update Gost ENGINE to support parameter files.

  _Victor B. Wagner <vitus@cryptocom.ru>_

- Support GeneralizedTime in ca utility.

  _Oliver Martin <oliver@volatilevoid.net>, Steve Henson_

- Enhance the hash format used for certificate directory links. The new
  form uses the canonical encoding (meaning equivalent names will work
  even if they aren't identical) and uses SHA1 instead of MD5. This form
  is incompatible with the older format and as a result c_rehash should
  be used to rebuild symbolic links.

  _Steve Henson_

- Make PKCS#8 the default write format for private keys, replacing the
  traditional format. This form is standardised, more secure and doesn't
  include an implicit MD5 dependency.

  _Steve Henson_

- Add a $gcc_devteam_warn option to Configure. The idea is that any code
  committed to OpenSSL should pass this lot as a minimum.

  _Steve Henson_

- Add session ticket override functionality for use by EAP-FAST.

  _Jouni Malinen <j@w1.fi>_

- Modify HMAC functions to return a value. Since these can be implemented
  in an ENGINE errors can occur.

  _Steve Henson_

- Type-checked OBJ_bsearch_ex.

  _Ben Laurie_

- Type-checked OBJ_bsearch. Also some constification necessitated
  by type-checking. Still to come: TXT_DB, bsearch(?),
  OBJ_bsearch_ex, qsort, CRYPTO_EX_DATA, ASN1_VALUE, ASN1_STRING,
  CONF_VALUE.

  _Ben Laurie_

- New function OPENSSL_gmtime_adj() to add a specific number of days and
  seconds to a tm structure directly, instead of going through OS
  specific date routines. This avoids any issues with OS routines such
  as the year 2038 bug. New `*_adj()` functions for ASN1 time structures
  and X509_time_adj_ex() to cover the extended range. The existing
  X509_time_adj() is still usable and will no longer have any date issues.

  _Steve Henson_

- Delta CRL support. New use deltas option which will attempt to locate
  and search any appropriate delta CRLs available.

  This work was sponsored by Google.

  _Steve Henson_

- Support for CRLs partitioned by reason code. Reorganise CRL processing
  code and add additional score elements. Validate alternate CRL paths
  as part of the CRL checking and indicate a new error "CRL path validation
  error" in this case. Applications wanting additional details can use
  the verify callback and check the new "parent" field. If this is not
  NULL CRL path validation is taking place. Existing applications won't
  see this because it requires extended CRL support which is off by
  default.

  This work was sponsored by Google.

  _Steve Henson_

- Support for freshest CRL extension.

  This work was sponsored by Google.

  _Steve Henson_

- Initial indirect CRL support. Currently only supported in the CRLs
  passed directly and not via lookup. Process certificate issuer
  CRL entry extension and lookup CRL entries by bother issuer name
  and serial number. Check and process CRL issuer entry in IDP extension.

  This work was sponsored by Google.

  _Steve Henson_

- Add support for distinct certificate and CRL paths. The CRL issuer
  certificate is validated separately in this case. Only enabled if
  an extended CRL support flag is set: this flag will enable additional
  CRL functionality in future.

  This work was sponsored by Google.

  _Steve Henson_

- Add support for policy mappings extension.

  This work was sponsored by Google.

  _Steve Henson_

- Fixes to pathlength constraint, self issued certificate handling,
  policy processing to align with RFC3280 and PKITS tests.

  This work was sponsored by Google.

  _Steve Henson_

- Support for name constraints certificate extension. DN, email, DNS
  and URI types are currently supported.

  This work was sponsored by Google.

  _Steve Henson_

- To cater for systems that provide a pointer-based thread ID rather
  than numeric, deprecate the current numeric thread ID mechanism and
  replace it with a structure and associated callback type. This
  mechanism allows a numeric "hash" to be extracted from a thread ID in
  either case, and on platforms where pointers are larger than 'long',
  mixing is done to help ensure the numeric 'hash' is usable even if it
  can't be guaranteed unique. The default mechanism is to use "&errno"
  as a pointer-based thread ID to distinguish between threads.

  Applications that want to provide their own thread IDs should now use
  CRYPTO_THREADID_set_callback() to register a callback that will call
  either CRYPTO_THREADID_set_numeric() or CRYPTO_THREADID_set_pointer().

  Note that ERR_remove_state() is now deprecated, because it is tied
  to the assumption that thread IDs are numeric. ERR_remove_state(0)
  to free the current thread's error state should be replaced by
  ERR_remove_thread_state(NULL).

  (This new approach replaces the functions CRYPTO_set_idptr_callback(),
  CRYPTO_get_idptr_callback(), and CRYPTO_thread_idptr() that existed in
  OpenSSL 0.9.9-dev between June 2006 and August 2008. Also, if an
  application was previously providing a numeric thread callback that
  was inappropriate for distinguishing threads, then uniqueness might
  have been obtained with &errno that happened immediately in the
  intermediate development versions of OpenSSL; this is no longer the
  case, the numeric thread callback will now override the automatic use
  of &errno.)

  _Geoff Thorpe, with help from Bodo Moeller_

- Initial support for different CRL issuing certificates. This covers a
  simple case where the self issued certificates in the chain exist and
  the real CRL issuer is higher in the existing chain.

  This work was sponsored by Google.

  _Steve Henson_

- Removed effectively defunct crypto/store from the build.

  _Ben Laurie_

- Revamp of STACK to provide stronger type-checking. Still to come:
  TXT_DB, bsearch(?), OBJ_bsearch, qsort, CRYPTO_EX_DATA, ASN1_VALUE,
  ASN1_STRING, CONF_VALUE.

  _Ben Laurie_

- Add a new SSL_MODE_RELEASE_BUFFERS mode flag to release unused buffer
  RAM on SSL connections. This option can save about 34k per idle SSL.

  _Nick Mathewson_

- Revamp of LHASH to provide stronger type-checking. Still to come:
  STACK, TXT_DB, bsearch, qsort.

  _Ben Laurie_

- Initial support for Cryptographic Message Syntax (aka CMS) based
  on RFC3850, RFC3851 and RFC3852. New cms directory and cms utility,
  support for data, signedData, compressedData, digestedData and
  encryptedData, envelopedData types included. Scripts to check against
  RFC4134 examples draft and interop and consistency checks of many
  content types and variants.

  _Steve Henson_

- Add options to enc utility to support use of zlib compression BIO.

  _Steve Henson_

- Extend mk1mf to support importing of options and assembly language
  files from Configure script, currently only included in VC-WIN32.
  The assembly language rules can now optionally generate the source
  files from the associated perl scripts.

  _Steve Henson_

- Implement remaining functionality needed to support GOST ciphersuites.
  Interop testing has been performed using CryptoPro implementations.

  _Victor B. Wagner <vitus@cryptocom.ru>_

- s390x assembler pack.

  _Andy Polyakov_

- ARMv4 assembler pack. ARMv4 refers to v4 and later ISA, not CPU
  "family."

  _Andy Polyakov_

- Implement Opaque PRF Input TLS extension as specified in
  draft-rescorla-tls-opaque-prf-input-00.txt. Since this is not an
  official specification yet and no extension type assignment by
  IANA exists, this extension (for now) will have to be explicitly
  enabled when building OpenSSL by providing the extension number
  to use. For example, specify an option

          -DTLSEXT_TYPE_opaque_prf_input=0x9527

  to the "config" or "Configure" script to enable the extension,
  assuming extension number 0x9527 (which is a completely arbitrary
  and unofficial assignment based on the MD5 hash of the Internet
  Draft). Note that by doing so, you potentially lose
  interoperability with other TLS implementations since these might
  be using the same extension number for other purposes.

  SSL_set_tlsext_opaque_prf_input(ssl, src, len) is used to set the
  opaque PRF input value to use in the handshake. This will create
  an internal copy of the length-'len' string at 'src', and will
  return non-zero for success.

  To get more control and flexibility, provide a callback function
  by using

          SSL_CTX_set_tlsext_opaque_prf_input_callback(ctx, cb)
          SSL_CTX_set_tlsext_opaque_prf_input_callback_arg(ctx, arg)

  where

          int (*cb)(SSL *, void *peerinput, size_t len, void *arg);
          void *arg;

  Callback function 'cb' will be called in handshakes, and is
  expected to use SSL_set_tlsext_opaque_prf_input() as appropriate.
  Argument 'arg' is for application purposes (the value as given to
  SSL_CTX_set_tlsext_opaque_prf_input_callback_arg() will directly
  be provided to the callback function). The callback function
  has to return non-zero to report success: usually 1 to use opaque
  PRF input just if possible, or 2 to enforce use of the opaque PRF
  input. In the latter case, the library will abort the handshake
  if opaque PRF input is not successfully negotiated.

  Arguments 'peerinput' and 'len' given to the callback function
  will always be NULL and 0 in the case of a client. A server will
  see the client's opaque PRF input through these variables if
  available (NULL and 0 otherwise). Note that if the server
  provides an opaque PRF input, the length must be the same as the
  length of the client's opaque PRF input.

  Note that the callback function will only be called when creating
  a new session (session resumption can resume whatever was
  previously negotiated), and will not be called in SSL 2.0
  handshakes; thus, SSL_CTX_set_options(ctx, SSL_OP_NO_SSLv2) or
  SSL_set_options(ssl, SSL_OP_NO_SSLv2) is especially recommended
  for applications that need to enforce opaque PRF input.

  _Bodo Moeller_

- Update ssl code to support digests other than SHA1+MD5 for handshake
  MAC.

  _Victor B. Wagner <vitus@cryptocom.ru>_

- Add RFC4507 support to OpenSSL. This includes the corrections in
  RFC4507bis. The encrypted ticket format is an encrypted encoded
  SSL_SESSION structure, that way new session features are automatically
  supported.

  If a client application caches session in an SSL_SESSION structure
  support is transparent because tickets are now stored in the encoded
  SSL_SESSION.

  The SSL_CTX structure automatically generates keys for ticket
  protection in servers so again support should be possible
  with no application modification.

  If a client or server wishes to disable RFC4507 support then the option
  SSL_OP_NO_TICKET can be set.

  Add a TLS extension debugging callback to allow the contents of any client
  or server extensions to be examined.

  This work was sponsored by Google.

  _Steve Henson_

- Final changes to avoid use of pointer pointer casts in OpenSSL.
  OpenSSL should now compile cleanly on gcc 4.2

  _Peter Hartley <pdh@utter.chaos.org.uk>, Steve Henson_

- Update SSL library to use new EVP_PKEY MAC API. Include generic MAC
  support including streaming MAC support: this is required for GOST
  ciphersuite support.

  _Victor B. Wagner <vitus@cryptocom.ru>, Steve Henson_

- Add option -stream to use PKCS#7 streaming in smime utility. New
  function i2d_PKCS7_bio_stream() and PEM_write_PKCS7_bio_stream()
  to output in BER and PEM format.

  _Steve Henson_

- Experimental support for use of HMAC via EVP_PKEY interface. This
  allows HMAC to be handled via the `EVP_DigestSign*()` interface. The
  EVP_PKEY "key" in this case is the HMAC key, potentially allowing
  ENGINE support for HMAC keys which are unextractable. New -mac and
  -macopt options to dgst utility.

  _Steve Henson_

- New option -sigopt to dgst utility. Update dgst to use
  `EVP_Digest{Sign,Verify}*`. These two changes make it possible to use
  alternative signing parameters such as X9.31 or PSS in the dgst
  utility.

  _Steve Henson_

- Change ssl_cipher_apply_rule(), the internal function that does
  the work each time a ciphersuite string requests enabling
  ("foo+bar"), moving ("+foo+bar"), disabling ("-foo+bar", or
  removing ("!foo+bar") a class of ciphersuites: Now it maintains
  the order of disabled ciphersuites such that those ciphersuites
  that most recently went from enabled to disabled not only stay
  in order with respect to each other, but also have higher priority
  than other disabled ciphersuites the next time ciphersuites are
  enabled again.

  This means that you can now say, e.g., "PSK:-PSK:HIGH" to enable
  the same ciphersuites as with "HIGH" alone, but in a specific
  order where the PSK ciphersuites come first (since they are the
  most recently disabled ciphersuites when "HIGH" is parsed).

  Also, change ssl_create_cipher_list() (using this new
  functionality) such that between otherwise identical
  ciphersuites, ephemeral ECDH is preferred over ephemeral DH in
  the default order.

  _Bodo Moeller_

- Change ssl_create_cipher_list() so that it automatically
  arranges the ciphersuites in reasonable order before starting
  to process the rule string. Thus, the definition for "DEFAULT"
  (SSL_DEFAULT_CIPHER_LIST) now is just "ALL:!aNULL:!eNULL", but
  remains equivalent to `"AES:ALL:!aNULL:!eNULL:+aECDH:+kRSA:+RC4:@STRENGTH"`.
  This makes it much easier to arrive at a reasonable default order
  in applications for which anonymous ciphers are OK (meaning
  that you can't actually use DEFAULT).

  _Bodo Moeller; suggested by Victor Duchovni_

- Split the SSL/TLS algorithm mask (as used for ciphersuite string
  processing) into multiple integers instead of setting
  "SSL_MKEY_MASK" bits, "SSL_AUTH_MASK" bits, "SSL_ENC_MASK",
  "SSL_MAC_MASK", and "SSL_SSL_MASK" bits all in a single integer.
  (These masks as well as the individual bit definitions are hidden
  away into the non-exported interface ssl/ssl_locl.h, so this
  change to the definition of the SSL_CIPHER structure shouldn't
  affect applications.) This give us more bits for each of these
  categories, so there is no longer a need to coagulate AES128 and
  AES256 into a single algorithm bit, and to coagulate Camellia128
  and Camellia256 into a single algorithm bit, which has led to all
  kinds of kludges.

  Thus, among other things, the kludge introduced in 0.9.7m and
  0.9.8e for masking out AES256 independently of AES128 or masking
  out Camellia256 independently of AES256 is not needed here in 0.9.9.

  With the change, we also introduce new ciphersuite aliases that
  so far were missing: "AES128", "AES256", "CAMELLIA128", and
  "CAMELLIA256".

  _Bodo Moeller_

- Add support for dsa-with-SHA224 and dsa-with-SHA256.
  Use the leftmost N bytes of the signature input if the input is
  larger than the prime q (with N being the size in bytes of q).

  _Nils Larsch_

- Very _very_ experimental PKCS#7 streaming encoder support. Nothing uses
  it yet and it is largely untested.

  _Steve Henson_

- Add support for the ecdsa-with-SHA224/256/384/512 signature types.

  _Nils Larsch_

- Initial incomplete changes to avoid need for function casts in OpenSSL
  some compilers (gcc 4.2 and later) reject their use. Safestack is
  reimplemented. Update ASN1 to avoid use of legacy functions.

  _Steve Henson_

- Win32/64 targets are linked with Winsock2.

  _Andy Polyakov_

- Add an X509_CRL_METHOD structure to allow CRL processing to be redirected
  to external functions. This can be used to increase CRL handling
  efficiency especially when CRLs are very large by (for example) storing
  the CRL revoked certificates in a database.

  _Steve Henson_

- Overhaul of by_dir code. Add support for dynamic loading of CRLs so
  new CRLs added to a directory can be used. New command line option
  -verify_return_error to s_client and s_server. This causes real errors
  to be returned by the verify callback instead of carrying on no matter
  what. This reflects the way a "real world" verify callback would behave.

  _Steve Henson_

- GOST engine, supporting several GOST algorithms and public key formats.
  Kindly donated by Cryptocom.

  _Cryptocom_

- Partial support for Issuing Distribution Point CRL extension. CRLs
  partitioned by DP are handled but no indirect CRL or reason partitioning
  (yet). Complete overhaul of CRL handling: now the most suitable CRL is
  selected via a scoring technique which handles IDP and AKID in CRLs.

  _Steve Henson_

- New X509_STORE_CTX callbacks lookup_crls() and lookup_certs() which
  will ultimately be used for all verify operations: this will remove the
  X509_STORE dependency on certificate verification and allow alternative
  lookup methods. X509_STORE based implementations of these two callbacks.

  _Steve Henson_

- Allow multiple CRLs to exist in an X509_STORE with matching issuer names.
  Modify get_crl() to find a valid (unexpired) CRL if possible.

  _Steve Henson_

- New function X509_CRL_match() to check if two CRLs are identical. Normally
  this would be called X509_CRL_cmp() but that name is already used by
  a function that just compares CRL issuer names. Cache several CRL
  extensions in X509_CRL structure and cache CRLDP in X509.

  _Steve Henson_

- Store a "canonical" representation of X509_NAME structure (ASN1 Name)
  this maps equivalent X509_NAME structures into a consistent structure.
  Name comparison can then be performed rapidly using memcmp().

  _Steve Henson_

- Non-blocking OCSP request processing. Add -timeout option to ocsp
  utility.

  _Steve Henson_

- Allow digests to supply their own micalg string for S/MIME type using
  the ctrl EVP_MD_CTRL_MICALG.

  _Steve Henson_

- During PKCS7 signing pass the PKCS7 SignerInfo structure to the
  EVP_PKEY_METHOD before and after signing via the EVP_PKEY_CTRL_PKCS7_SIGN
  ctrl. It can then customise the structure before and/or after signing
  if necessary.

  _Steve Henson_

- New function OBJ_add_sigid() to allow application defined signature OIDs
  to be added to OpenSSLs internal tables. New function OBJ_sigid_free()
  to free up any added signature OIDs.

  _Steve Henson_

- New functions EVP_CIPHER_do_all(), EVP_CIPHER_do_all_sorted(),
  EVP_MD_do_all() and EVP_MD_do_all_sorted() to enumerate internal
  digest and cipher tables. New options added to openssl utility:
  list-message-digest-algorithms and list-cipher-algorithms.

  _Steve Henson_

- Change the array representation of binary polynomials: the list
  of degrees of non-zero coefficients is now terminated with -1.
  Previously it was terminated with 0, which was also part of the
  value; thus, the array representation was not applicable to
  polynomials where t^0 has coefficient zero. This change makes
  the array representation useful in a more general context.

  _Douglas Stebila_

- Various modifications and fixes to SSL/TLS cipher string
  handling. For ECC, the code now distinguishes between fixed ECDH
  with RSA certificates on the one hand and with ECDSA certificates
  on the other hand, since these are separate ciphersuites. The
  unused code for Fortezza ciphersuites has been removed.

  For consistency with EDH, ephemeral ECDH is now called "EECDH"
  (not "ECDHE"). For consistency with the code for DH
  certificates, use of ECDH certificates is now considered ECDH
  authentication, not RSA or ECDSA authentication (the latter is
  merely the CA's signing algorithm and not actively used in the
  protocol).

  The temporary ciphersuite alias "ECCdraft" is no longer
  available, and ECC ciphersuites are no longer excluded from "ALL"
  and "DEFAULT". The following aliases now exist for RFC 4492
  ciphersuites, most of these by analogy with the DH case:

          kECDHr   - ECDH cert, signed with RSA
          kECDHe   - ECDH cert, signed with ECDSA
          kECDH    - ECDH cert (signed with either RSA or ECDSA)
          kEECDH   - ephemeral ECDH
          ECDH     - ECDH cert or ephemeral ECDH

          aECDH    - ECDH cert
          aECDSA   - ECDSA cert
          ECDSA    - ECDSA cert

          AECDH    - anonymous ECDH
          EECDH    - non-anonymous ephemeral ECDH (equivalent to "kEECDH:-AECDH")

  _Bodo Moeller_

- Add additional S/MIME capabilities for AES and GOST ciphers if supported.
  Use correct micalg parameters depending on digest(s) in signed message.

  _Steve Henson_

- Add engine support for EVP_PKEY_ASN1_METHOD. Add functions to process
  an ENGINE asn1 method. Support ENGINE lookups in the ASN1 code.

  _Steve Henson_

- Initial engine support for EVP_PKEY_METHOD. New functions to permit
  an engine to register a method. Add ENGINE lookups for methods and
  functional reference processing.

  _Steve Henson_

- New functions `EVP_Digest{Sign,Verify)*`. These are enhanced versions of
  `EVP_{Sign,Verify}*` which allow an application to customise the signature
  process.

  _Steve Henson_

- New -resign option to smime utility. This adds one or more signers
  to an existing PKCS#7 signedData structure. Also -md option to use an
  alternative message digest algorithm for signing.

  _Steve Henson_

- Tidy up PKCS#7 routines and add new functions to make it easier to
  create PKCS7 structures containing multiple signers. Update smime
  application to support multiple signers.

  _Steve Henson_

- New -macalg option to pkcs12 utility to allow setting of an alternative
  digest MAC.

  _Steve Henson_

- Initial support for PKCS#5 v2.0 PRFs other than default SHA1 HMAC.
  Reorganize PBE internals to lookup from a static table using NIDs,
  add support for HMAC PBE OID translation. Add a EVP_CIPHER ctrl:
  EVP_CTRL_PBE_PRF_NID this allows a cipher to specify an alternative
  PRF which will be automatically used with PBES2.

  _Steve Henson_

- Replace the algorithm specific calls to generate keys in "req" with the
  new API.

  _Steve Henson_

- Update PKCS#7 enveloped data routines to use new API. This is now
  supported by any public key method supporting the encrypt operation. A
  ctrl is added to allow the public key algorithm to examine or modify
  the PKCS#7 RecipientInfo structure if it needs to: for RSA this is
  a no op.

  _Steve Henson_

- Add a ctrl to asn1 method to allow a public key algorithm to express
  a default digest type to use. In most cases this will be SHA1 but some
  algorithms (such as GOST) need to specify an alternative digest. The
  return value indicates how strong the preference is 1 means optional and
  2 is mandatory (that is it is the only supported type). Modify
  ASN1_item_sign() to accept a NULL digest argument to indicate it should
  use the default md. Update openssl utilities to use the default digest
  type for signing if it is not explicitly indicated.

  _Steve Henson_

- Use OID cross reference table in ASN1_sign() and ASN1_verify(). New
  EVP_MD flag EVP_MD_FLAG_PKEY_METHOD_SIGNATURE. This uses the relevant
  signing method from the key type. This effectively removes the link
  between digests and public key types.

  _Steve Henson_

- Add an OID cross reference table and utility functions. Its purpose is to
  translate between signature OIDs such as SHA1WithrsaEncryption and SHA1,
  rsaEncryption. This will allow some of the algorithm specific hackery
  needed to use the correct OID to be removed.

  _Steve Henson_

- Remove algorithm specific dependencies when setting PKCS7_SIGNER_INFO
  structures for PKCS7_sign(). They are now set up by the relevant public
  key ASN1 method.

  _Steve Henson_

- Add provisional EC pkey method with support for ECDSA and ECDH.

  _Steve Henson_

- Add support for key derivation (agreement) in the API, DH method and
  pkeyutl.

  _Steve Henson_

- Add DSA pkey method and DH pkey methods, extend DH ASN1 method to support
  public and private key formats. As a side effect these add additional
  command line functionality not previously available: DSA signatures can be
  generated and verified using pkeyutl and DH key support and generation in
  pkey, genpkey.

  _Steve Henson_

- BeOS support.

  _Oliver Tappe <zooey@hirschkaefer.de>_

- New make target "install_html_docs" installs HTML renditions of the
  manual pages.

  _Oliver Tappe <zooey@hirschkaefer.de>_

- New utility "genpkey" this is analogous to "genrsa" etc except it can
  generate keys for any algorithm. Extend and update EVP_PKEY_METHOD to
  support key and parameter generation and add initial key generation
  functionality for RSA.

  _Steve Henson_

- Add functions for main EVP*PKEY_method operations. The undocumented
  functions `EVP_PKEY*{encrypt,decrypt}`have been renamed to`EVP*PKEY*{encrypt,decrypt}\_old`.

  _Steve Henson_

- Initial definitions for EVP_PKEY_METHOD. This will be a high level public
  key API, doesn't do much yet.

  _Steve Henson_

- New function EVP_PKEY_asn1_get0_info() to retrieve information about
  public key algorithms. New option to openssl utility:
  "list-public-key-algorithms" to print out info.

  _Steve Henson_

- Implement the Supported Elliptic Curves Extension for
  ECC ciphersuites from draft-ietf-tls-ecc-12.txt.

  _Douglas Stebila_

- Don't free up OIDs in OBJ_cleanup() if they are in use by EVP_MD or
  EVP_CIPHER structures to avoid later problems in EVP_cleanup().

  _Steve Henson_

- New utilities pkey and pkeyparam. These are similar to algorithm specific
  utilities such as rsa, dsa, dsaparam etc except they process any key
  type.

  _Steve Henson_

- Transfer public key printing routines to EVP_PKEY_ASN1_METHOD. New
  functions EVP_PKEY_print_public(), EVP_PKEY_print_private(),
  EVP_PKEY_print_param() to print public key data from an EVP_PKEY
  structure.

  _Steve Henson_

- Initial support for pluggable public key ASN1.
  De-spaghettify the public key ASN1 handling. Move public and private
  key ASN1 handling to a new EVP_PKEY_ASN1_METHOD structure. Relocate
  algorithm specific handling to a single module within the relevant
  algorithm directory. Add functions to allow (near) opaque processing
  of public and private key structures.

  _Steve Henson_

- Implement the Supported Point Formats Extension for
  ECC ciphersuites from draft-ietf-tls-ecc-12.txt.

  _Douglas Stebila_

- Add initial support for RFC 4279 PSK TLS ciphersuites. Add members
  for the psk identity [hint] and the psk callback functions to the
  SSL_SESSION, SSL and SSL_CTX structure.

  New ciphersuites:
  PSK-RC4-SHA, PSK-3DES-EDE-CBC-SHA, PSK-AES128-CBC-SHA,
  PSK-AES256-CBC-SHA

  New functions:
  SSL_CTX_use_psk_identity_hint
  SSL_get_psk_identity_hint
  SSL_get_psk_identity
  SSL_use_psk_identity_hint

  _Mika Kousa and Pasi Eronen of Nokia Corporation_

- Add RFC 3161 compliant time stamp request creation, response generation
  and response verification functionality.

  _Zoltán Glózik <zglozik@opentsa.org>, The OpenTSA Project_

- Add initial support for TLS extensions, specifically for the server_name
  extension so far. The SSL_SESSION, SSL_CTX, and SSL data structures now
  have new members for a hostname. The SSL data structure has an
  additional member `SSL_CTX *initial_ctx` so that new sessions can be
  stored in that context to allow for session resumption, even after the
  SSL has been switched to a new SSL_CTX in reaction to a client's
  server_name extension.

  New functions (subject to change):

          SSL_get_servername()
          SSL_get_servername_type()
          SSL_set_SSL_CTX()

  New CTRL codes and macros (subject to change):

          SSL_CTRL_SET_TLSEXT_SERVERNAME_CB
                              - SSL_CTX_set_tlsext_servername_callback()
          SSL_CTRL_SET_TLSEXT_SERVERNAME_ARG
                                   - SSL_CTX_set_tlsext_servername_arg()
          SSL_CTRL_SET_TLSEXT_HOSTNAME           - SSL_set_tlsext_host_name()

  openssl s_client has a new '-servername ...' option.

  openssl s_server has new options '-servername_host ...', '-cert2 ...',
  '-key2 ...', '-servername_fatal' (subject to change). This allows
  testing the HostName extension for a specific single hostname ('-cert'
  and '-key' remain fallbacks for handshakes without HostName
  negotiation). If the unrecognized_name alert has to be sent, this by
  default is a warning; it becomes fatal with the '-servername_fatal'
  option.

  _Peter Sylvester, Remy Allais, Christophe Renou_

- Whirlpool hash implementation is added.

  _Andy Polyakov_

- BIGNUM code on 64-bit SPARCv9 targets is switched from bn(64,64) to
  bn(64,32). Because of instruction set limitations it doesn't have
  any negative impact on performance. This was done mostly in order
  to make it possible to share assembler modules, such as bn_mul_mont
  implementations, between 32- and 64-bit builds without hassle.

  _Andy Polyakov_

- Move code previously exiled into file crypto/ec/ec2_smpt.c
  to ec2_smpl.c, and no longer require the OPENSSL_EC_BIN_PT_COMP
  macro.

  _Bodo Moeller_

- New candidate for BIGNUM assembler implementation, bn_mul_mont,
  dedicated Montgomery multiplication procedure, is introduced.
  BN_MONT_CTX is modified to allow bn_mul_mont to reach for higher
  "64-bit" performance on certain 32-bit targets.

  _Andy Polyakov_

- New option SSL_OP_NO_COMP to disable use of compression selectively
  in SSL structures. New SSL ctrl to set maximum send fragment size.
  Save memory by setting the I/O buffer sizes dynamically instead of
  using the maximum available value.

  _Steve Henson_

- New option -V for 'openssl ciphers'. This prints the ciphersuite code
  in addition to the text details.

  _Bodo Moeller_

- Very, very preliminary EXPERIMENTAL support for printing of general
  ASN1 structures. This currently produces rather ugly output and doesn't
  handle several customised structures at all.

  _Steve Henson_

- Integrated support for PVK file format and some related formats such
  as MS PUBLICKEYBLOB and PRIVATEKEYBLOB. Command line switches to support
  these in the 'rsa' and 'dsa' utilities.

  _Steve Henson_

- Support for PKCS#1 RSAPublicKey format on rsa utility command line.

  _Steve Henson_

- Remove the ancient ASN1_METHOD code. This was only ever used in one
  place for the (very old) "NETSCAPE" format certificates which are now
  handled using new ASN1 code equivalents.

  _Steve Henson_

- Let the TLSv1_method() etc. functions return a 'const' SSL_METHOD
  pointer and make the SSL_METHOD parameter in SSL_CTX_new,
  SSL_CTX_set_ssl_version and SSL_set_ssl_method 'const'.

  _Nils Larsch_

- Modify CRL distribution points extension code to print out previously
  unsupported fields. Enhance extension setting code to allow setting of
  all fields.

  _Steve Henson_

- Add print and set support for Issuing Distribution Point CRL extension.

  _Steve Henson_

- Change 'Configure' script to enable Camellia by default.

  _NTT_

## OpenSSL 0.9.x

### Changes between 0.9.8m and 0.9.8n [24 Mar 2010]

- When rejecting SSL/TLS records due to an incorrect version number, never
  update s->server with a new major version number. As of
  - OpenSSL 0.9.8m if 'short' is a 16-bit type,
  - OpenSSL 0.9.8f if 'short' is longer than 16 bits,
    the previous behavior could result in a read attempt at NULL when
    receiving specific incorrect SSL/TLS records once record payload
    protection is active. ([CVE-2010-0740])

  _Bodo Moeller, Adam Langley <agl@chromium.org>_

- Fix for CVE-2010-0433 where some kerberos enabled versions of OpenSSL
  could be crashed if the relevant tables were not present (e.g. chrooted).

  _Tomas Hoger <thoger@redhat.com>_

### Changes between 0.9.8l and 0.9.8m [25 Feb 2010]

- Always check bn_wexpand() return values for failure. ([CVE-2009-3245])

  _Martin Olsson, Neel Mehta_

- Fix X509_STORE locking: Every 'objs' access requires a lock (to
  accommodate for stack sorting, always a write lock!).

  _Bodo Moeller_

- On some versions of WIN32 Heap32Next is very slow. This can cause
  excessive delays in the RAND_poll(): over a minute. As a workaround
  include a time check in the inner Heap32Next loop too.

  _Steve Henson_

- The code that handled flushing of data in SSL/TLS originally used the
  BIO_CTRL_INFO ctrl to see if any data was pending first. This caused
  the problem outlined in PR#1949. The fix suggested there however can
  trigger problems with buggy BIO_CTRL_WPENDING (e.g. some versions
  of Apache). So instead simplify the code to flush unconditionally.
  This should be fine since flushing with no data to flush is a no op.

  _Steve Henson_

- Handle TLS versions 2.0 and later properly and correctly use the
  highest version of TLS/SSL supported. Although TLS >= 2.0 is some way
  off ancient servers have a habit of sticking around for a while...

  _Steve Henson_

- Modify compression code so it frees up structures without using the
  ex_data callbacks. This works around a problem where some applications
  call CRYPTO_cleanup_all_ex_data() before application exit (e.g. when
  restarting) then use compression (e.g. SSL with compression) later.
  This results in significant per-connection memory leaks and
  has caused some security issues including CVE-2008-1678 and
  CVE-2009-4355.

  _Steve Henson_

- Constify crypto/cast (i.e., <openssl/cast.h>): a CAST_KEY doesn't
  change when encrypting or decrypting.

  _Bodo Moeller_

- Add option SSL_OP_LEGACY_SERVER_CONNECT which will allow clients to
  connect and renegotiate with servers which do not support RI.
  Until RI is more widely deployed this option is enabled by default.

  _Steve Henson_

- Add "missing" ssl ctrls to clear options and mode.

  _Steve Henson_

- If client attempts to renegotiate and doesn't support RI respond with
  a no_renegotiation alert as required by RFC5746. Some renegotiating
  TLS clients will continue a connection gracefully when they receive
  the alert. Unfortunately OpenSSL mishandled this alert and would hang
  waiting for a server hello which it will never receive. Now we treat a
  received no_renegotiation alert as a fatal error. This is because
  applications requesting a renegotiation might well expect it to succeed
  and would have no code in place to handle the server denying it so the
  only safe thing to do is to terminate the connection.

  _Steve Henson_

- Add ctrl macro SSL_get_secure_renegotiation_support() which returns 1 if
  peer supports secure renegotiation and 0 otherwise. Print out peer
  renegotiation support in s_client/s_server.

  _Steve Henson_

- Replace the highly broken and deprecated SPKAC certification method with
  the updated NID creation version. This should correctly handle UTF8.

  _Steve Henson_

- Implement RFC5746. Re-enable renegotiation but require the extension
  as needed. Unfortunately, SSL3_FLAGS_ALLOW_UNSAFE_LEGACY_RENEGOTIATION
  turns out to be a bad idea. It has been replaced by
  SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION which can be set with
  SSL_CTX_set_options(). This is really not recommended unless you
  know what you are doing.

  _Eric Rescorla <ekr@networkresonance.com>, Ben Laurie, Steve Henson_

- Fixes to stateless session resumption handling. Use initial_ctx when
  issuing and attempting to decrypt tickets in case it has changed during
  servername handling. Use a non-zero length session ID when attempting
  stateless session resumption: this makes it possible to determine if
  a resumption has occurred immediately after receiving server hello
  (several places in OpenSSL subtly assume this) instead of later in
  the handshake.

  _Steve Henson_

- The functions ENGINE_ctrl(), OPENSSL_isservice(),
  CMS_get1_RecipientRequest() and RAND_bytes() can return <=0 on error
  fixes for a few places where the return code is not checked
  correctly.

  _Julia Lawall <julia@diku.dk>_

- Add --strict-warnings option to Configure script to include devteam
  warnings in other configurations.

  _Steve Henson_

- Add support for --libdir option and LIBDIR variable in makefiles. This
  makes it possible to install openssl libraries in locations which
  have names other than "lib", for example "/usr/lib64" which some
  systems need.

  _Steve Henson, based on patch from Jeremy Utley_

- Don't allow the use of leading 0x80 in OIDs. This is a violation of
  X690 8.9.12 and can produce some misleading textual output of OIDs.

  _Steve Henson, reported by Dan Kaminsky_

- Delete MD2 from algorithm tables. This follows the recommendation in
  several standards that it is not used in new applications due to
  several cryptographic weaknesses. For binary compatibility reasons
  the MD2 API is still compiled in by default.

  _Steve Henson_

- Add compression id to {d2i,i2d}\_SSL_SESSION so it is correctly saved
  and restored.

  _Steve Henson_

- Rename uni2asc and asc2uni functions to OPENSSL_uni2asc and
  OPENSSL_asc2uni conditionally on Netware platforms to avoid a name
  clash.

  _Guenter <lists@gknw.net>_

- Fix the server certificate chain building code to use X509_verify_cert(),
  it used to have an ad-hoc builder which was unable to cope with anything
  other than a simple chain.

  _David Woodhouse <dwmw2@infradead.org>, Steve Henson_

- Don't check self signed certificate signatures in X509_verify_cert()
  by default (a flag can override this): it just wastes time without
  adding any security. As a useful side effect self signed root CAs
  with non-FIPS digests are now usable in FIPS mode.

  _Steve Henson_

- In dtls1_process_out_of_seq_message() the check if the current message
  is already buffered was missing. For every new message was memory
  allocated, allowing an attacker to perform an denial of service attack
  with sending out of seq handshake messages until there is no memory
  left. Additionally every future message was buffered, even if the
  sequence number made no sense and would be part of another handshake.
  So only messages with sequence numbers less than 10 in advance will be
  buffered. ([CVE-2009-1378])

  _Robin Seggelmann, discovered by Daniel Mentz_

- Records are buffered if they arrive with a future epoch to be
  processed after finishing the corresponding handshake. There is
  currently no limitation to this buffer allowing an attacker to perform
  a DOS attack with sending records with future epochs until there is no
  memory left. This patch adds the pqueue_size() function to determine
  the size of a buffer and limits the record buffer to 100 entries.
  ([CVE-2009-1377])

  _Robin Seggelmann, discovered by Daniel Mentz_

- Keep a copy of frag->msg_header.frag_len so it can be used after the
  parent structure is freed. ([CVE-2009-1379])

  _Daniel Mentz_

- Handle non-blocking I/O properly in SSL_shutdown() call.

  _Darryl Miles <darryl-mailinglists@netbauds.net>_

- Add `2.5.4.*` OIDs

  _Ilya O. <vrghost@gmail.com>_

### Changes between 0.9.8k and 0.9.8l [5 Nov 2009]

- Disable renegotiation completely - this fixes a severe security
  problem ([CVE-2009-3555]) at the cost of breaking all
  renegotiation. Renegotiation can be re-enabled by setting
  SSL3_FLAGS_ALLOW_UNSAFE_LEGACY_RENEGOTIATION in s3->flags at
  run-time. This is really not recommended unless you know what
  you're doing.

  _Ben Laurie_

### Changes between 0.9.8j and 0.9.8k [25 Mar 2009]

- Don't set val to NULL when freeing up structures, it is freed up by
  underlying code. If `sizeof(void *) > sizeof(long)` this can result in
  zeroing past the valid field. ([CVE-2009-0789])

  _Paolo Ganci <Paolo.Ganci@AdNovum.CH>_

- Fix bug where return value of CMS_SignerInfo_verify_content() was not
  checked correctly. This would allow some invalid signed attributes to
  appear to verify correctly. ([CVE-2009-0591])

  _Ivan Nestlerode <inestlerode@us.ibm.com>_

- Reject UniversalString and BMPString types with invalid lengths. This
  prevents a crash in ASN1_STRING_print_ex() which assumes the strings have
  a legal length. ([CVE-2009-0590])

  _Steve Henson_

- Set S/MIME signing as the default purpose rather than setting it
  unconditionally. This allows applications to override it at the store
  level.

  _Steve Henson_

- Permit restricted recursion of ASN1 strings. This is needed in practice
  to handle some structures.

  _Steve Henson_

- Improve efficiency of mem_gets: don't search whole buffer each time
  for a '\n'

  _Jeremy Shapiro <jnshapir@us.ibm.com>_

- New -hex option for openssl rand.

  _Matthieu Herrb_

- Print out UTF8String and NumericString when parsing ASN1.

  _Steve Henson_

- Support NumericString type for name components.

  _Steve Henson_

- Allow CC in the environment to override the automatically chosen
  compiler. Note that nothing is done to ensure flags work with the
  chosen compiler.

  _Ben Laurie_

### Changes between 0.9.8i and 0.9.8j [07 Jan 2009]

- Properly check EVP_VerifyFinal() and similar return values
  ([CVE-2008-5077]).

  _Ben Laurie, Bodo Moeller, Google Security Team_

- Enable TLS extensions by default.

  _Ben Laurie_

- Allow the CHIL engine to be loaded, whether the application is
  multithreaded or not. (This does not release the developer from the
  obligation to set up the dynamic locking callbacks.)

  _Sander Temme <sander@temme.net>_

- Use correct exit code if there is an error in dgst command.

  _Steve Henson; problem pointed out by Roland Dirlewanger_

- Tweak Configure so that you need to say "experimental-jpake" to enable
  JPAKE, and need to use -DOPENSSL_EXPERIMENTAL_JPAKE in applications.

  _Bodo Moeller_

- Add experimental JPAKE support, including demo authentication in
  s_client and s_server.

  _Ben Laurie_

- Set the comparison function in v3_addr_canonize().

  _Rob Austein <sra@hactrn.net>_

- Add support for XMPP STARTTLS in s_client.

  _Philip Paeps <philip@freebsd.org>_

- Change the server-side SSL_OP_NETSCAPE_REUSE_CIPHER_CHANGE_BUG behavior
  to ensure that even with this option, only ciphersuites in the
  server's preference list will be accepted. (Note that the option
  applies only when resuming a session, so the earlier behavior was
  just about the algorithm choice for symmetric cryptography.)

  _Bodo Moeller_

### Changes between 0.9.8h and 0.9.8i [15 Sep 2008]

- Fix NULL pointer dereference if a DTLS server received
  ChangeCipherSpec as first record ([CVE-2009-1386]).

  _PR #1679_

- Fix a state transition in s3*srvr.c and d1_srvr.c
  (was using SSL3_ST_CW_CLNT_HELLO_B, should be `...\_ST_SW_SRVR*...`).

  _Nagendra Modadugu_

- The fix in 0.9.8c that supposedly got rid of unsafe
  double-checked locking was incomplete for RSA blinding,
  addressing just one layer of what turns out to have been
  doubly unsafe triple-checked locking.

  So now fix this for real by retiring the MONT_HELPER macro
  in crypto/rsa/rsa_eay.c.

  _Bodo Moeller; problem pointed out by Marius Schilder_

- Various precautionary measures:
  - Avoid size_t integer overflow in HASH_UPDATE (md32_common.h).

  - Avoid a buffer overflow in d2i_SSL_SESSION() (ssl_asn1.c).
    (NB: This would require knowledge of the secret session ticket key
    to exploit, in which case you'd be SOL either way.)

  - Change bn_nist.c so that it will properly handle input BIGNUMs
    outside the expected range.

  - Enforce the 'num' check in BN_div() (bn_div.c) for non-BN_DEBUG
    builds.

  _Neel Mehta, Bodo Moeller_

- Allow engines to be "soft loaded" - i.e. optionally don't die if
  the load fails. Useful for distros.

  _Ben Laurie and the FreeBSD team_

- Add support for Local Machine Keyset attribute in PKCS#12 files.

  _Steve Henson_

- Fix BN_GF2m_mod_arr() top-bit cleanup code.

  _Huang Ying_

- Expand ENGINE to support engine supplied SSL client certificate functions.

  This work was sponsored by Logica.

  _Steve Henson_

- Add CryptoAPI ENGINE to support use of RSA and DSA keys held in Windows
  keystores. Support for SSL/TLS client authentication too.
  Not compiled unless enable-capieng specified to Configure.

  This work was sponsored by Logica.

  _Steve Henson_

- Fix bug in X509_ATTRIBUTE creation: don't set attribute using
  ASN1_TYPE_set1 if MBSTRING flag set. This bug would crash certain
  attribute creation routines such as certificate requests and PKCS#12
  files.

  _Steve Henson_

### Changes between 0.9.8g and 0.9.8h [28 May 2008]

- Fix flaw if 'Server Key exchange message' is omitted from a TLS
  handshake which could lead to a client crash as found using the
  Codenomicon TLS test suite ([CVE-2008-1672])

  _Steve Henson, Mark Cox_

- Fix double free in TLS server name extensions which could lead to
  a remote crash found by Codenomicon TLS test suite ([CVE-2008-0891])

  _Joe Orton_

- Clear error queue in SSL_CTX_use_certificate_chain_file()

  Clear the error queue to ensure that error entries left from
  older function calls do not interfere with the correct operation.

  _Lutz Jaenicke, Erik de Castro Lopo_

- Remove root CA certificates of commercial CAs:

  The OpenSSL project does not recommend any specific CA and does not
  have any policy with respect to including or excluding any CA.
  Therefore, it does not make any sense to ship an arbitrary selection
  of root CA certificates with the OpenSSL software.

  _Lutz Jaenicke_

- RSA OAEP patches to fix two separate invalid memory reads.
  The first one involves inputs when 'lzero' is greater than
  'SHA_DIGEST_LENGTH' (it would read about SHA_DIGEST_LENGTH bytes
  before the beginning of from). The second one involves inputs where
  the 'db' section contains nothing but zeroes (there is a one-byte
  invalid read after the end of 'db').

  _Ivan Nestlerode <inestlerode@us.ibm.com>_

- Partial backport from 0.9.9-dev:

  Introduce bn_mul_mont (dedicated Montgomery multiplication
  procedure) as a candidate for BIGNUM assembler implementation.
  While 0.9.9-dev uses assembler for various architectures, only
  x86_64 is available by default here in the 0.9.8 branch, and
  32-bit x86 is available through a compile-time setting.

  To try the 32-bit x86 assembler implementation, use Configure
  option "enable-montasm" (which exists only for this backport).

  As "enable-montasm" for 32-bit x86 disclaims code stability
  anyway, in this constellation we activate additional code
  backported from 0.9.9-dev for further performance improvements,
  namely BN_from_montgomery_word. (To enable this otherwise,
  e.g. x86_64, try `-DMONT_FROM_WORD___NON_DEFAULT_0_9_8_BUILD`.)

  _Andy Polyakov (backport partially by Bodo Moeller)_

- Add TLS session ticket callback. This allows an application to set
  TLS ticket cipher and HMAC keys rather than relying on hardcoded fixed
  values. This is useful for key rollover for example where several key
  sets may exist with different names.

  _Steve Henson_

- Reverse ENGINE-internal logic for caching default ENGINE handles.
  This was broken until now in 0.9.8 releases, such that the only way
  a registered ENGINE could be used (assuming it initialises
  successfully on the host) was to explicitly set it as the default
  for the relevant algorithms. This is in contradiction with 0.9.7
  behaviour and the documentation. With this fix, when an ENGINE is
  registered into a given algorithm's table of implementations, the
  'uptodate' flag is reset so that auto-discovery will be used next
  time a new context for that algorithm attempts to select an
  implementation.

  _Ian Lister (tweaked by Geoff Thorpe)_

- Backport of CMS code to OpenSSL 0.9.8. This differs from the 0.9.9
  implementation in the following ways:

  Lack of EVP_PKEY_ASN1_METHOD means algorithm parameters have to be
  hard coded.

  Lack of BER streaming support means one pass streaming processing is
  only supported if data is detached: setting the streaming flag is
  ignored for embedded content.

  CMS support is disabled by default and must be explicitly enabled
  with the enable-cms configuration option.

  _Steve Henson_

- Update the GMP engine glue to do direct copies between BIGNUM and
  mpz_t when openssl and GMP use the same limb size. Otherwise the
  existing "conversion via a text string export" trick is still used.

  _Paul Sheer <paulsheer@gmail.com>_

- Zlib compression BIO. This is a filter BIO which compressed and
  uncompresses any data passed through it.

  _Steve Henson_

- Add AES_wrap_key() and AES_unwrap_key() functions to implement
  RFC3394 compatible AES key wrapping.

  _Steve Henson_

- Add utility functions to handle ASN1 structures. ASN1_STRING_set0():
  sets string data without copying. X509_ALGOR_set0() and
  X509_ALGOR_get0(): set and retrieve X509_ALGOR (AlgorithmIdentifier)
  data. Attribute function X509at_get0_data_by_OBJ(): retrieves data
  from an X509_ATTRIBUTE structure optionally checking it occurs only
  once. ASN1_TYPE_set1(): set and ASN1_TYPE structure copying supplied
  data.

  _Steve Henson_

- Fix BN flag handling in RSA_eay_mod_exp() and BN_MONT_CTX_set()
  to get the expected BN_FLG_CONSTTIME behavior.

  _Bodo Moeller (Google)_

- Netware support:
  - fixed wrong usage of ioctlsocket() when build for LIBC BSD sockets
  - fixed do_tests.pl to run the test suite with CLIB builds too (CLIB_OPT)
  - added some more tests to do_tests.pl
  - fixed RunningProcess usage so that it works with newer LIBC NDKs too
  - removed usage of BN_LLONG for CLIB builds to avoid runtime dependency
  - added new Configure targets netware-clib-bsdsock, netware-clib-gcc,
    netware-clib-bsdsock-gcc, netware-libc-bsdsock-gcc
  - various changes to netware.pl to enable gcc-cross builds on Win32
    platform
  - changed crypto/bio/b_sock.c to work with macro functions (CLIB BSD)
  - various changes to fix missing prototype warnings
  - fixed x86nasm.pl to create correct asm files for NASM COFF output
  - added AES, WHIRLPOOL and CPUID assembler code to build files
  - added missing AES assembler make rules to mk1mf.pl
  - fixed order of includes in `apps/ocsp.c` so that `e_os.h` settings apply

  _Guenter Knauf <eflash@gmx.net>_

- Implement certificate status request TLS extension defined in RFC3546.
  A client can set the appropriate parameters and receive the encoded
  OCSP response via a callback. A server can query the supplied parameters
  and set the encoded OCSP response in the callback. Add simplified examples
  to s_client and s_server.

  _Steve Henson_

### Changes between 0.9.8f and 0.9.8g [19 Oct 2007]

- Fix various bugs:
  - Binary incompatibility of ssl_ctx_st structure
  - DTLS interoperation with non-compliant servers
  - Don't call get_session_cb() without proposed session
  - Fix ia64 assembler code

  _Andy Polyakov, Steve Henson_

### Changes between 0.9.8e and 0.9.8f [11 Oct 2007]

- DTLS Handshake overhaul. There were longstanding issues with
  OpenSSL DTLS implementation, which were making it impossible for
  RFC 4347 compliant client to communicate with OpenSSL server.
  Unfortunately just fixing these incompatibilities would "cut off"
  pre-0.9.8f clients. To allow for hassle free upgrade post-0.9.8e
  server keeps tolerating non RFC compliant syntax. The opposite is
  not true, 0.9.8f client can not communicate with earlier server.
  This update even addresses CVE-2007-4995.

  _Andy Polyakov_

- Changes to avoid need for function casts in OpenSSL: some compilers
  (gcc 4.2 and later) reject their use.
  _Kurt Roeckx <kurt@roeckx.be>, Peter Hartley <pdh@utter.chaos.org.uk>,
  Steve Henson_

- Add RFC4507 support to OpenSSL. This includes the corrections in
  RFC4507bis. The encrypted ticket format is an encrypted encoded
  SSL_SESSION structure, that way new session features are automatically
  supported.

  If a client application caches session in an SSL_SESSION structure
  support is transparent because tickets are now stored in the encoded
  SSL_SESSION.

  The SSL_CTX structure automatically generates keys for ticket
  protection in servers so again support should be possible
  with no application modification.

  If a client or server wishes to disable RFC4507 support then the option
  SSL_OP_NO_TICKET can be set.

  Add a TLS extension debugging callback to allow the contents of any client
  or server extensions to be examined.

  This work was sponsored by Google.

  _Steve Henson_

- Add initial support for TLS extensions, specifically for the server_name
  extension so far. The SSL_SESSION, SSL_CTX, and SSL data structures now
  have new members for a hostname. The SSL data structure has an
  additional member `SSL_CTX *initial_ctx` so that new sessions can be
  stored in that context to allow for session resumption, even after the
  SSL has been switched to a new SSL_CTX in reaction to a client's
  server_name extension.

  New functions (subject to change):

          SSL_get_servername()
          SSL_get_servername_type()
          SSL_set_SSL_CTX()

  New CTRL codes and macros (subject to change):

          SSL_CTRL_SET_TLSEXT_SERVERNAME_CB
                              - SSL_CTX_set_tlsext_servername_callback()
          SSL_CTRL_SET_TLSEXT_SERVERNAME_ARG
                                   - SSL_CTX_set_tlsext_servername_arg()
          SSL_CTRL_SET_TLSEXT_HOSTNAME           - SSL_set_tlsext_host_name()

  openssl s_client has a new '-servername ...' option.

  openssl s_server has new options '-servername_host ...', '-cert2 ...',
  '-key2 ...', '-servername_fatal' (subject to change). This allows
  testing the HostName extension for a specific single hostname ('-cert'
  and '-key' remain fallbacks for handshakes without HostName
  negotiation). If the unrecognized_name alert has to be sent, this by
  default is a warning; it becomes fatal with the '-servername_fatal'
  option.

  _Peter Sylvester, Remy Allais, Christophe Renou, Steve Henson_

- Add AES and SSE2 assembly language support to VC++ build.

  _Steve Henson_

- Mitigate attack on final subtraction in Montgomery reduction.

  _Andy Polyakov_

- Fix crypto/ec/ec_mult.c to work properly with scalars of value 0
  (which previously caused an internal error).

  _Bodo Moeller_

- Squeeze another 10% out of IGE mode when in != out.

  _Ben Laurie_

- AES IGE mode speedup.

  _Dean Gaudet (Google)_

- Add the Korean symmetric 128-bit cipher SEED (see
  <http://www.kisa.or.kr/kisa/seed/jsp/seed_eng.jsp>) and
  add SEED ciphersuites from RFC 4162:

          TLS_RSA_WITH_SEED_CBC_SHA      =  "SEED-SHA"
          TLS_DHE_DSS_WITH_SEED_CBC_SHA  =  "DHE-DSS-SEED-SHA"
          TLS_DHE_RSA_WITH_SEED_CBC_SHA  =  "DHE-RSA-SEED-SHA"
          TLS_DH_anon_WITH_SEED_CBC_SHA  =  "ADH-SEED-SHA"

  To minimize changes between patchlevels in the OpenSSL 0.9.8
  series, SEED remains excluded from compilation unless OpenSSL
  is configured with 'enable-seed'.

  _KISA, Bodo Moeller_

- Mitigate branch prediction attacks, which can be practical if a
  single processor is shared, allowing a spy process to extract
  information. For detailed background information, see
  <http://eprint.iacr.org/2007/039> (O. Aciicmez, S. Gueron,
  J.-P. Seifert, "New Branch Prediction Vulnerabilities in OpenSSL
  and Necessary Software Countermeasures"). The core of the change
  are new versions BN_div_no_branch() and
  BN_mod_inverse_no_branch() of BN_div() and BN_mod_inverse(),
  respectively, which are slower, but avoid the security-relevant
  conditional branches. These are automatically called by BN_div()
  and BN_mod_inverse() if the flag BN_FLG_CONSTTIME is set for one
  of the input BIGNUMs. Also, BN_is_bit_set() has been changed to
  remove a conditional branch.

  BN_FLG_CONSTTIME is the new name for the previous
  BN_FLG_EXP_CONSTTIME flag, since it now affects more than just
  modular exponentiation. (Since OpenSSL 0.9.7h, setting this flag
  in the exponent causes BN_mod_exp_mont() to use the alternative
  implementation in BN_mod_exp_mont_consttime().) The old name
  remains as a deprecated alias.

  Similarly, RSA_FLAG_NO_EXP_CONSTTIME is replaced by a more general
  RSA_FLAG_NO_CONSTTIME flag since the RSA implementation now uses
  constant-time implementations for more than just exponentiation.
  Here too the old name is kept as a deprecated alias.

  BN_BLINDING_new() will now use BN_dup() for the modulus so that
  the BN_BLINDING structure gets an independent copy of the
  modulus. This means that the previous `BIGNUM *m` argument to
  BN_BLINDING_new() and to BN_BLINDING_create_param() now
  essentially becomes `const BIGNUM *m`, although we can't actually
  change this in the header file before 0.9.9. It allows
  RSA_setup_blinding() to use BN_with_flags() on the modulus to
  enable BN_FLG_CONSTTIME.

  _Matthew D Wood (Intel Corp)_

- In the SSL/TLS server implementation, be strict about session ID
  context matching (which matters if an application uses a single
  external cache for different purposes). Previously,
  out-of-context reuse was forbidden only if SSL_VERIFY_PEER was
  set. This did ensure strict client verification, but meant that,
  with applications using a single external cache for quite
  different requirements, clients could circumvent ciphersuite
  restrictions for a given session ID context by starting a session
  in a different context.

  _Bodo Moeller_

- Include "!eNULL" in SSL_DEFAULT_CIPHER_LIST to make sure that
  a ciphersuite string such as "DEFAULT:RSA" cannot enable
  authentication-only ciphersuites.

  _Bodo Moeller_

- Update the SSL_get_shared_ciphers() fix CVE-2006-3738 which was
  not complete and could lead to a possible single byte overflow
  ([CVE-2007-5135]) [Ben Laurie]

### Changes between 0.9.8d and 0.9.8e [23 Feb 2007]

- Since AES128 and AES256 (and similarly Camellia128 and
  Camellia256) share a single mask bit in the logic of
  ssl/ssl_ciph.c, the code for masking out disabled ciphers needs a
  kludge to work properly if AES128 is available and AES256 isn't
  (or if Camellia128 is available and Camellia256 isn't).

  _Victor Duchovni_

- Fix the BIT STRING encoding generated by crypto/ec/ec_asn1.c
  (within i2d_ECPrivateKey, i2d_ECPKParameters, i2d_ECParameters):
  When a point or a seed is encoded in a BIT STRING, we need to
  prevent the removal of trailing zero bits to get the proper DER
  encoding. (By default, crypto/asn1/a_bitstr.c assumes the case
  of a NamedBitList, for which trailing 0 bits need to be removed.)

  _Bodo Moeller_

- Have SSL/TLS server implementation tolerate "mismatched" record
  protocol version while receiving ClientHello even if the
  ClientHello is fragmented. (The server can't insist on the
  particular protocol version it has chosen before the ServerHello
  message has informed the client about his choice.)

  _Bodo Moeller_

- Add RFC 3779 support.

  _Rob Austein for ARIN, Ben Laurie_

- Load error codes if they are not already present instead of using a
  static variable. This allows them to be cleanly unloaded and reloaded.
  Improve header file function name parsing.

  _Steve Henson_

- extend SMTP and IMAP protocol emulation in s_client to use EHLO
  or CAPABILITY handshake as required by RFCs.

  _Goetz Babin-Ebell_

### Changes between 0.9.8c and 0.9.8d [28 Sep 2006]

- Introduce limits to prevent malicious keys being able to
  cause a denial of service. ([CVE-2006-2940])

  _Steve Henson, Bodo Moeller_

- Fix ASN.1 parsing of certain invalid structures that can result
  in a denial of service. ([CVE-2006-2937]) [Steve Henson]

- Fix buffer overflow in SSL_get_shared_ciphers() function.
  ([CVE-2006-3738]) [Tavis Ormandy and Will Drewry, Google Security Team]

- Fix SSL client code which could crash if connecting to a
  malicious SSLv2 server. ([CVE-2006-4343])

  _Tavis Ormandy and Will Drewry, Google Security Team_

- Since 0.9.8b, ciphersuite strings naming explicit ciphersuites
  match only those. Before that, "AES256-SHA" would be interpreted
  as a pattern and match "AES128-SHA" too (since AES128-SHA got
  the same strength classification in 0.9.7h) as we currently only
  have a single AES bit in the ciphersuite description bitmap.
  That change, however, also applied to ciphersuite strings such as
  "RC4-MD5" that intentionally matched multiple ciphersuites --
  namely, SSL 2.0 ciphersuites in addition to the more common ones
  from SSL 3.0/TLS 1.0.

  So we change the selection algorithm again: Naming an explicit
  ciphersuite selects this one ciphersuite, and any other similar
  ciphersuite (same bitmap) from _other_ protocol versions.
  Thus, "RC4-MD5" again will properly select both the SSL 2.0
  ciphersuite and the SSL 3.0/TLS 1.0 ciphersuite.

  Since SSL 2.0 does not have any ciphersuites for which the
  128/256 bit distinction would be relevant, this works for now.
  The proper fix will be to use different bits for AES128 and
  AES256, which would have avoided the problems from the beginning;
  however, bits are scarce, so we can only do this in a new release
  (not just a patchlevel) when we can change the SSL_CIPHER
  definition to split the single 'unsigned long mask' bitmap into
  multiple values to extend the available space.

  _Bodo Moeller_

### Changes between 0.9.8b and 0.9.8c [05 Sep 2006]

- Avoid PKCS #1 v1.5 signature attack discovered by Daniel Bleichenbacher
  ([CVE-2006-4339]) [Ben Laurie and Google Security Team]

- Add AES IGE and biIGE modes.

  _Ben Laurie_

- Change the Unix randomness entropy gathering to use poll() when
  possible instead of select(), since the latter has some
  undesirable limitations.

  _Darryl Miles via Richard Levitte and Bodo Moeller_

- Disable "ECCdraft" ciphersuites more thoroughly. Now special
  treatment in ssl/ssl_ciph.s makes sure that these ciphersuites
  cannot be implicitly activated as part of, e.g., the "AES" alias.
  However, please upgrade to OpenSSL 0.9.9[-dev] for
  non-experimental use of the ECC ciphersuites to get TLS extension
  support, which is required for curve and point format negotiation
  to avoid potential handshake problems.

  _Bodo Moeller_

- Disable rogue ciphersuites:
  - SSLv2 0x08 0x00 0x80 ("RC4-64-MD5")
  - SSLv3/TLSv1 0x00 0x61 ("EXP1024-RC2-CBC-MD5")
  - SSLv3/TLSv1 0x00 0x60 ("EXP1024-RC4-MD5")

  The latter two were purportedly from
  draft-ietf-tls-56-bit-ciphersuites-0[01].txt, but do not really
  appear there.

  Also deactivate the remaining ciphersuites from
  draft-ietf-tls-56-bit-ciphersuites-01.txt. These are just as
  unofficial, and the ID has long expired.

  _Bodo Moeller_

- Fix RSA blinding Heisenbug (problems sometimes occurred on
  dual-core machines) and other potential thread-safety issues.

  _Bodo Moeller_

- Add the symmetric cipher Camellia (128-bit, 192-bit, 256-bit key
  versions), which is now available for royalty-free use
  (see <http://info.isl.ntt.co.jp/crypt/eng/info/chiteki.html>).
  Also, add Camellia TLS ciphersuites from RFC 4132.

  To minimize changes between patchlevels in the OpenSSL 0.9.8
  series, Camellia remains excluded from compilation unless OpenSSL
  is configured with 'enable-camellia'.

  _NTT_

- Disable the padding bug check when compression is in use. The padding
  bug check assumes the first packet is of even length, this is not
  necessarily true if compression is enabled and can result in false
  positives causing handshake failure. The actual bug test is ancient
  code so it is hoped that implementations will either have fixed it by
  now or any which still have the bug do not support compression.

  _Steve Henson_

### Changes between 0.9.8a and 0.9.8b [04 May 2006]

- When applying a cipher rule check to see if string match is an explicit
  cipher suite and only match that one cipher suite if it is.

  _Steve Henson_

- Link in manifests for VC++ if needed.

  _Austin Ziegler <halostatue@gmail.com>_

- Update support for ECC-based TLS ciphersuites according to
  draft-ietf-tls-ecc-12.txt with proposed changes (but without
  TLS extensions, which are supported starting with the 0.9.9
  branch, not in the OpenSSL 0.9.8 branch).

  _Douglas Stebila_

- New functions EVP_CIPHER_CTX_new() and EVP_CIPHER_CTX_free() to support
  opaque EVP_CIPHER_CTX handling.

  _Steve Henson_

- Fixes and enhancements to zlib compression code. We now only use
  "zlib1.dll" and use the default `__cdecl` calling convention on Win32
  to conform with the standards mentioned here:
  <http://www.zlib.net/DLL_FAQ.txt>
  Static zlib linking now works on Windows and the new --with-zlib-include
  --with-zlib-lib options to Configure can be used to supply the location
  of the headers and library. Gracefully handle case where zlib library
  can't be loaded.

  _Steve Henson_

- Several fixes and enhancements to the OID generation code. The old code
  sometimes allowed invalid OIDs (1.X for X >= 40 for example), couldn't
  handle numbers larger than ULONG_MAX, truncated printing and had a
  non standard OBJ_obj2txt() behaviour.

  _Steve Henson_

- Add support for building of engines under engine/ as shared libraries
  under VC++ build system.

  _Steve Henson_

- Corrected the numerous bugs in the Win32 path splitter in DSO.
  Hopefully, we will not see any false combination of paths any more.

  _Richard Levitte_

### Changes between 0.9.8 and 0.9.8a [11 Oct 2005]

- Remove the functionality of SSL_OP_MSIE_SSLV2_RSA_PADDING
  (part of SSL_OP_ALL). This option used to disable the
  countermeasure against man-in-the-middle protocol-version
  rollback in the SSL 2.0 server implementation, which is a bad
  idea. ([CVE-2005-2969])

  _Bodo Moeller; problem pointed out by Yutaka Oiwa (Research Center
  for Information Security, National Institute of Advanced Industrial
  Science and Technology [AIST], Japan)_

- Add two function to clear and return the verify parameter flags.

  _Steve Henson_

- Keep cipherlists sorted in the source instead of sorting them at
  runtime, thus removing the need for a lock.

  _Nils Larsch_

- Avoid some small subgroup attacks in Diffie-Hellman.

  _Nick Mathewson and Ben Laurie_

- Add functions for well-known primes.

  _Nick Mathewson_

- Extended Windows CE support.

  _Satoshi Nakamura and Andy Polyakov_

- Initialize SSL_METHOD structures at compile time instead of during
  runtime, thus removing the need for a lock.

  _Steve Henson_

- Make PKCS7_decrypt() work even if no certificate is supplied by
  attempting to decrypt each encrypted key in turn. Add support to
  smime utility.

  _Steve Henson_

### Changes between 0.9.7h and 0.9.8 [05 Jul 2005]

[NB: OpenSSL 0.9.7i and later 0.9.7 patch levels were released after
OpenSSL 0.9.8.]

- Add libcrypto.pc and libssl.pc for those who feel they need them.

  _Richard Levitte_

- Change CA.sh and CA.pl so they don't bundle the CSR and the private
  key into the same file any more.

  _Richard Levitte_

- Add initial support for Win64, both IA64 and AMD64/x64 flavors.

  _Andy Polyakov_

- Add -utf8 command line and config file option to 'ca'.

  _Stefan <stf@udoma.org_

- Removed the macro des_crypt(), as it seems to conflict with some
  libraries. Use DES_crypt().

  _Richard Levitte_

- Correct naming of the 'chil' and '4758cca' ENGINEs. This
  involves renaming the source and generated shared-libs for
  both. The engines will accept the corrected or legacy ids
  ('ncipher' and '4758_cca' respectively) when binding. NB,
  this only applies when building 'shared'.

  _Corinna Vinschen <vinschen@redhat.com> and Geoff Thorpe_

- Add attribute functions to EVP_PKEY structure. Modify
  PKCS12_create() to recognize a CSP name attribute and
  use it. Make -CSP option work again in pkcs12 utility.

  _Steve Henson_

- Add new functionality to the bn blinding code:
  - automatic re-creation of the BN_BLINDING parameters after
    a fixed number of uses (currently 32)
  - add new function for parameter creation
  - introduce flags to control the update behaviour of the
    BN_BLINDING parameters
  - hide BN_BLINDING structure
    Add a second BN_BLINDING slot to the RSA structure to improve
    performance when a single RSA object is shared among several
    threads.

  _Nils Larsch_

- Add support for DTLS.

  _Nagendra Modadugu <nagendra@cs.stanford.edu> and Ben Laurie_

- Add support for DER encoded private keys (SSL_FILETYPE_ASN1)
  to SSL_CTX_use_PrivateKey_file() and SSL_use_PrivateKey_file()

  _Walter Goulet_

- Remove buggy and incomplete DH cert support from
  ssl/ssl_rsa.c and ssl/s3_both.c

  _Nils Larsch_

- Use SHA-1 instead of MD5 as the default digest algorithm for
  the `apps/openssl` commands.

  _Nils Larsch_

- Compile clean with "-Wall -Wmissing-prototypes
  -Wstrict-prototypes -Wmissing-declarations -Werror". Currently
  DEBUG_SAFESTACK must also be set.

  _Ben Laurie_

- Change ./Configure so that certain algorithms can be disabled by default.
  The new counterpiece to "no-xxx" is "enable-xxx".

  The patented RC5 and MDC2 algorithms will now be disabled unless
  "enable-rc5" and "enable-mdc2", respectively, are specified.

  (IDEA remains enabled despite being patented. This is because IDEA
  is frequently required for interoperability, and there is no license
  fee for non-commercial use. As before, "no-idea" can be used to
  avoid this algorithm.)

  _Bodo Moeller_

- Add processing of proxy certificates (see RFC 3820). This work was
  sponsored by KTH (The Royal Institute of Technology in Stockholm) and
  EGEE (Enabling Grids for E-science in Europe).

  _Richard Levitte_

- RC4 performance overhaul on modern architectures/implementations, such
  as Intel P4, IA-64 and AMD64.

  _Andy Polyakov_

- New utility extract-section.pl. This can be used specify an alternative
  section number in a pod file instead of having to treat each file as
  a separate case in Makefile. This can be done by adding two lines to the
  pod file:

  =for comment openssl_section:XXX

  The blank line is mandatory.

  _Steve Henson_

- New arguments -certform, -keyform and -pass for s_client and s_server
  to allow alternative format key and certificate files and passphrase
  sources.

  _Steve Henson_

- New structure X509_VERIFY_PARAM which combines current verify parameters,
  update associated structures and add various utility functions.

  Add new policy related verify parameters, include policy checking in
  standard verify code. Enhance 'smime' application with extra parameters
  to support policy checking and print out.

  _Steve Henson_

- Add a new engine to support VIA PadLock ACE extensions in the VIA C3
  Nehemiah processors. These extensions support AES encryption in hardware
  as well as RNG (though RNG support is currently disabled).

  _Michal Ludvig <michal@logix.cz>, with help from Andy Polyakov_

- Deprecate `BN_[get|set]_params()` functions (they were ignored internally).

  _Geoff Thorpe_

- New FIPS 180-2 algorithms, SHA-224/-256/-384/-512 are implemented.

  _Andy Polyakov and a number of other people_

- Improved PowerPC platform support. Most notably BIGNUM assembler
  implementation contributed by IBM.

  _Suresh Chari, Peter Waltenberg, Andy Polyakov_

- The new 'RSA_generate_key_ex' function now takes a BIGNUM for the public
  exponent rather than 'unsigned long'. There is a corresponding change to
  the new 'rsa_keygen' element of the RSA_METHOD structure.

  _Jelte Jansen, Geoff Thorpe_

- Functionality for creating the initial serial number file is now
  moved from CA.pl to the 'ca' utility with a new option -create_serial.

  (Before OpenSSL 0.9.7e, CA.pl used to initialize the serial
  number file to 1, which is bound to cause problems. To avoid
  the problems while respecting compatibility between different 0.9.7
  patchlevels, 0.9.7e employed 'openssl x509 -next_serial' in
  CA.pl for serial number initialization. With the new release 0.9.8,
  we can fix the problem directly in the 'ca' utility.)

  _Steve Henson_

- Reduced header interdependencies by declaring more opaque objects in
  ossl_typ.h. As a consequence, including some headers (eg. engine.h) will
  give fewer recursive includes, which could break lazy source code - so
  this change is covered by the OPENSSL_NO_DEPRECATED symbol. As always,
  developers should define this symbol when building and using openssl to
  ensure they track the recommended behaviour, interfaces, [etc], but
  backwards-compatible behaviour prevails when this isn't defined.

  _Geoff Thorpe_

- New function X509_POLICY_NODE_print() which prints out policy nodes.

  _Steve Henson_

- Add new EVP function EVP_CIPHER_CTX_rand_key and associated functionality.
  This will generate a random key of the appropriate length based on the
  cipher context. The EVP_CIPHER can provide its own random key generation
  routine to support keys of a specific form. This is used in the des and
  3des routines to generate a key of the correct parity. Update S/MIME
  code to use new functions and hence generate correct parity DES keys.
  Add EVP_CHECK_DES_KEY #define to return an error if the key is not
  valid (weak or incorrect parity).

  _Steve Henson_

- Add a local set of CRLs that can be used by X509_verify_cert() as well
  as looking them up. This is useful when the verified structure may contain
  CRLs, for example PKCS#7 signedData. Modify PKCS7_verify() to use any CRLs
  present unless the new PKCS7_NO_CRL flag is asserted.

  _Steve Henson_

- Extend ASN1 oid configuration module. It now additionally accepts the
  syntax:

  shortName = some long name, 1.2.3.4

  _Steve Henson_

- Reimplemented the BN_CTX implementation. There is now no more static
  limitation on the number of variables it can handle nor the depth of the
  "stack" handling for BN_CTX_start()/BN_CTX_end() pairs. The stack
  information can now expand as required, and rather than having a single
  static array of bignums, BN_CTX now uses a linked-list of such arrays
  allowing it to expand on demand whilst maintaining the usefulness of
  BN_CTX's "bundling".

  _Geoff Thorpe_

- Add a missing BN_CTX parameter to the 'rsa_mod_exp' callback in RSA_METHOD
  to allow all RSA operations to function using a single BN_CTX.

  _Geoff Thorpe_

- Preliminary support for certificate policy evaluation and checking. This
  is initially intended to pass the tests outlined in "Conformance Testing
  of Relying Party Client Certificate Path Processing Logic" v1.07.

  _Steve Henson_

- bn_dup_expand() has been deprecated, it was introduced in 0.9.7 and
  remained unused and not that useful. A variety of other little bignum
  tweaks and fixes have also been made continuing on from the audit (see
  below).

  _Geoff Thorpe_

- Constify all or almost all d2i, c2i, s2i and r2i functions, along with
  associated ASN1, EVP and SSL functions and old ASN1 macros.

  _Richard Levitte_

- BN_zero() only needs to set 'top' and 'neg' to zero for correct results,
  and this should never fail. So the return value from the use of
  BN_set_word() (which can fail due to needless expansion) is now deprecated;
  if OPENSSL_NO_DEPRECATED is defined, BN_zero() is a void macro.

  _Geoff Thorpe_

- BN_CTX_get() should return zero-valued bignums, providing the same
  initialised value as BN_new().

  _Geoff Thorpe, suggested by Ulf Möller_

- Support for inhibitAnyPolicy certificate extension.

  _Steve Henson_

- An audit of the BIGNUM code is underway, for which debugging code is
  enabled when BN_DEBUG is defined. This makes stricter enforcements on what
  is considered valid when processing BIGNUMs, and causes execution to
  assert() when a problem is discovered. If BN_DEBUG_RAND is defined,
  further steps are taken to deliberately pollute unused data in BIGNUM
  structures to try and expose faulty code further on. For now, openssl will
  (in its default mode of operation) continue to tolerate the inconsistent
  forms that it has tolerated in the past, but authors and packagers should
  consider trying openssl and their own applications when compiled with
  these debugging symbols defined. It will help highlight potential bugs in
  their own code, and will improve the test coverage for OpenSSL itself. At
  some point, these tighter rules will become openssl's default to improve
  maintainability, though the assert()s and other overheads will remain only
  in debugging configurations. See bn.h for more details.

  _Geoff Thorpe, Nils Larsch, Ulf Möller_

- BN_CTX_init() has been deprecated, as BN_CTX is an opaque structure
  that can only be obtained through BN_CTX_new() (which implicitly
  initialises it). The presence of this function only made it possible
  to overwrite an existing structure (and cause memory leaks).

  _Geoff Thorpe_

- Because of the callback-based approach for implementing LHASH as a
  template type, lh_insert() adds opaque objects to hash-tables and
  lh_doall() or lh_doall_arg() are typically used with a destructor callback
  to clean up those corresponding objects before destroying the hash table
  (and losing the object pointers). So some over-zealous constifications in
  LHASH have been relaxed so that lh_insert() does not take (nor store) the
  objects as "const" and the `lh_doall[_arg]` callback wrappers are not
  prototyped to have "const" restrictions on the object pointers they are
  given (and so aren't required to cast them away any more).

  _Geoff Thorpe_

- The tmdiff.h API was so ugly and minimal that our own timing utility
  (speed) prefers to use its own implementation. The two implementations
  haven't been consolidated as yet (volunteers?) but the tmdiff API has had
  its object type properly exposed (MS*TM) instead of casting to/from
  `char *`. This may still change yet if someone realises MS_TM and
`ms_time\*\*\*\*`
  aren't necessarily the greatest nomenclatures - but this is what was used
  internally to the implementation so I've used that for now.

  _Geoff Thorpe_

- Ensure that deprecated functions do not get compiled when
  OPENSSL_NO_DEPRECATED is defined. Some "openssl" subcommands and a few of
  the self-tests were still using deprecated key-generation functions so
  these have been updated also.

  _Geoff Thorpe_

- Reorganise PKCS#7 code to separate the digest location functionality
  into PKCS7_find_digest(), digest addition into PKCS7_bio_add_digest().
  New function PKCS7_set_digest() to set the digest type for PKCS#7
  digestedData type. Add additional code to correctly generate the
  digestedData type and add support for this type in PKCS7 initialization
  functions.

  _Steve Henson_

- New function PKCS7_set0_type_other() this initializes a PKCS7
  structure of type "other".

  _Steve Henson_

- Fix prime generation loop in crypto/bn/bn_prime.pl by making
  sure the loop does correctly stop and breaking ("division by zero")
  modulus operations are not performed. The (pre-generated) prime
  table crypto/bn/bn_prime.h was already correct, but it could not be
  re-generated on some platforms because of the "division by zero"
  situation in the script.

  _Ralf S. Engelschall_

- Update support for ECC-based TLS ciphersuites according to
  draft-ietf-tls-ecc-03.txt: the KDF1 key derivation function with
  SHA-1 now is only used for "small" curves (where the
  representation of a field element takes up to 24 bytes); for
  larger curves, the field element resulting from ECDH is directly
  used as premaster secret.

  _Douglas Stebila (Sun Microsystems Laboratories)_

- Add code for kP+lQ timings to crypto/ec/ectest.c, and add SEC2
  curve secp160r1 to the tests.

  _Douglas Stebila (Sun Microsystems Laboratories)_

- Add the possibility to load symbols globally with DSO.

  _Götz Babin-Ebell <babin-ebell@trustcenter.de> via Richard Levitte_

- Add the functions ERR_set_mark() and ERR_pop_to_mark() for better
  control of the error stack.

  _Richard Levitte_

- Add support for STORE in ENGINE.

  _Richard Levitte_

- Add the STORE type. The intention is to provide a common interface
  to certificate and key stores, be they simple file-based stores, or
  HSM-type store, or LDAP stores, or...
  NOTE: The code is currently UNTESTED and isn't really used anywhere.

  _Richard Levitte_

- Add a generic structure called OPENSSL_ITEM. This can be used to
  pass a list of arguments to any function as well as provide a way
  for a function to pass data back to the caller.

  _Richard Levitte_

- Add the functions BUF_strndup() and BUF_memdup(). BUF_strndup()
  works like BUF_strdup() but can be used to duplicate a portion of
  a string. The copy gets NUL-terminated. BUF_memdup() duplicates
  a memory area.

  _Richard Levitte_

- Add the function sk_find_ex() which works like sk_find(), but will
  return an index to an element even if an exact match couldn't be
  found. The index is guaranteed to point at the element where the
  searched-for key would be inserted to preserve sorting order.

  _Richard Levitte_

- Add the function OBJ_bsearch_ex() which works like OBJ_bsearch() but
  takes an extra flags argument for optional functionality. Currently,
  the following flags are defined:

  OBJ_BSEARCH_VALUE_ON_NOMATCH
  This one gets OBJ_bsearch_ex() to return a pointer to the first
  element where the comparing function returns a negative or zero
  number.

  OBJ_BSEARCH_FIRST_VALUE_ON_MATCH
  This one gets OBJ_bsearch_ex() to return a pointer to the first
  element where the comparing function returns zero. This is useful
  if there are more than one element where the comparing function
  returns zero.

  _Richard Levitte_

- Make it possible to create self-signed certificates with 'openssl ca'
  in such a way that the self-signed certificate becomes part of the
  CA database and uses the same mechanisms for serial number generation
  as all other certificate signing. The new flag '-selfsign' enables
  this functionality. Adapt CA.sh and CA.pl.in.

  _Richard Levitte_

- Add functionality to check the public key of a certificate request
  against a given private. This is useful to check that a certificate
  request can be signed by that key (self-signing).

  _Richard Levitte_

- Make it possible to have multiple active certificates with the same
  subject in the CA index file. This is done only if the keyword
  'unique_subject' is set to 'no' in the main CA section (default
  if 'CA_default') of the configuration file. The value is saved
  with the database itself in a separate index attribute file,
  named like the index file with '.attr' appended to the name.

  _Richard Levitte_

- Generate multi-valued AVAs using '+' notation in config files for
  req and dirName.

  _Steve Henson_

- Support for nameConstraints certificate extension.

  _Steve Henson_

- Support for policyConstraints certificate extension.

  _Steve Henson_

- Support for policyMappings certificate extension.

  _Steve Henson_

- Make sure the default DSA_METHOD implementation only uses its
  dsa_mod_exp() and/or bn_mod_exp() handlers if they are non-NULL,
  and change its own handlers to be NULL so as to remove unnecessary
  indirection. This lets alternative implementations fallback to the
  default implementation more easily.

  _Geoff Thorpe_

- Support for directoryName in GeneralName related extensions
  in config files.

  _Steve Henson_

- Make it possible to link applications using Makefile.shared.
  Make that possible even when linking against static libraries!

  _Richard Levitte_

- Support for single pass processing for S/MIME signing. This now
  means that S/MIME signing can be done from a pipe, in addition
  cleartext signing (multipart/signed type) is effectively streaming
  and the signed data does not need to be all held in memory.

  This is done with a new flag PKCS7_STREAM. When this flag is set
  PKCS7_sign() only initializes the PKCS7 structure and the actual signing
  is done after the data is output (and digests calculated) in
  SMIME_write_PKCS7().

  _Steve Henson_

- Add full support for -rpath/-R, both in shared libraries and
  applications, at least on the platforms where it's known how
  to do it.

  _Richard Levitte_

- In crypto/ec/ec_mult.c, implement fast point multiplication with
  precomputation, based on wNAF splitting: EC_GROUP_precompute_mult()
  will now compute a table of multiples of the generator that
  makes subsequent invocations of EC_POINTs_mul() or EC_POINT_mul()
  faster (notably in the case of a single point multiplication,
  scalar \* generator).

  _Nils Larsch, Bodo Moeller_

- IPv6 support for certificate extensions. The various extensions
  which use the IP:a.b.c.d can now take IPv6 addresses using the
  formats of RFC1884 2.2 . IPv6 addresses are now also displayed
  correctly.

  _Steve Henson_

- Added an ENGINE that implements RSA by performing private key
  exponentiations with the GMP library. The conversions to and from
  GMP's mpz_t format aren't optimised nor are any montgomery forms
  cached, and on x86 it appears OpenSSL's own performance has caught up.
  However there are likely to be other architectures where GMP could
  provide a boost. This ENGINE is not built in by default, but it can be
  specified at Configure time and should be accompanied by the necessary
  linker additions, eg;
  ./config -DOPENSSL_USE_GMP -lgmp

  _Geoff Thorpe_

- "openssl engine" will not display ENGINE/DSO load failure errors when
  testing availability of engines with "-t" - the old behaviour is
  produced by increasing the feature's verbosity with "-tt".

  _Geoff Thorpe_

- ECDSA routines: under certain error conditions uninitialized BN objects
  could be freed. Solution: make sure initialization is performed early
  enough. (Reported and fix supplied by Nils Larsch <nla@trustcenter.de>
  via PR#459)

  _Lutz Jaenicke_

- Key-generation can now be implemented in RSA_METHOD, DSA_METHOD
  and DH_METHOD (eg. by ENGINE implementations) to override the normal
  software implementations. For DSA and DH, parameter generation can
  also be overridden by providing the appropriate method callbacks.

  _Geoff Thorpe_

- Change the "progress" mechanism used in key-generation and
  primality testing to functions that take a new BN_GENCB pointer in
  place of callback/argument pairs. The new API functions have `_ex`
  postfixes and the older functions are reimplemented as wrappers for
  the new ones. The OPENSSL_NO_DEPRECATED symbol can be used to hide
  declarations of the old functions to help (graceful) attempts to
  migrate to the new functions. Also, the new key-generation API
  functions operate on a caller-supplied key-structure and return
  success/failure rather than returning a key or NULL - this is to
  help make "keygen" another member function of RSA_METHOD etc.

  Example for using the new callback interface:

          int (*my_callback)(int a, int b, BN_GENCB *cb) = ...;
          void *my_arg = ...;
          BN_GENCB my_cb;

          BN_GENCB_set(&my_cb, my_callback, my_arg);

          return BN_is_prime_ex(some_bignum, BN_prime_checks, NULL, &cb);
          /* For the meaning of a, b in calls to my_callback(), see the
           * documentation of the function that calls the callback.
           * cb will point to my_cb; my_arg can be retrieved as cb->arg.
           * my_callback should return 1 if it wants BN_is_prime_ex()
           * to continue, or 0 to stop.
           */

  _Geoff Thorpe_

- Change the ZLIB compression method to be stateful, and make it
  available to TLS with the number defined in
  draft-ietf-tls-compression-04.txt.

  _Richard Levitte_

- Add the ASN.1 structures and functions for CertificatePair, which
  is defined as follows (according to X.509_4thEditionDraftV6.pdf):

          CertificatePair ::= SEQUENCE {
             forward         [0]     Certificate OPTIONAL,
             reverse         [1]     Certificate OPTIONAL,
             -- at least one of the pair shall be present -- }

  Also implement the PEM functions to read and write certificate
  pairs, and defined the PEM tag as "CERTIFICATE PAIR".

  This needed to be defined, mostly for the sake of the LDAP
  attribute crossCertificatePair, but may prove useful elsewhere as
  well.

  _Richard Levitte_

- Make it possible to inhibit symlinking of shared libraries in
  Makefile.shared, for Cygwin's sake.

  _Richard Levitte_

- Extend the BIGNUM API by creating a function
  void BN_set_negative(BIGNUM *a, int neg);
  and a macro that behave like
  int BN_is_negative(const BIGNUM *a);

  to avoid the need to access 'a->neg' directly in applications.

  _Nils Larsch_

- Implement fast modular reduction for pseudo-Mersenne primes
  used in NIST curves (crypto/bn/bn_nist.c, crypto/ec/ecp_nist.c).
  EC_GROUP_new_curve_GFp() will now automatically use this
  if applicable.

  _Nils Larsch <nla@trustcenter.de>_

- Add new lock type (CRYPTO_LOCK_BN).

  _Bodo Moeller_

- Change the ENGINE framework to automatically load engines
  dynamically from specific directories unless they could be
  found to already be built in or loaded. Move all the
  current engines except for the cryptodev one to a new
  directory engines/.
  The engines in engines/ are built as shared libraries if
  the "shared" options was given to ./Configure or ./config.
  Otherwise, they are inserted in libcrypto.a.
  /usr/local/ssl/engines is the default directory for dynamic
  engines, but that can be overridden at configure time through
  the usual use of --prefix and/or --openssldir, and at run
  time with the environment variable OPENSSL_ENGINES.

  _Geoff Thorpe and Richard Levitte_

- Add Makefile.shared, a helper makefile to build shared
  libraries. Adapt Makefile.org.

  _Richard Levitte_

- Add version info to Win32 DLLs.

  _Peter 'Luna' Runestig" <peter@runestig.com>_

- Add new 'medium level' PKCS#12 API. Certificates and keys
  can be added using this API to created arbitrary PKCS#12
  files while avoiding the low-level API.

  New options to PKCS12_create(), key or cert can be NULL and
  will then be omitted from the output file. The encryption
  algorithm NIDs can be set to -1 for no encryption, the mac
  iteration count can be set to 0 to omit the mac.

  Enhance pkcs12 utility by making the -nokeys and -nocerts
  options work when creating a PKCS#12 file. New option -nomac
  to omit the mac, NONE can be set for an encryption algorithm.
  New code is modified to use the enhanced PKCS12_create()
  instead of the low-level API.

  _Steve Henson_

- Extend ASN1 encoder to support indefinite length constructed
  encoding. This can output sequences tags and octet strings in
  this form. Modify pk7_asn1.c to support indefinite length
  encoding. This is experimental and needs additional code to
  be useful, such as an ASN1 bio and some enhanced streaming
  PKCS#7 code.

  Extend template encode functionality so that tagging is passed
  down to the template encoder.

  _Steve Henson_

- Let 'openssl req' fail if an argument to '-newkey' is not
  recognized instead of using RSA as a default.

  _Bodo Moeller_

- Add support for ECC-based ciphersuites from draft-ietf-tls-ecc-01.txt.
  As these are not official, they are not included in "ALL";
  the "ECCdraft" ciphersuite group alias can be used to select them.

  _Vipul Gupta and Sumit Gupta (Sun Microsystems Laboratories)_

- Add ECDH engine support.

  _Nils Gura and Douglas Stebila (Sun Microsystems Laboratories)_

- Add ECDH in new directory crypto/ecdh/.

  _Douglas Stebila (Sun Microsystems Laboratories)_

- Let BN_rand_range() abort with an error after 100 iterations
  without success (which indicates a broken PRNG).

  _Bodo Moeller_

- Change BN_mod_sqrt() so that it verifies that the input value
  is really the square of the return value. (Previously,
  BN_mod_sqrt would show GIGO behaviour.)

  _Bodo Moeller_

- Add named elliptic curves over binary fields from X9.62, SECG,
  and WAP/WTLS; add OIDs that were still missing.

  _Sheueling Chang Shantz and Douglas Stebila (Sun Microsystems Laboratories)_

- Extend the EC library for elliptic curves over binary fields
  (new files ec2_smpl.c, ec2_smpt.c, ec2_mult.c in crypto/ec/).
  New EC_METHOD:

          EC_GF2m_simple_method

  New API functions:

          EC_GROUP_new_curve_GF2m
          EC_GROUP_set_curve_GF2m
          EC_GROUP_get_curve_GF2m
          EC_POINT_set_affine_coordinates_GF2m
          EC_POINT_get_affine_coordinates_GF2m
          EC_POINT_set_compressed_coordinates_GF2m

  Point compression for binary fields is disabled by default for
  patent reasons (compile with OPENSSL_EC_BIN_PT_COMP defined to
  enable it).

  As binary polynomials are represented as BIGNUMs, various members
  of the EC_GROUP and EC_POINT data structures can be shared
  between the implementations for prime fields and binary fields;
  the above `..._GF2m functions` (except for EX_GROUP_new_curve_GF2m)
  are essentially identical to their `..._GFp` counterparts.
  (For simplicity, the `..._GFp` prefix has been dropped from
  various internal method names.)

  An internal 'field_div' method (similar to 'field_mul' and
  'field_sqr') has been added; this is used only for binary fields.

  _Sheueling Chang Shantz and Douglas Stebila (Sun Microsystems Laboratories)_

- Optionally dispatch EC_POINT_mul(), EC_POINT_precompute_mult()
  through methods ('mul', 'precompute_mult').

  The generic implementations (now internally called 'ec_wNAF_mul'
  and 'ec_wNAF_precomputed_mult') remain the default if these
  methods are undefined.

  _Sheueling Chang Shantz and Douglas Stebila (Sun Microsystems Laboratories)_

- New function EC_GROUP_get_degree, which is defined through
  EC_METHOD. For curves over prime fields, this returns the bit
  length of the modulus.

  _Sheueling Chang Shantz and Douglas Stebila (Sun Microsystems Laboratories)_

- New functions EC_GROUP_dup, EC_POINT_dup.
  (These simply call ...\_new and ...\_copy).

  _Sheueling Chang Shantz and Douglas Stebila (Sun Microsystems Laboratories)_

- Add binary polynomial arithmetic software in crypto/bn/bn_gf2m.c.
  Polynomials are represented as BIGNUMs (where the sign bit is not
  used) in the following functions [macros]:

          BN_GF2m_add
          BN_GF2m_sub             [= BN_GF2m_add]
          BN_GF2m_mod             [wrapper for BN_GF2m_mod_arr]
          BN_GF2m_mod_mul         [wrapper for BN_GF2m_mod_mul_arr]
          BN_GF2m_mod_sqr         [wrapper for BN_GF2m_mod_sqr_arr]
          BN_GF2m_mod_inv
          BN_GF2m_mod_exp         [wrapper for BN_GF2m_mod_exp_arr]
          BN_GF2m_mod_sqrt        [wrapper for BN_GF2m_mod_sqrt_arr]
          BN_GF2m_mod_solve_quad  [wrapper for BN_GF2m_mod_solve_quad_arr]
          BN_GF2m_cmp             [= BN_ucmp]

  (Note that only the 'mod' functions are actually for fields GF(2^m).
  BN_GF2m_add() is misnomer, but this is for the sake of consistency.)

  For some functions, an the irreducible polynomial defining a
  field can be given as an 'unsigned int[]' with strictly
  decreasing elements giving the indices of those bits that are set;
  i.e., p[] represents the polynomial
  f(t) = t^p[0] + t^p[1] + ... + t^p[k]
  where
  p[0] > p[1] > ... > p[k] = 0.
  This applies to the following functions:

          BN_GF2m_mod_arr
          BN_GF2m_mod_mul_arr
          BN_GF2m_mod_sqr_arr
          BN_GF2m_mod_inv_arr        [wrapper for BN_GF2m_mod_inv]
          BN_GF2m_mod_div_arr        [wrapper for BN_GF2m_mod_div]
          BN_GF2m_mod_exp_arr
          BN_GF2m_mod_sqrt_arr
          BN_GF2m_mod_solve_quad_arr
          BN_GF2m_poly2arr
          BN_GF2m_arr2poly

  Conversion can be performed by the following functions:

          BN_GF2m_poly2arr
          BN_GF2m_arr2poly

  bntest.c has additional tests for binary polynomial arithmetic.

  Two implementations for BN_GF2m_mod_div() are available.
  The default algorithm simply uses BN_GF2m_mod_inv() and
  BN_GF2m_mod_mul(). The alternative algorithm is compiled in only
  if OPENSSL_SUN_GF2M_DIV is defined (patent pending; read the
  copyright notice in crypto/bn/bn_gf2m.c before enabling it).

  _Sheueling Chang Shantz and Douglas Stebila (Sun Microsystems Laboratories)_

- Add new error code 'ERR_R_DISABLED' that can be used when some
  functionality is disabled at compile-time.

  _Douglas Stebila <douglas.stebila@sun.com>_

- Change default behaviour of 'openssl asn1parse' so that more
  information is visible when viewing, e.g., a certificate:

  Modify asn1_parse2 (crypto/asn1/asn1_par.c) so that in non-'dump'
  mode the content of non-printable OCTET STRINGs is output in a
  style similar to INTEGERs, but with '[HEX DUMP]' prepended to
  avoid the appearance of a printable string.

  _Nils Larsch <nla@trustcenter.de>_

- Add 'asn1_flag' and 'asn1_form' member to EC_GROUP with access
  functions
  EC_GROUP_set_asn1_flag()
  EC_GROUP_get_asn1_flag()
  EC_GROUP_set_point_conversion_form()
  EC_GROUP_get_point_conversion_form()
  These control ASN1 encoding details:
  - Curves (i.e., groups) are encoded explicitly unless asn1_flag
    has been set to OPENSSL_EC_NAMED_CURVE.
  - Points are encoded in uncompressed form by default; options for
    asn1_for are as for point2oct, namely
    POINT_CONVERSION_COMPRESSED
    POINT_CONVERSION_UNCOMPRESSED
    POINT_CONVERSION_HYBRID

  Also add 'seed' and 'seed_len' members to EC_GROUP with access
  functions
  EC_GROUP_set_seed()
  EC_GROUP_get0_seed()
  EC_GROUP_get_seed_len()
  This is used only for ASN1 purposes (so far).

  _Nils Larsch <nla@trustcenter.de>_

- Add 'field_type' member to EC_METHOD, which holds the NID
  of the appropriate field type OID. The new function
  EC_METHOD_get_field_type() returns this value.

  _Nils Larsch <nla@trustcenter.de>_

- Add functions
  EC_POINT_point2bn()
  EC_POINT_bn2point()
  EC_POINT_point2hex()
  EC_POINT_hex2point()
  providing useful interfaces to EC_POINT_point2oct() and
  EC_POINT_oct2point().

  _Nils Larsch <nla@trustcenter.de>_

- Change internals of the EC library so that the functions
  EC_GROUP_set_generator()
  EC_GROUP_get_generator()
  EC_GROUP_get_order()
  EC_GROUP_get_cofactor()
  are implemented directly in crypto/ec/ec_lib.c and not dispatched
  to methods, which would lead to unnecessary code duplication when
  adding different types of curves.

  _Nils Larsch <nla@trustcenter.de> with input by Bodo Moeller_

- Implement compute_wNAF (crypto/ec/ec_mult.c) without BIGNUM
  arithmetic, and such that modified wNAFs are generated
  (which avoid length expansion in many cases).

  _Bodo Moeller_

- Add a function EC_GROUP_check_discriminant() (defined via
  EC_METHOD) that verifies that the curve discriminant is non-zero.

  Add a function EC_GROUP_check() that makes some sanity tests
  on a EC_GROUP, its generator and order. This includes
  EC_GROUP_check_discriminant().

  _Nils Larsch <nla@trustcenter.de>_

- Add ECDSA in new directory crypto/ecdsa/.

  Add applications 'openssl ecparam' and 'openssl ecdsa'
  (these are based on 'openssl dsaparam' and 'openssl dsa').

  ECDSA support is also included in various other files across the
  library. Most notably,
  - 'openssl req' now has a '-newkey ecdsa:file' option;
  - EVP_PKCS82PKEY (crypto/evp/evp_pkey.c) now can handle ECDSA;
  - X509_PUBKEY_get (crypto/asn1/x_pubkey.c) and
    d2i_PublicKey (crypto/asn1/d2i_pu.c) have been modified to make
    them suitable for ECDSA where domain parameters must be
    extracted before the specific public key;
  - ECDSA engine support has been added.

  _Nils Larsch <nla@trustcenter.de>_

- Include some named elliptic curves, and add OIDs from X9.62,
  SECG, and WAP/WTLS. Each curve can be obtained from the new
  function
  EC_GROUP_new_by_curve_name(),
  and the list of available named curves can be obtained with
  EC_get_builtin_curves().
  Also add a 'curve_name' member to EC_GROUP objects, which can be
  accessed via
  EC_GROUP_set_curve_name()
  EC_GROUP_get_curve_name()

  _Nils Larsch <larsch@trustcenter.de, Bodo Moeller_

- Remove a few calls to bn_wexpand() in BN_sqr() (the one in there
  was actually never needed) and in BN_mul(). The removal in BN_mul()
  required a small change in bn_mul_part_recursive() and the addition
  of the functions bn_cmp_part_words(), bn_sub_part_words() and
  bn_add_part_words(), which do the same thing as bn_cmp_words(),
  bn_sub_words() and bn_add_words() except they take arrays with
  differing sizes.

  _Richard Levitte_

### Changes between 0.9.7l and 0.9.7m [23 Feb 2007]

- Cleanse PEM buffers before freeing them since they may contain
  sensitive data.

  _Benjamin Bennett <ben@psc.edu>_

- Include "!eNULL" in SSL_DEFAULT_CIPHER_LIST to make sure that
  a ciphersuite string such as "DEFAULT:RSA" cannot enable
  authentication-only ciphersuites.

  _Bodo Moeller_

- Since AES128 and AES256 share a single mask bit in the logic of
  ssl/ssl_ciph.c, the code for masking out disabled ciphers needs a
  kludge to work properly if AES128 is available and AES256 isn't.

  _Victor Duchovni_

- Expand security boundary to match 1.1.1 module.

  _Steve Henson_

- Remove redundant features: hash file source, editing of test vectors
  modify fipsld to use external fips_premain.c signature.

  _Steve Henson_

- New perl script mkfipsscr.pl to create shell scripts or batch files to
  run algorithm test programs.

  _Steve Henson_

- Make algorithm test programs more tolerant of whitespace.

  _Steve Henson_

- Have SSL/TLS server implementation tolerate "mismatched" record
  protocol version while receiving ClientHello even if the
  ClientHello is fragmented. (The server can't insist on the
  particular protocol version it has chosen before the ServerHello
  message has informed the client about his choice.)

  _Bodo Moeller_

- Load error codes if they are not already present instead of using a
  static variable. This allows them to be cleanly unloaded and reloaded.

  _Steve Henson_

### Changes between 0.9.7k and 0.9.7l [28 Sep 2006]

- Introduce limits to prevent malicious keys being able to
  cause a denial of service. ([CVE-2006-2940])

  _Steve Henson, Bodo Moeller_

- Fix ASN.1 parsing of certain invalid structures that can result
  in a denial of service. ([CVE-2006-2937]) [Steve Henson]

- Fix buffer overflow in SSL_get_shared_ciphers() function.
  ([CVE-2006-3738]) [Tavis Ormandy and Will Drewry, Google Security Team]

- Fix SSL client code which could crash if connecting to a
  malicious SSLv2 server. ([CVE-2006-4343])

  _Tavis Ormandy and Will Drewry, Google Security Team_

- Change ciphersuite string processing so that an explicit
  ciphersuite selects this one ciphersuite (so that "AES256-SHA"
  will no longer include "AES128-SHA"), and any other similar
  ciphersuite (same bitmap) from _other_ protocol versions (so that
  "RC4-MD5" will still include both the SSL 2.0 ciphersuite and the
  SSL 3.0/TLS 1.0 ciphersuite). This is a backport combining
  changes from 0.9.8b and 0.9.8d.

  _Bodo Moeller_

### Changes between 0.9.7j and 0.9.7k [05 Sep 2006]

- Avoid PKCS #1 v1.5 signature attack discovered by Daniel Bleichenbacher
  ([CVE-2006-4339]) [Ben Laurie and Google Security Team]

- Change the Unix randomness entropy gathering to use poll() when
  possible instead of select(), since the latter has some
  undesirable limitations.

  _Darryl Miles via Richard Levitte and Bodo Moeller_

- Disable rogue ciphersuites:
  - SSLv2 0x08 0x00 0x80 ("RC4-64-MD5")
  - SSLv3/TLSv1 0x00 0x61 ("EXP1024-RC2-CBC-MD5")
  - SSLv3/TLSv1 0x00 0x60 ("EXP1024-RC4-MD5")

  The latter two were purportedly from
  draft-ietf-tls-56-bit-ciphersuites-0[01].txt, but do not really
  appear there.

  Also deactivate the remaining ciphersuites from
  draft-ietf-tls-56-bit-ciphersuites-01.txt. These are just as
  unofficial, and the ID has long expired.

  _Bodo Moeller_

- Fix RSA blinding Heisenbug (problems sometimes occurred on
  dual-core machines) and other potential thread-safety issues.

  _Bodo Moeller_

### Changes between 0.9.7i and 0.9.7j [04 May 2006]

- Adapt fipsld and the build system to link against the validated FIPS
  module in FIPS mode.

  _Steve Henson_

- Fixes for VC++ 2005 build under Windows.

  _Steve Henson_

- Add new Windows build target VC-32-GMAKE for VC++. This uses GNU make
  from a Windows bash shell such as MSYS. It is autodetected from the
  "config" script when run from a VC++ environment. Modify standard VC++
  build to use fipscanister.o from the GNU make build.

  _Steve Henson_

### Changes between 0.9.7h and 0.9.7i [14 Oct 2005]

- Wrapped the definition of EVP_MAX_MD_SIZE in a #ifdef OPENSSL_FIPS.
  The value now differs depending on if you build for FIPS or not.
  BEWARE! A program linked with a shared FIPSed libcrypto can't be
  safely run with a non-FIPSed libcrypto, as it may crash because of
  the difference induced by this change.

  _Andy Polyakov_

### Changes between 0.9.7g and 0.9.7h [11 Oct 2005]

- Remove the functionality of SSL_OP_MSIE_SSLV2_RSA_PADDING
  (part of SSL_OP_ALL). This option used to disable the
  countermeasure against man-in-the-middle protocol-version
  rollback in the SSL 2.0 server implementation, which is a bad
  idea. ([CVE-2005-2969])

  _Bodo Moeller; problem pointed out by Yutaka Oiwa (Research Center
  for Information Security, National Institute of Advanced Industrial
  Science and Technology [AIST, Japan)]_

- Minimal support for X9.31 signatures and PSS padding modes. This is
  mainly for FIPS compliance and not fully integrated at this stage.

  _Steve Henson_

- For DSA signing, unless DSA_FLAG_NO_EXP_CONSTTIME is set, perform
  the exponentiation using a fixed-length exponent. (Otherwise,
  the information leaked through timing could expose the secret key
  after many signatures; cf. Bleichenbacher's attack on DSA with
  biased k.)

  _Bodo Moeller_

- Make a new fixed-window mod_exp implementation the default for
  RSA, DSA, and DH private-key operations so that the sequence of
  squares and multiplies and the memory access pattern are
  independent of the particular secret key. This will mitigate
  cache-timing and potential related attacks.

  BN_mod_exp_mont_consttime() is the new exponentiation implementation,
  and this is automatically used by BN_mod_exp_mont() if the new flag
  BN_FLG_EXP_CONSTTIME is set for the exponent. RSA, DSA, and DH
  will use this BN flag for private exponents unless the flag
  RSA_FLAG_NO_EXP_CONSTTIME, DSA_FLAG_NO_EXP_CONSTTIME, or
  DH_FLAG_NO_EXP_CONSTTIME, respectively, is set.

  _Matthew D Wood (Intel Corp), with some changes by Bodo Moeller_

- Change the client implementation for SSLv23_method() and
  SSLv23_client_method() so that is uses the SSL 3.0/TLS 1.0
  Client Hello message format if the SSL_OP_NO_SSLv2 option is set.
  (Previously, the SSL 2.0 backwards compatible Client Hello
  message format would be used even with SSL_OP_NO_SSLv2.)

  _Bodo Moeller_

- Add support for smime-type MIME parameter in S/MIME messages which some
  clients need.

  _Steve Henson_

- New function BN_MONT_CTX_set_locked() to set montgomery parameters in
  a threadsafe manner. Modify rsa code to use new function and add calls
  to dsa and dh code (which had race conditions before).

  _Steve Henson_

- Include the fixed error library code in the C error file definitions
  instead of fixing them up at runtime. This keeps the error code
  structures constant.

  _Steve Henson_

### Changes between 0.9.7f and 0.9.7g [11 Apr 2005]

[NB: OpenSSL 0.9.7h and later 0.9.7 patch levels were released after
OpenSSL 0.9.8.]

- Fixes for newer kerberos headers. NB: the casts are needed because
  the 'length' field is signed on one version and unsigned on another
  with no (?) obvious way to tell the difference, without these VC++
  complains. Also the "definition" of FAR (blank) is no longer included
  nor is the error ENOMEM. KRB5_PRIVATE has to be set to 1 to pick up
  some needed definitions.

  _Steve Henson_

- Undo Cygwin change.

  _Ulf Möller_

- Added support for proxy certificates according to RFC 3820.
  Because they may be a security thread to unaware applications,
  they must be explicitly allowed in run-time. See
  docs/HOWTO/proxy_certificates.txt for further information.

  _Richard Levitte_

### Changes between 0.9.7e and 0.9.7f [22 Mar 2005]

- Use (SSL_RANDOM_VALUE - 4) bytes of pseudo random data when generating
  server and client random values. Previously
  (SSL_RANDOM_VALUE - sizeof(time_t)) would be used which would result in
  less random data when sizeof(time_t) > 4 (some 64 bit platforms).

  This change has negligible security impact because:
  1.  Server and client random values still have 24 bytes of pseudo random
      data.

  2.  Server and client random values are sent in the clear in the initial
      handshake.

  3.  The master secret is derived using the premaster secret (48 bytes in
      size for static RSA ciphersuites) as well as client server and random
      values.

  The OpenSSL team would like to thank the UK NISCC for bringing this issue
  to our attention.

  _Stephen Henson, reported by UK NISCC_

- Use Windows randomness collection on Cygwin.

  _Ulf Möller_

- Fix hang in EGD/PRNGD query when communication socket is closed
  prematurely by EGD/PRNGD.

  _Darren Tucker <dtucker@zip.com.au> via Lutz Jänicke, resolves #1014_

- Prompt for pass phrases when appropriate for PKCS12 input format.

  _Steve Henson_

- Back-port of selected performance improvements from development
  branch, as well as improved support for PowerPC platforms.

  _Andy Polyakov_

- Add lots of checks for memory allocation failure, error codes to indicate
  failure and freeing up memory if a failure occurs.

  _Nauticus Networks SSL Team <openssl@nauticusnet.com>, Steve Henson_

- Add new -passin argument to dgst.

  _Steve Henson_

- Perform some character comparisons of different types in X509_NAME_cmp:
  this is needed for some certificates that re-encode DNs into UTF8Strings
  (in violation of RFC3280) and can't or won't issue name rollover
  certificates.

  _Steve Henson_

- Make an explicit check during certificate validation to see that
  the CA setting in each certificate on the chain is correct. As a
  side effect always do the following basic checks on extensions,
  not just when there's an associated purpose to the check:
  - if there is an unhandled critical extension (unless the user
    has chosen to ignore this fault)
  - if the path length has been exceeded (if one is set at all)
  - that certain extensions fit the associated purpose (if one has
    been given)

  _Richard Levitte_

### Changes between 0.9.7d and 0.9.7e [25 Oct 2004]

- Avoid a race condition when CRLs are checked in a multi threaded
  environment. This would happen due to the reordering of the revoked
  entries during signature checking and serial number lookup. Now the
  encoding is cached and the serial number sort performed under a lock.
  Add new STACK function sk_is_sorted().

  _Steve Henson_

- Add Delta CRL to the extension code.

  _Steve Henson_

- Various fixes to s3_pkt.c so alerts are sent properly.

  _David Holmes <d.holmes@f5.com>_

- Reduce the chances of duplicate issuer name and serial numbers (in
  violation of RFC3280) using the OpenSSL certificate creation utilities.
  This is done by creating a random 64 bit value for the initial serial
  number when a serial number file is created or when a self signed
  certificate is created using 'openssl req -x509'. The initial serial
  number file is created using 'openssl x509 -next_serial' in CA.pl
  rather than being initialized to 1.

  _Steve Henson_

### Changes between 0.9.7c and 0.9.7d [17 Mar 2004]

- Fix null-pointer assignment in do_change_cipher_spec() revealed
  by using the Codenomicon TLS Test Tool ([CVE-2004-0079])

  _Joe Orton, Steve Henson_

- Fix flaw in SSL/TLS handshaking when using Kerberos ciphersuites
  ([CVE-2004-0112])

  _Joe Orton, Steve Henson_

- Make it possible to have multiple active certificates with the same
  subject in the CA index file. This is done only if the keyword
  'unique_subject' is set to 'no' in the main CA section (default
  if 'CA_default') of the configuration file. The value is saved
  with the database itself in a separate index attribute file,
  named like the index file with '.attr' appended to the name.

  _Richard Levitte_

- X509 verify fixes. Disable broken certificate workarounds when
  X509*V_FLAGS_X509_STRICT is set. Check CRL issuer has cRLSign set if
  keyUsage extension present. Don't accept CRLs with unhandled critical
  extensions: since verify currently doesn't process CRL extensions this
  rejects a CRL with \_any* critical extensions. Add new verify error codes
  for these cases.

  _Steve Henson_

- When creating an OCSP nonce use an OCTET STRING inside the extnValue.
  A clarification of RFC2560 will require the use of OCTET STRINGs and
  some implementations cannot handle the current raw format. Since OpenSSL
  copies and compares OCSP nonces as opaque blobs without any attempt at
  parsing them this should not create any compatibility issues.

  _Steve Henson_

- New md flag EVP_MD_CTX_FLAG_REUSE this allows md_data to be reused when
  calling EVP_MD_CTX_copy_ex() to avoid calling OPENSSL_malloc(). Without
  this HMAC (and other) operations are several times slower than OpenSSL
  < 0.9.7.

  _Steve Henson_

- Print out GeneralizedTime and UTCTime in ASN1_STRING_print_ex().

  _Peter Sylvester <Peter.Sylvester@EdelWeb.fr>_

- Use the correct content when signing type "other".

  _Steve Henson_

### Changes between 0.9.7b and 0.9.7c [30 Sep 2003]

- Fix various bugs revealed by running the NISCC test suite:

  Stop out of bounds reads in the ASN1 code when presented with
  invalid tags (CVE-2003-0543 and CVE-2003-0544).

  Free up ASN1_TYPE correctly if ANY type is invalid ([CVE-2003-0545]).

  If verify callback ignores invalid public key errors don't try to check
  certificate signature with the NULL public key.

  _Steve Henson_

- New -ignore_err option in ocsp application to stop the server
  exiting on the first error in a request.

  _Steve Henson_

- In ssl3_accept() (ssl/s3_srvr.c) only accept a client certificate
  if the server requested one: as stated in TLS 1.0 and SSL 3.0
  specifications.

  _Steve Henson_

- In ssl3_get_client_hello() (ssl/s3_srvr.c), tolerate additional
  extra data after the compression methods not only for TLS 1.0
  but also for SSL 3.0 (as required by the specification).

  _Bodo Moeller; problem pointed out by Matthias Loepfe_

- Change X509*certificate_type() to mark the key as exported/exportable
  when it's 512 \_bits* long, not 512 bytes.

  _Richard Levitte_

- Change AES_cbc_encrypt() so it outputs exact multiple of
  blocks during encryption.

  _Richard Levitte_

- Various fixes to base64 BIO and non blocking I/O. On write
  flushes were not handled properly if the BIO retried. On read
  data was not being buffered properly and had various logic bugs.
  This also affects blocking I/O when the data being decoded is a
  certain size.

  _Steve Henson_

- Various S/MIME bugfixes and compatibility changes:
  output correct application/pkcs7 MIME type if
  PKCS7_NOOLDMIMETYPE is set. Tolerate some broken signatures.
  Output CR+LF for EOL if PKCS7_CRLFEOL is set (this makes opening
  of files as .eml work). Correctly handle very long lines in MIME
  parser.

  _Steve Henson_

### Changes between 0.9.7a and 0.9.7b [10 Apr 2003]

- Countermeasure against the Klima-Pokorny-Rosa extension of
  Bleichbacher's attack on PKCS #1 v1.5 padding: treat
  a protocol version number mismatch like a decryption error
  in ssl3_get_client_key_exchange (ssl/s3_srvr.c).

  _Bodo Moeller_

- Turn on RSA blinding by default in the default implementation
  to avoid a timing attack. Applications that don't want it can call
  RSA_blinding_off() or use the new flag RSA_FLAG_NO_BLINDING.
  They would be ill-advised to do so in most cases.

  _Ben Laurie, Steve Henson, Geoff Thorpe, Bodo Moeller_

- Change RSA blinding code so that it works when the PRNG is not
  seeded (in this case, the secret RSA exponent is abused as
  an unpredictable seed -- if it is not unpredictable, there
  is no point in blinding anyway). Make RSA blinding thread-safe
  by remembering the creator's thread ID in rsa->blinding and
  having all other threads use local one-time blinding factors
  (this requires more computation than sharing rsa->blinding, but
  avoids excessive locking; and if an RSA object is not shared
  between threads, blinding will still be very fast).

  _Bodo Moeller_

- Fixed a typo bug that would cause ENGINE_set_default() to set an
  ENGINE as defaults for all supported algorithms irrespective of
  the 'flags' parameter. 'flags' is now honoured, so applications
  should make sure they are passing it correctly.

  _Geoff Thorpe_

- Target "mingw" now allows native Windows code to be generated in
  the Cygwin environment as well as with the MinGW compiler.

  _Ulf Moeller_

### Changes between 0.9.7 and 0.9.7a [19 Feb 2003]

- In ssl3_get_record (ssl/s3_pkt.c), minimize information leaked
  via timing by performing a MAC computation even if incorrect
  block cipher padding has been found. This is a countermeasure
  against active attacks where the attacker has to distinguish
  between bad padding and a MAC verification error. ([CVE-2003-0078])

  _Bodo Moeller; problem pointed out by Brice Canvel (EPFL),
  Alain Hiltgen (UBS), Serge Vaudenay (EPFL), and
  Martin Vuagnoux (EPFL, Ilion)_

- Make the no-err option work as intended. The intention with no-err
  is not to have the whole error stack handling routines removed from
  libcrypto, it's only intended to remove all the function name and
  reason texts, thereby removing some of the footprint that may not
  be interesting if those errors aren't displayed anyway.

  NOTE: it's still possible for any application or module to have its
  own set of error texts inserted. The routines are there, just not
  used by default when no-err is given.

  _Richard Levitte_

- Add support for FreeBSD on IA64.

  *dirk.meyer@dinoex.sub.org via Richard Levitte, resolves #454*

- Adjust DES_cbc_cksum() so it returns the same value as the MIT
  Kerberos function mit_des_cbc_cksum(). Before this change,
  the value returned by DES_cbc_cksum() was like the one from
  mit_des_cbc_cksum(), except the bytes were swapped.

  _Kevin Greaney <Kevin.Greaney@hp.com> and Richard Levitte_

- Allow an application to disable the automatic SSL chain building.
  Before this a rather primitive chain build was always performed in
  ssl3_output_cert_chain(): an application had no way to send the
  correct chain if the automatic operation produced an incorrect result.

  Now the chain builder is disabled if either:
  1.  Extra certificates are added via SSL_CTX_add_extra_chain_cert().

  2.  The mode flag SSL_MODE_NO_AUTO_CHAIN is set.

  The reasoning behind this is that an application would not want the
  auto chain building to take place if extra chain certificates are
  present and it might also want a means of sending no additional
  certificates (for example the chain has two certificates and the
  root is omitted).

  _Steve Henson_

- Add the possibility to build without the ENGINE framework.

  _Steven Reddie <smr@essemer.com.au> via Richard Levitte_

- Under Win32 gmtime() can return NULL: check return value in
  OPENSSL_gmtime(). Add error code for case where gmtime() fails.

  _Steve Henson_

- DSA routines: under certain error conditions uninitialized BN objects
  could be freed. Solution: make sure initialization is performed early
  enough. (Reported and fix supplied by Ivan D Nestlerode <nestler@MIT.EDU>,
  Nils Larsch <nla@trustcenter.de> via PR#459)

  _Lutz Jaenicke_

- Another fix for SSLv2 session ID handling: the session ID was incorrectly
  checked on reconnect on the client side, therefore session resumption
  could still fail with a "ssl session id is different" error. This
  behaviour is masked when SSL_OP_ALL is used due to
  SSL_OP_MICROSOFT_SESS_ID_BUG being set.
  Behaviour observed by Crispin Flowerday <crispin@flowerday.cx> as
  followup to PR #377.

  _Lutz Jaenicke_

- IA-32 assembler support enhancements: unified ELF targets, support
  for SCO/Caldera platforms, fix for Cygwin shared build.

  _Andy Polyakov_

- Add support for FreeBSD on sparc64. As a consequence, support for
  FreeBSD on non-x86 processors is separate from x86 processors on
  the config script, much like the NetBSD support.

  _Richard Levitte & Kris Kennaway <kris@obsecurity.org>_

### Changes between 0.9.6h and 0.9.7 [31 Dec 2002]

[NB: OpenSSL 0.9.6i and later 0.9.6 patch levels were released after
OpenSSL 0.9.7.]

- Fix session ID handling in SSLv2 client code: the SERVER FINISHED
  code (06) was taken as the first octet of the session ID and the last
  octet was ignored consequently. As a result SSLv2 client side session
  caching could not have worked due to the session ID mismatch between
  client and server.
  Behaviour observed by Crispin Flowerday <crispin@flowerday.cx> as
  PR #377.

  _Lutz Jaenicke_

- Change the declaration of needed Kerberos libraries to use EX_LIBS
  instead of the special (and badly supported) LIBKRB5. LIBKRB5 is
  removed entirely.

  _Richard Levitte_

- The hw_ncipher.c engine requires dynamic locks. Unfortunately, it
  seems that in spite of existing for more than a year, many application
  author have done nothing to provide the necessary callbacks, which
  means that this particular engine will not work properly anywhere.
  This is a very unfortunate situation which forces us, in the name
  of usability, to give the hw_ncipher.c a static lock, which is part
  of libcrypto.
  NOTE: This is for the 0.9.7 series ONLY. This hack will never
  appear in 0.9.8 or later. We EXPECT application authors to have
  dealt properly with this when 0.9.8 is released (unless we actually
  make such changes in the libcrypto locking code that changes will
  have to be made anyway).

  _Richard Levitte_

- In asn1_d2i_read_bio() repeatedly call BIO_read() until all content
  octets have been read, EOF or an error occurs. Without this change
  some truncated ASN1 structures will not produce an error.

  _Steve Henson_

- Disable Heimdal support, since it hasn't been fully implemented.
  Still give the possibility to force the use of Heimdal, but with
  warnings and a request that patches get sent to openssl-dev.

  _Richard Levitte_

- Add the VC-CE target, introduce the WINCE sysname, and add
  INSTALL.WCE and appropriate conditionals to make it build.

  _Steven Reddie <smr@essemer.com.au> via Richard Levitte_

- Change the DLL names for Cygwin to cygcrypto-x.y.z.dll and
  cygssl-x.y.z.dll, where x, y and z are the major, minor and
  edit numbers of the version.

  _Corinna Vinschen <vinschen@redhat.com> and Richard Levitte_

- Introduce safe string copy and catenation functions
  (BUF_strlcpy() and BUF_strlcat()).

  _Ben Laurie (CHATS) and Richard Levitte_

- Avoid using fixed-size buffers for one-line DNs.

  _Ben Laurie (CHATS)_

- Add BUF_MEM_grow_clean() to avoid information leakage when
  resizing buffers containing secrets, and use where appropriate.

  _Ben Laurie (CHATS)_

- Avoid using fixed size buffers for configuration file location.

  _Ben Laurie (CHATS)_

- Avoid filename truncation for various CA files.

  _Ben Laurie (CHATS)_

- Use sizeof in preference to magic numbers.

  _Ben Laurie (CHATS)_

- Avoid filename truncation in cert requests.

  _Ben Laurie (CHATS)_

- Add assertions to check for (supposedly impossible) buffer
  overflows.

  _Ben Laurie (CHATS)_

- Don't cache truncated DNS entries in the local cache (this could
  potentially lead to a spoofing attack).

  _Ben Laurie (CHATS)_

- Fix various buffers to be large enough for hex/decimal
  representations in a platform independent manner.

  _Ben Laurie (CHATS)_

- Add CRYPTO_realloc_clean() to avoid information leakage when
  resizing buffers containing secrets, and use where appropriate.

  _Ben Laurie (CHATS)_

- Add BIO_indent() to avoid much slightly worrying code to do
  indents.

  _Ben Laurie (CHATS)_

- Convert sprintf()/BIO_puts() to BIO_printf().

  _Ben Laurie (CHATS)_

- buffer_gets() could terminate with the buffer only half
  full. Fixed.

  _Ben Laurie (CHATS)_

- Add assertions to prevent user-supplied crypto functions from
  overflowing internal buffers by having large block sizes, etc.

  _Ben Laurie (CHATS)_

- New OPENSSL_assert() macro (similar to assert(), but enabled
  unconditionally).

  _Ben Laurie (CHATS)_

- Eliminate unused copy of key in RC4.

  _Ben Laurie (CHATS)_

- Eliminate unused and incorrectly sized buffers for IV in pem.h.

  _Ben Laurie (CHATS)_

- Fix off-by-one error in EGD path.

  _Ben Laurie (CHATS)_

- If RANDFILE path is too long, ignore instead of truncating.

  _Ben Laurie (CHATS)_

- Eliminate unused and incorrectly sized X.509 structure
  CBCParameter.

  _Ben Laurie (CHATS)_

- Eliminate unused and dangerous function knumber().

  _Ben Laurie (CHATS)_

- Eliminate unused and dangerous structure, KSSL_ERR.

  _Ben Laurie (CHATS)_

- Protect against overlong session ID context length in an encoded
  session object. Since these are local, this does not appear to be
  exploitable.

  _Ben Laurie (CHATS)_

- Change from security patch (see 0.9.6e below) that did not affect
  the 0.9.6 release series:

  Remote buffer overflow in SSL3 protocol - an attacker could
  supply an oversized master key in Kerberos-enabled versions.
  ([CVE-2002-0657])

  _Ben Laurie (CHATS)_

- Change the SSL kerb5 codes to match RFC 2712.

  _Richard Levitte_

- Make -nameopt work fully for req and add -reqopt switch.

  _Michael Bell <michael.bell@rz.hu-berlin.de>, Steve Henson_

- The "block size" for block ciphers in CFB and OFB mode should be 1.

  _Steve Henson, reported by Yngve Nysaeter Pettersen <yngve@opera.com>_

- Make sure tests can be performed even if the corresponding algorithms
  have been removed entirely. This was also the last step to make
  OpenSSL compilable with DJGPP under all reasonable conditions.

  _Richard Levitte, Doug Kaufman <dkaufman@rahul.net>_

- Add cipher selection rules COMPLEMENTOFALL and COMPLEMENTOFDEFAULT
  to allow version independent disabling of normally unselected ciphers,
  which may be activated as a side-effect of selecting a single cipher.

  (E.g., cipher list string "RSA" enables ciphersuites that are left
  out of "ALL" because they do not provide symmetric encryption.
  "RSA:!COMPLEMEMENTOFALL" avoids these unsafe ciphersuites.)

  _Lutz Jaenicke, Bodo Moeller_

- Add appropriate support for separate platform-dependent build
  directories. The recommended way to make a platform-dependent
  build directory is the following (tested on Linux), maybe with
  some local tweaks:

          # Place yourself outside of the OpenSSL source tree.  In
          # this example, the environment variable OPENSSL_SOURCE
          # is assumed to contain the absolute OpenSSL source directory.
          mkdir -p objtree/"`uname -s`-`uname -r`-`uname -m`"
          cd objtree/"`uname -s`-`uname -r`-`uname -m`"
          (cd $OPENSSL_SOURCE; find . -type f) | while read F; do
                  mkdir -p `dirname $F`
                  ln -s $OPENSSL_SOURCE/$F $F
          done

  To be absolutely sure not to disturb the source tree, a "make clean"
  is a good thing. If it isn't successful, don't worry about it,
  it probably means the source directory is very clean.

  _Richard Levitte_

- Make sure any ENGINE control commands make local copies of string
  pointers passed to them whenever necessary. Otherwise it is possible
  the caller may have overwritten (or deallocated) the original string
  data when a later ENGINE operation tries to use the stored values.

  _Götz Babin-Ebell <babinebell@trustcenter.de>_

- Improve diagnostics in file reading and command-line digests.

  _Ben Laurie aided and abetted by Solar Designer <solar@openwall.com>_

- Add AES modes CFB and OFB to the object database. Correct an
  error in AES-CFB decryption.

  _Richard Levitte_

- Remove most calls to EVP*CIPHER_CTX_cleanup() in evp_enc.c, this
  allows existing EVP_CIPHER_CTX structures to be reused after
  calling `EVP*\*Final()`. This behaviour is used by encryption
  BIOs and some applications. This has the side effect that
  applications must explicitly clean up cipher contexts with
  EVP_CIPHER_CTX_cleanup() or they will leak memory.

  _Steve Henson_

- Check the values of dna and dnb in bn_mul_recursive before calling
  bn_mul_comba (a non zero value means the a or b arrays do not contain
  n2 elements) and fallback to bn_mul_normal if either is not zero.

  _Steve Henson_

- Fix escaping of non-ASCII characters when using the -subj option
  of the "openssl req" command line tool. (Robert Joop <joop@fokus.gmd.de>)

  _Lutz Jaenicke_

- Make object definitions compliant to LDAP (RFC2256): SN is the short
  form for "surname", serialNumber has no short form.
  Use "mail" as the short name for "rfc822Mailbox" according to RFC2798;
  therefore remove "mail" short name for "internet 7".
  The OID for unique identifiers in X509 certificates is
  x500UniqueIdentifier, not uniqueIdentifier.
  Some more OID additions. (Michael Bell <michael.bell@rz.hu-berlin.de>)

  _Lutz Jaenicke_

- Add an "init" command to the ENGINE config module and auto initialize
  ENGINEs. Without any "init" command the ENGINE will be initialized
  after all ctrl commands have been executed on it. If init=1 the
  ENGINE is initialized at that point (ctrls before that point are run
  on the uninitialized ENGINE and after on the initialized one). If
  init=0 then the ENGINE will not be initialized at all.

  _Steve Henson_

- Fix the 'app*verify_callback' interface so that the user-defined
  argument is actually passed to the callback: In the
  SSL_CTX_set_cert_verify_callback() prototype, the callback
  declaration has been changed from
  int (*cb)()
  into
  int (_cb)(X509_STORE_CTX _,void \_);
  in ssl_verify_cert_chain (ssl/ssl_cert.c), the call
  i=s->ctx->app_verify_callback(&ctx)
  has been changed into
  i=s->ctx->app_verify_callback(&ctx, s->ctx->app_verify_arg).

  To update applications using SSL_CTX_set_cert_verify_callback(),
  a dummy argument can be added to their callback functions.

  _D. K. Smetters <smetters@parc.xerox.com>_

- Added the '4758cca' ENGINE to support IBM 4758 cards.

  _Maurice Gittens <maurice@gittens.nl>, touchups by Geoff Thorpe_

- Add and OPENSSL_LOAD_CONF define which will cause
  OpenSSL_add_all_algorithms() to load the openssl.cnf config file.
  This allows older applications to transparently support certain
  OpenSSL features: such as crypto acceleration and dynamic ENGINE loading.
  Two new functions OPENSSL_add_all_algorithms_noconf() which will never
  load the config file and OPENSSL_add_all_algorithms_conf() which will
  always load it have also been added.

  _Steve Henson_

- Add the OFB, CFB and CTR (all with 128 bit feedback) to AES.
  Adjust NIDs and EVP layer.

  _Stephen Sprunk <stephen@sprunk.org> and Richard Levitte_

- Config modules support in openssl utility.

  Most commands now load modules from the config file,
  though in a few (such as version) this isn't done
  because it couldn't be used for anything.

  In the case of ca and req the config file used is
  the same as the utility itself: that is the -config
  command line option can be used to specify an
  alternative file.

  _Steve Henson_

- Move default behaviour from OPENSSL_config(). If appname is NULL
  use "openssl_conf" if filename is NULL use default openssl config file.

  _Steve Henson_

- Add an argument to OPENSSL_config() to allow the use of an alternative
  config section name. Add a new flag to tolerate a missing config file
  and move code to CONF_modules_load_file().

  _Steve Henson_

- Support for crypto accelerator cards from Accelerated Encryption
  Processing, www.aep.ie. (Use engine 'aep')
  The support was copied from 0.9.6c [engine] and adapted/corrected
  to work with the new engine framework.

  _AEP Inc. and Richard Levitte_

- Support for SureWare crypto accelerator cards from Baltimore
  Technologies. (Use engine 'sureware')
  The support was copied from 0.9.6c [engine] and adapted
  to work with the new engine framework.

  _Richard Levitte_

- Have the CHIL engine fork-safe (as defined by nCipher) and actually
  make the newer ENGINE framework commands for the CHIL engine work.

  _Toomas Kiisk <vix@cyber.ee> and Richard Levitte_

- Make it possible to produce shared libraries on ReliantUNIX.

  _Robert Dahlem <Robert.Dahlem@ffm2.siemens.de> via Richard Levitte_

- Add the configuration target debug-linux-ppro.
  Make 'openssl rsa' use the general key loading routines
  implemented in `apps.c`, and make those routines able to
  handle the key format FORMAT_NETSCAPE and the variant
  FORMAT_IISSGC.

  _Toomas Kiisk <vix@cyber.ee> via Richard Levitte_

- Fix a crashbug and a logic bug in hwcrhk_load_pubkey().

  _Toomas Kiisk <vix@cyber.ee> via Richard Levitte_

- Add -keyform to rsautl, and document -engine.

  _Richard Levitte, inspired by Toomas Kiisk <vix@cyber.ee>_

- Change BIO_new_file (crypto/bio/bss_file.c) to use new
  BIO_R_NO_SUCH_FILE error code rather than the generic
  ERR_R_SYS_LIB error code if fopen() fails with ENOENT.

  _Ben Laurie_

- Add new functions
  ERR_peek_last_error
  ERR_peek_last_error_line
  ERR_peek_last_error_line_data.
  These are similar to
  ERR_peek_error
  ERR_peek_error_line
  ERR_peek_error_line_data,
  but report on the latest error recorded rather than the first one
  still in the error queue.

  _Ben Laurie, Bodo Moeller_

- default_algorithms option in ENGINE config module. This allows things
  like:
  default_algorithms = ALL
  default_algorithms = RSA, DSA, RAND, CIPHERS, DIGESTS

  _Steve Henson_

- Preliminary ENGINE config module.

  _Steve Henson_

- New experimental application configuration code.

  _Steve Henson_

- Change the AES code to follow the same name structure as all other
  symmetric ciphers, and behave the same way. Move everything to
  the directory crypto/aes, thereby obsoleting crypto/rijndael.

  _Stephen Sprunk <stephen@sprunk.org> and Richard Levitte_

- SECURITY: remove unsafe setjmp/signal interaction from ui_openssl.c.

  _Ben Laurie and Theo de Raadt_

- Add option to output public keys in req command.

  _Massimiliano Pala madwolf@openca.org_

- Use wNAFs in EC_POINTs_mul() for improved efficiency
  (up to about 10% better than before for P-192 and P-224).

  _Bodo Moeller_

- New functions/macros

          SSL_CTX_set_msg_callback(ctx, cb)
          SSL_CTX_set_msg_callback_arg(ctx, arg)
          SSL_set_msg_callback(ssl, cb)
          SSL_set_msg_callback_arg(ssl, arg)

  to request calling a callback function

          void cb(int write_p, int version, int content_type,
                  const void *buf, size_t len, SSL *ssl, void *arg)

  whenever a protocol message has been completely received
  (write_p == 0) or sent (write_p == 1). Here 'version' is the
  protocol version according to which the SSL library interprets
  the current protocol message (SSL2_VERSION, SSL3_VERSION, or
  TLS1_VERSION). 'content_type' is 0 in the case of SSL 2.0, or
  the content type as defined in the SSL 3.0/TLS 1.0 protocol
  specification (change_cipher_spec(20), alert(21), handshake(22)).
  'buf' and 'len' point to the actual message, 'ssl' to the
  SSL object, and 'arg' is the application-defined value set by
  SSL[_CTX]\_set_msg_callback_arg().

  'openssl s_client' and 'openssl s_server' have new '-msg' options
  to enable a callback that displays all protocol messages.

  _Bodo Moeller_

- Change the shared library support so shared libraries are built as
  soon as the corresponding static library is finished, and thereby get
  openssl and the test programs linked against the shared library.
  This still only happens when the keyword "shard" has been given to
  the configuration scripts.

  NOTE: shared library support is still an experimental thing, and
  backward binary compatibility is still not guaranteed.

  _"Maciej W. Rozycki" <macro@ds2.pg.gda.pl> and Richard Levitte_

- Add support for Subject Information Access extension.

  _Peter Sylvester <Peter.Sylvester@EdelWeb.fr>_

- Make BUF_MEM_grow() behaviour more consistent: Initialise to zero
  additional bytes when new memory had to be allocated, not just
  when reusing an existing buffer.

  _Bodo Moeller_

- New command line and configuration option 'utf8' for the req command.
  This allows field values to be specified as UTF8 strings.

  _Steve Henson_

- Add -multi and -mr options to "openssl speed" - giving multiple parallel
  runs for the former and machine-readable output for the latter.

  _Ben Laurie_

- Add '-noemailDN' option to 'openssl ca'. This prevents inclusion
  of the e-mail address in the DN (i.e., it will go into a certificate
  extension only). The new configuration file option 'email_in_dn = no'
  has the same effect.

  _Massimiliano Pala madwolf@openca.org_

- Change all functions with names starting with `des_` to be starting
  with `DES_` instead. Add wrappers that are compatible with libdes,
  but are named `_ossl_old_des_*`. Finally, add macros that map the
  `des_*` symbols to the corresponding `_ossl_old_des_*` if libdes
  compatibility is desired. If OpenSSL 0.9.6c compatibility is
  desired, the `des_*` symbols will be mapped to `DES_*`, with one
  exception.

  Since we provide two compatibility mappings, the user needs to
  define the macro OPENSSL_DES_LIBDES_COMPATIBILITY if libdes
  compatibility is desired. The default (i.e., when that macro
  isn't defined) is OpenSSL 0.9.6c compatibility.

  There are also macros that enable and disable the support of old
  des functions altogether. Those are OPENSSL_ENABLE_OLD_DES_SUPPORT
  and OPENSSL_DISABLE_OLD_DES_SUPPORT. If none or both of those
  are defined, the default will apply: to support the old des routines.

  In either case, one must include openssl/des.h to get the correct
  definitions. Do not try to just include openssl/des_old.h, that
  won't work.

  NOTE: This is a major break of an old API into a new one. Software
  authors are encouraged to switch to the `DES_` style functions. Some
  time in the future, des_old.h and the libdes compatibility functions
  will be disable (i.e. OPENSSL_DISABLE_OLD_DES_SUPPORT will be the
  default), and then completely removed.

  _Richard Levitte_

- Test for certificates which contain unsupported critical extensions.
  If such a certificate is found during a verify operation it is
  rejected by default: this behaviour can be overridden by either
  handling the new error X509_V_ERR_UNHANDLED_CRITICAL_EXTENSION or
  by setting the verify flag X509_V_FLAG_IGNORE_CRITICAL. A new function
  X509_supported_extension() has also been added which returns 1 if a
  particular extension is supported.

  _Steve Henson_

- Modify the behaviour of EVP cipher functions in similar way to digests
  to retain compatibility with existing code.

  _Steve Henson_

- Modify the behaviour of EVP_DigestInit() and EVP_DigestFinal() to retain
  compatibility with existing code. In particular the 'ctx' parameter does
  not have to be to be initialized before the call to EVP_DigestInit() and
  it is tidied up after a call to EVP_DigestFinal(). New function
  EVP_DigestFinal_ex() which does not tidy up the ctx. Similarly function
  EVP_MD_CTX_copy() changed to not require the destination to be
  initialized valid and new function EVP_MD_CTX_copy_ex() added which
  requires the destination to be valid.

  Modify all the OpenSSL digest calls to use EVP_DigestInit_ex(),
  EVP_DigestFinal_ex() and EVP_MD_CTX_copy_ex().

  _Steve Henson_

- Change ssl3_get_message (ssl/s3_both.c) and the functions using it
  so that complete 'Handshake' protocol structures are kept in memory
  instead of overwriting 'msg_type' and 'length' with 'body' data.

  _Bodo Moeller_

- Add an implementation of SSL_add_dir_cert_subjects_to_stack for Win32.

  _Massimo Santin via Richard Levitte_

- Major restructuring to the underlying ENGINE code. This includes
  reduction of linker bloat, separation of pure "ENGINE" manipulation
  (initialisation, etc) from functionality dealing with implementations
  of specific crypto interfaces. This change also introduces integrated
  support for symmetric ciphers and digest implementations - so ENGINEs
  can now accelerate these by providing EVP_CIPHER and EVP_MD
  implementations of their own. This is detailed in
  [crypto/engine/README.md](crypto/engine/README.md)
  as it couldn't be adequately described here. However, there are a few
  API changes worth noting - some RSA, DSA, DH, and RAND functions that
  were changed in the original introduction of ENGINE code have now
  reverted back - the hooking from this code to ENGINE is now a good
  deal more passive and at run-time, operations deal directly with
  RSA_METHODs, DSA_METHODs (etc) as they did before, rather than
  dereferencing through an ENGINE pointer any more. Also, the ENGINE
  functions dealing with `BN_MOD_EXP[_CRT]` handlers have been removed -
  they were not being used by the framework as there is no concept of a
  BIGNUM_METHOD and they could not be generalised to the new
  'ENGINE_TABLE' mechanism that underlies the new code. Similarly,
  ENGINE_cpy() has been removed as it cannot be consistently defined in
  the new code.

  _Geoff Thorpe_

- Change ASN1_GENERALIZEDTIME_check() to allow fractional seconds.

  _Steve Henson_

- Change mkdef.pl to sort symbols that get the same entry number,
  and make sure the automatically generated functions `ERR_load_*`
  become part of libeay.num as well.

  _Richard Levitte_

- New function SSL_renegotiate_pending(). This returns true once
  renegotiation has been requested (either SSL_renegotiate() call
  or HelloRequest/ClientHello received from the peer) and becomes
  false once a handshake has been completed.
  (For servers, SSL_renegotiate() followed by SSL_do_handshake()
  sends a HelloRequest, but does not ensure that a handshake takes
  place. SSL_renegotiate_pending() is useful for checking if the
  client has followed the request.)

  _Bodo Moeller_

- New SSL option SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION.
  By default, clients may request session resumption even during
  renegotiation (if session ID contexts permit); with this option,
  session resumption is possible only in the first handshake.

  SSL_OP_ALL is now 0x00000FFFL instead of 0x000FFFFFL. This makes
  more bits available for options that should not be part of
  SSL_OP_ALL (such as SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION).

  _Bodo Moeller_

- Add some demos for certificate and certificate request creation.

  _Steve Henson_

- Make maximum certificate chain size accepted from the peer application
  settable (`SSL*_get/set_max_cert_list()`), as proposed by
  "Douglas E. Engert" <deengert@anl.gov>.

  _Lutz Jaenicke_

- Add support for shared libraries for Unixware-7
  (Boyd Lynn Gerber <gerberb@zenez.com>).

  _Lutz Jaenicke_

- Add a "destroy" handler to ENGINEs that allows structural cleanup to
  be done prior to destruction. Use this to unload error strings from
  ENGINEs that load their own error strings. NB: This adds two new API
  functions to "get" and "set" this destroy handler in an ENGINE.

  _Geoff Thorpe_

- Alter all existing ENGINE implementations (except "openssl" and
  "openbsd") to dynamically instantiate their own error strings. This
  makes them more flexible to be built both as statically-linked ENGINEs
  and self-contained shared-libraries loadable via the "dynamic" ENGINE.
  Also, add stub code to each that makes building them as self-contained
  shared-libraries easier (see [README-Engine.md](README-Engine.md)).

  _Geoff Thorpe_

- Add a "dynamic" ENGINE that provides a mechanism for binding ENGINE
  implementations into applications that are completely implemented in
  self-contained shared-libraries. The "dynamic" ENGINE exposes control
  commands that can be used to configure what shared-library to load and
  to control aspects of the way it is handled. Also, made an update to
  the [README-Engine.md](README-Engine.md) file
  that brings its information up-to-date and
  provides some information and instructions on the "dynamic" ENGINE
  (ie. how to use it, how to build "dynamic"-loadable ENGINEs, etc).

  _Geoff Thorpe_

- Make it possible to unload ranges of ERR strings with a new
  "ERR_unload_strings" function.

  _Geoff Thorpe_

- Add a copy() function to EVP_MD.

  _Ben Laurie_

- Make EVP_MD routines take a context pointer instead of just the
  md_data void pointer.

  _Ben Laurie_

- Add flags to EVP_MD and EVP_MD_CTX. EVP_MD_FLAG_ONESHOT indicates
  that the digest can only process a single chunk of data
  (typically because it is provided by a piece of
  hardware). EVP_MD_CTX_FLAG_ONESHOT indicates that the application
  is only going to provide a single chunk of data, and hence the
  framework needn't accumulate the data for oneshot drivers.

  _Ben Laurie_

- As with "ERR", make it possible to replace the underlying "ex_data"
  functions. This change also alters the storage and management of global
  ex_data state - it's now all inside ex_data.c and all "class" code (eg.
  RSA, BIO, SSL_CTX, etc) no longer stores its own STACKS and per-class
  index counters. The API functions that use this state have been changed
  to take a "class_index" rather than pointers to the class's local STACK
  and counter, and there is now an API function to dynamically create new
  classes. This centralisation allows us to (a) plug a lot of the
  thread-safety problems that existed, and (b) makes it possible to clean
  up all allocated state using "CRYPTO_cleanup_all_ex_data()". W.r.t. (b)
  such data would previously have always leaked in application code and
  workarounds were in place to make the memory debugging turn a blind eye
  to it. Application code that doesn't use this new function will still
  leak as before, but their memory debugging output will announce it now
  rather than letting it slide.

  Besides the addition of CRYPTO_cleanup_all_ex_data(), another API change
  induced by the "ex_data" overhaul is that X509_STORE_CTX_init() now
  has a return value to indicate success or failure.

  _Geoff Thorpe_

- Make it possible to replace the underlying "ERR" functions such that the
  global state (2 LHASH tables and 2 locks) is only used by the "default"
  implementation. This change also adds two functions to "get" and "set"
  the implementation prior to it being automatically set the first time
  any other ERR function takes place. Ie. an application can call "get",
  pass the return value to a module it has just loaded, and that module
  can call its own "set" function using that value. This means the
  module's "ERR" operations will use (and modify) the error state in the
  application and not in its own statically linked copy of OpenSSL code.

  _Geoff Thorpe_

- Give DH, DSA, and RSA types their own `*_up_ref()` function to increment
  reference counts. This performs normal REF_PRINT/REF_CHECK macros on
  the operation, and provides a more encapsulated way for external code
  (crypto/evp/ and ssl/) to do this. Also changed the evp and ssl code
  to use these functions rather than manually incrementing the counts.

  Also rename "DSO_up()" function to more descriptive "DSO_up_ref()".

  _Geoff Thorpe_

- Add EVP test program.

  _Ben Laurie_

- Add symmetric cipher support to ENGINE. Expect the API to change!

  _Ben Laurie_

- New CRL functions: X509_CRL_set_version(), X509_CRL_set_issuer_name()
  X509_CRL_set_lastUpdate(), X509_CRL_set_nextUpdate(), X509_CRL_sort(),
  X509_REVOKED_set_serialNumber(), and X509_REVOKED_set_revocationDate().
  These allow a CRL to be built without having to access X509_CRL fields
  directly. Modify 'ca' application to use new functions.

  _Steve Henson_

- Move SSL_OP_TLS_ROLLBACK_BUG out of the SSL_OP_ALL list of recommended
  bug workarounds. Rollback attack detection is a security feature.
  The problem will only arise on OpenSSL servers when TLSv1 is not
  available (sslv3_server_method() or SSL_OP_NO_TLSv1).
  Software authors not wanting to support TLSv1 will have special reasons
  for their choice and can explicitly enable this option.

  _Bodo Moeller, Lutz Jaenicke_

- Rationalise EVP so it can be extended: don't include a union of
  cipher/digest structures, add init/cleanup functions for EVP_MD_CTX
  (similar to those existing for EVP_CIPHER_CTX).
  Usage example:

          EVP_MD_CTX md;

          EVP_MD_CTX_init(&md);             /* new function call */
          EVP_DigestInit(&md, EVP_sha1());
          EVP_DigestUpdate(&md, in, len);
          EVP_DigestFinal(&md, out, NULL);
          EVP_MD_CTX_cleanup(&md);          /* new function call */

  _Ben Laurie_

- Make DES key schedule conform to the usual scheme, as well as
  correcting its structure. This means that calls to DES functions
  now have to pass a pointer to a des_key_schedule instead of a
  plain des_key_schedule (which was actually always a pointer
  anyway): E.g.,

          des_key_schedule ks;

          des_set_key_checked(..., &ks);
          des_ncbc_encrypt(..., &ks, ...);

  (Note that a later change renames 'des*...' into 'DES*...'.)

  _Ben Laurie_

- Initial reduction of linker bloat: the use of some functions, such as
  PEM causes large amounts of unused functions to be linked in due to
  poor organisation. For example pem_all.c contains every PEM function
  which has a knock on effect of linking in large amounts of (unused)
  ASN1 code. Grouping together similar functions and splitting unrelated
  functions prevents this.

  _Steve Henson_

- Cleanup of EVP macros.

  _Ben Laurie_

- Change historical references to `{NID,SN,LN}_des_ede` and ede3 to add the
  correct `_ecb suffix`.

  _Ben Laurie_

- Add initial OCSP responder support to ocsp application. The
  revocation information is handled using the text based index
  use by the ca application. The responder can either handle
  requests generated internally, supplied in files (for example
  via a CGI script) or using an internal minimal server.

  _Steve Henson_

- Add configuration choices to get zlib compression for TLS.

  _Richard Levitte_

- Changes to Kerberos SSL for RFC 2712 compliance:
  1.  Implemented real KerberosWrapper, instead of just using
      KRB5 AP_REQ message. [Thanks to Simon Wilkinson <sxw@sxw.org.uk>]
  2.  Implemented optional authenticator field of KerberosWrapper.

  Added openssl-style ASN.1 macros for Kerberos ticket, ap_req,
  and authenticator structs; see crypto/krb5/.

  Generalized Kerberos calls to support multiple Kerberos libraries.
  _Vern Staats <staatsvr@asc.hpc.mil>, Jeffrey Altman <jaltman@columbia.edu>
  via Richard Levitte_

- Cause 'openssl speed' to use fully hard-coded DSA keys as it
  already does with RSA. testdsa.h now has 'priv_key/pub_key'
  values for each of the key sizes rather than having just
  parameters (and 'speed' generating keys each time).

  _Geoff Thorpe_

- Speed up EVP routines.
  Before:
  crypt
  pe 8 bytes 64 bytes 256 bytes 1024 bytes 8192 bytes
  s-cbc 4408.85k 5560.51k 5778.46k 5862.20k 5825.16k
  s-cbc 4389.55k 5571.17k 5792.23k 5846.91k 5832.11k
  s-cbc 4394.32k 5575.92k 5807.44k 5848.37k 5841.30k
  crypt
  s-cbc 3482.66k 5069.49k 5496.39k 5614.16k 5639.28k
  s-cbc 3480.74k 5068.76k 5510.34k 5609.87k 5635.52k
  s-cbc 3483.72k 5067.62k 5504.60k 5708.01k 5724.80k
  After:
  crypt
  s-cbc 4660.16k 5650.19k 5807.19k 5827.13k 5783.32k
  crypt
  s-cbc 3624.96k 5258.21k 5530.91k 5624.30k 5628.26k

  _Ben Laurie_

- Added the OS2-EMX target.

  _"Brian Havard" <brianh@kheldar.apana.org.au> and Richard Levitte_

- Rewrite commands to use `NCONF` routines instead of the old `CONF`.
  New functions to support `NCONF` routines in extension code.
  New function `CONF_set_nconf()`
  to allow functions which take an `NCONF` to also handle the old `LHASH`
  structure: this means that the old `CONF` compatible routines can be
  retained (in particular w.rt. extensions) without having to duplicate the
  code. New function `X509V3_add_ext_nconf_sk()` to add extensions to a stack.

  _Steve Henson_

- Enhance the general user interface with mechanisms for inner control
  and with possibilities to have yes/no kind of prompts.

  _Richard Levitte_

- Change all calls to low-level digest routines in the library and
  applications to use EVP. Add missing calls to HMAC_cleanup() and
  don't assume HMAC_CTX can be copied using memcpy().

  _Verdon Walker <VWalker@novell.com>, Steve Henson_

- Add the possibility to control engines through control names but with
  arbitrary arguments instead of just a string.
  Change the key loaders to take a UI_METHOD instead of a callback
  function pointer. NOTE: this breaks binary compatibility with earlier
  versions of OpenSSL [engine].
  Adapt the nCipher code for these new conditions and add a card insertion
  callback.

  _Richard Levitte_

- Enhance the general user interface with mechanisms to better support
  dialog box interfaces, application-defined prompts, the possibility
  to use defaults (for example default passwords from somewhere else)
  and interrupts/cancellations.

  _Richard Levitte_

- Tidy up PKCS#12 attribute handling. Add support for the CSP name
  attribute in PKCS#12 files, add new -CSP option to pkcs12 utility.

  _Steve Henson_

- Fix a memory leak in 'sk_dup()' in the case reallocation fails. (Also
  tidy up some unnecessarily weird code in 'sk_new()').

  _Geoff, reported by Diego Tartara <dtartara@novamens.com>_

- Change the key loading routines for ENGINEs to use the same kind
  callback (pem_password_cb) as all other routines that need this
  kind of callback.

  _Richard Levitte_

- Increase ENTROPY_NEEDED to 32 bytes, as Rijndael can operate with
  256 bit (=32 byte) keys. Of course seeding with more entropy bytes
  than this minimum value is recommended.

  _Lutz Jaenicke_

- New random seeder for OpenVMS, using the system process statistics
  that are easily reachable.

  _Richard Levitte_

- Windows apparently can't transparently handle global
  variables defined in DLLs. Initialisations such as:

          const ASN1_ITEM *it = &ASN1_INTEGER_it;

  won't compile. This is used by the any applications that need to
  declare their own ASN1 modules. This was fixed by adding the option
  EXPORT_VAR_AS_FN to all Win32 platforms, although this isn't strictly
  needed for static libraries under Win32.

  _Steve Henson_

- New functions X509_PURPOSE_set() and X509_TRUST_set() to handle
  setting of purpose and trust fields. New X509_STORE trust and
  purpose functions and tidy up setting in other SSL functions.

  _Steve Henson_

- Add copies of X509_STORE_CTX fields and callbacks to X509_STORE
  structure. These are inherited by X509_STORE_CTX when it is
  initialised. This allows various defaults to be set in the
  X509_STORE structure (such as flags for CRL checking and custom
  purpose or trust settings) for functions which only use X509_STORE_CTX
  internally such as S/MIME.

  Modify X509_STORE_CTX_purpose_inherit() so it only sets purposes and
  trust settings if they are not set in X509_STORE. This allows X509_STORE
  purposes and trust (in S/MIME for example) to override any set by default.

  Add command line options for CRL checking to smime, s_client and s_server
  applications.

  _Steve Henson_

- Initial CRL based revocation checking. If the CRL checking flag(s)
  are set then the CRL is looked up in the X509_STORE structure and
  its validity and signature checked, then if the certificate is found
  in the CRL the verify fails with a revoked error.

  Various new CRL related callbacks added to X509_STORE_CTX structure.

  Command line options added to 'verify' application to support this.

  This needs some additional work, such as being able to handle multiple
  CRLs with different times, extension based lookup (rather than just
  by subject name) and ultimately more complete V2 CRL extension
  handling.

  _Steve Henson_

- Add a general user interface API (crypto/ui/). This is designed
  to replace things like des_read_password and friends (backward
  compatibility functions using this new API are provided).
  The purpose is to remove prompting functions from the DES code
  section as well as provide for prompting through dialog boxes in
  a window system and the like.

  _Richard Levitte_

- Add "ex_data" support to ENGINE so implementations can add state at a
  per-structure level rather than having to store it globally.

  _Geoff_

- Make it possible for ENGINE structures to be copied when retrieved by
  ENGINE_by_id() if the ENGINE specifies a new flag: ENGINE_FLAGS_BY_ID_COPY.
  This causes the "original" ENGINE structure to act like a template,
  analogous to the RSA vs. RSA_METHOD type of separation. Because of this
  operational state can be localised to each ENGINE structure, despite the
  fact they all share the same "methods". New ENGINE structures returned in
  this case have no functional references and the return value is the single
  structural reference. This matches the single structural reference returned
  by ENGINE_by_id() normally, when it is incremented on the pre-existing
  ENGINE structure.

  _Geoff_

- Fix ASN1 decoder when decoding type ANY and V_ASN1_OTHER: since this
  needs to match any other type at all we need to manually clear the
  tag cache.

  _Steve Henson_

- Changes to the "openssl engine" utility to include;
  - verbosity levels ('-v', '-vv', and '-vvv') that provide information
    about an ENGINE's available control commands.
  - executing control commands from command line arguments using the
    '-pre' and '-post' switches. '-post' is only used if '-t' is
    specified and the ENGINE is successfully initialised. The syntax for
    the individual commands are colon-separated, for example;
    openssl engine chil -pre FORK_CHECK:0 -pre SO_PATH:/lib/test.so

  _Geoff_

- New dynamic control command support for ENGINEs. ENGINEs can now
  declare their own commands (numbers), names (strings), descriptions,
  and input types for run-time discovery by calling applications. A
  subset of these commands are implicitly classed as "executable"
  depending on their input type, and only these can be invoked through
  the new string-based API function ENGINE_ctrl_cmd_string(). (Eg. this
  can be based on user input, config files, etc). The distinction is
  that "executable" commands cannot return anything other than a boolean
  result and can only support numeric or string input, whereas some
  discoverable commands may only be for direct use through
  ENGINE_ctrl(), eg. supporting the exchange of binary data, function
  pointers, or other custom uses. The "executable" commands are to
  support parameterisations of ENGINE behaviour that can be
  unambiguously defined by ENGINEs and used consistently across any
  OpenSSL-based application. Commands have been added to all the
  existing hardware-supporting ENGINEs, noticeably "SO_PATH" to allow
  control over shared-library paths without source code alterations.

  _Geoff_

- Changed all ENGINE implementations to dynamically allocate their
  ENGINEs rather than declaring them statically. Apart from this being
  necessary with the removal of the ENGINE_FLAGS_MALLOCED distinction,
  this also allows the implementations to compile without using the
  internal engine_int.h header.

  _Geoff_

- Minor adjustment to "rand" code. RAND_get_rand_method() now returns a
  'const' value. Any code that should be able to modify a RAND_METHOD
  should already have non-const pointers to it (ie. they should only
  modify their own ones).

  _Geoff_

- Made a variety of little tweaks to the ENGINE code.
  - "atalla" and "ubsec" string definitions were moved from header files
    to C code. "nuron" string definitions were placed in variables
    rather than hard-coded - allowing parameterisation of these values
    later on via ctrl() commands.
  - Removed unused "#if 0"'d code.
  - Fixed engine list iteration code so it uses ENGINE_free() to release
    structural references.
  - Constified the RAND_METHOD element of ENGINE structures.
  - Constified various get/set functions as appropriate and added
    missing functions (including a catch-all ENGINE_cpy that duplicates
    all ENGINE values onto a new ENGINE except reference counts/state).
  - Removed NULL parameter checks in get/set functions. Setting a method
    or function to NULL is a way of cancelling out a previously set
    value. Passing a NULL ENGINE parameter is just plain stupid anyway
    and doesn't justify the extra error symbols and code.
  - Deprecate the ENGINE_FLAGS_MALLOCED define and move the area for
    flags from engine_int.h to engine.h.
  - Changed prototypes for ENGINE handler functions (init(), finish(),
    ctrl(), key-load functions, etc) to take an (ENGINE\*) parameter.

  _Geoff_

- Implement binary inversion algorithm for BN_mod_inverse in addition
  to the algorithm using long division. The binary algorithm can be
  used only if the modulus is odd. On 32-bit systems, it is faster
  only for relatively small moduli (roughly 20-30% for 128-bit moduli,
  roughly 5-15% for 256-bit moduli), so we use it only for moduli
  up to 450 bits. In 64-bit environments, the binary algorithm
  appears to be advantageous for much longer moduli; here we use it
  for moduli up to 2048 bits.

  _Bodo Moeller_

- Rewrite CHOICE field setting in ASN1_item_ex_d2i(). The old code
  could not support the combine flag in choice fields.

  _Steve Henson_

- Add a 'copy_extensions' option to the 'ca' utility. This copies
  extensions from a certificate request to the certificate.

  _Steve Henson_

- Allow multiple 'certopt' and 'nameopt' options to be separated
  by commas. Add 'namopt' and 'certopt' options to the 'ca' config
  file: this allows the display of the certificate about to be
  signed to be customised, to allow certain fields to be included
  or excluded and extension details. The old system didn't display
  multicharacter strings properly, omitted fields not in the policy
  and couldn't display additional details such as extensions.

  _Steve Henson_

- Function EC_POINTs_mul for multiple scalar multiplication
  of an arbitrary number of elliptic curve points
  \sum scalars[i]*points[i],
  optionally including the generator defined for the EC_GROUP:
  scalar*generator + \sum scalars[i]\*points[i].

  EC_POINT_mul is a simple wrapper function for the typical case
  that the point list has just one item (besides the optional
  generator).

  _Bodo Moeller_

- First EC_METHODs for curves over GF(p):

  EC_GFp_simple_method() uses the basic BN_mod_mul and BN_mod_sqr
  operations and provides various method functions that can also
  operate with faster implementations of modular arithmetic.

  EC_GFp_mont_method() reuses most functions that are part of
  EC_GFp_simple_method, but uses Montgomery arithmetic.

  _Bodo Moeller; point addition and point doubling
  implementation directly derived from source code provided by
  Lenka Fibikova <fibikova@exp-math.uni-essen.de>_

- Framework for elliptic curves (crypto/ec/ec.h, crypto/ec/ec_lcl.h,
  crypto/ec/ec_lib.c):

  Curves are EC_GROUP objects (with an optional group generator)
  based on EC_METHODs that are built into the library.

  Points are EC_POINT objects based on EC_GROUP objects.

  Most of the framework would be able to handle curves over arbitrary
  finite fields, but as there are no obvious types for fields other
  than GF(p), some functions are limited to that for now.

  _Bodo Moeller_

- Add the -HTTP option to s_server. It is similar to -WWW, but requires
  that the file contains a complete HTTP response.

  _Richard Levitte_

- Add the ec directory to mkdef.pl and mkfiles.pl. In mkdef.pl
  change the def and num file printf format specifier from "%-40sXXX"
  to "%-39s XXX". The latter will always guarantee a space after the
  field while the former will cause them to run together if the field
  is 40 of more characters long.

  _Steve Henson_

- Constify the cipher and digest 'method' functions and structures
  and modify related functions to take constant EVP_MD and EVP_CIPHER
  pointers.

  _Steve Henson_

- Hide BN_CTX structure details in bn_lcl.h instead of publishing them
  in <openssl/bn.h>. Also further increase BN_CTX_NUM to 32.

  _Bodo Moeller_

- Modify `EVP_Digest*()` routines so they now return values. Although the
  internal software routines can never fail additional hardware versions
  might.

  _Steve Henson_

- Clean up crypto/err/err.h and change some error codes to avoid conflicts:

  Previously ERR_R_FATAL was too small and coincided with ERR_LIB_PKCS7
  (= ERR_R_PKCS7_LIB); it is now 64 instead of 32.

  ASN1 error codes
  ERR_R_NESTED_ASN1_ERROR
  ...
  ERR_R_MISSING_ASN1_EOS
  were 4 .. 9, conflicting with
  ERR_LIB_RSA (= ERR_R_RSA_LIB)
  ...
  ERR_LIB_PEM (= ERR_R_PEM_LIB).
  They are now 58 .. 63 (i.e., just below ERR_R_FATAL).

  Add new error code 'ERR_R_INTERNAL_ERROR'.

  _Bodo Moeller_

- Don't overuse locks in crypto/err/err.c: For data retrieval, CRYPTO_r_lock
  suffices.

  _Bodo Moeller_

- New option '-subj arg' for 'openssl req' and 'openssl ca'. This
  sets the subject name for a new request or supersedes the
  subject name in a given request. Formats that can be parsed are
  'CN=Some Name, OU=myOU, C=IT'
  and
  'CN=Some Name/OU=myOU/C=IT'.

  Add options '-batch' and '-verbose' to 'openssl req'.

  _Massimiliano Pala <madwolf@hackmasters.net>_

- Introduce the possibility to access global variables through
  functions on platform were that's the best way to handle exporting
  global variables in shared libraries. To enable this functionality,
  one must configure with "EXPORT_VAR_AS_FN" or defined the C macro
  "OPENSSL_EXPORT_VAR_AS_FUNCTION" in crypto/opensslconf.h (the latter
  is normally done by Configure or something similar).

  To implement a global variable, use the macro OPENSSL_IMPLEMENT_GLOBAL
  in the source file (foo.c) like this:

          OPENSSL_IMPLEMENT_GLOBAL(int,foo)=1;
          OPENSSL_IMPLEMENT_GLOBAL(double,bar);

  To declare a global variable, use the macros OPENSSL_DECLARE_GLOBAL
  and OPENSSL_GLOBAL_REF in the header file (foo.h) like this:

          OPENSSL_DECLARE_GLOBAL(int,foo);
          #define foo OPENSSL_GLOBAL_REF(foo)
          OPENSSL_DECLARE_GLOBAL(double,bar);
          #define bar OPENSSL_GLOBAL_REF(bar)

  The #defines are very important, and therefore so is including the
  header file everywhere where the defined globals are used.

  The macro OPENSSL_EXPORT_VAR_AS_FUNCTION also affects the definition
  of ASN.1 items, but that structure is a bit different.

  The largest change is in util/mkdef.pl which has been enhanced with
  better and easier to understand logic to choose which symbols should
  go into the Windows .def files as well as a number of fixes and code
  cleanup (among others, algorithm keywords are now sorted
  lexicographically to avoid constant rewrites).

  _Richard Levitte_

- In BN_div() keep a copy of the sign of 'num' before writing the
  result to 'rm' because if rm==num the value will be overwritten
  and produce the wrong result if 'num' is negative: this caused
  problems with BN_mod() and BN_nnmod().

  _Steve Henson_

- Function OCSP_request_verify(). This checks the signature on an
  OCSP request and verifies the signer certificate. The signer
  certificate is just checked for a generic purpose and OCSP request
  trust settings.

  _Steve Henson_

- Add OCSP_check_validity() function to check the validity of OCSP
  responses. OCSP responses are prepared in real time and may only
  be a few seconds old. Simply checking that the current time lies
  between thisUpdate and nextUpdate max reject otherwise valid responses
  caused by either OCSP responder or client clock inaccuracy. Instead
  we allow thisUpdate and nextUpdate to fall within a certain period of
  the current time. The age of the response can also optionally be
  checked. Two new options -validity_period and -status_age added to
  ocsp utility.

  _Steve Henson_

- If signature or public key algorithm is unrecognized print out its
  OID rather that just UNKNOWN.

  _Steve Henson_

- Change OCSP_cert_to_id() to tolerate a NULL subject certificate and
  OCSP_cert_id_new() a NULL serialNumber. This allows a partial certificate
  ID to be generated from the issuer certificate alone which can then be
  passed to OCSP_id_issuer_cmp().

  _Steve Henson_

- New compilation option ASN1_ITEM_FUNCTIONS. This causes the new
  ASN1 modules to export functions returning ASN1_ITEM pointers
  instead of the ASN1_ITEM structures themselves. This adds several
  new macros which allow the underlying ASN1 function/structure to
  be accessed transparently. As a result code should not use ASN1_ITEM
  references directly (such as &X509_it) but instead use the relevant
  macros (such as ASN1_ITEM_rptr(X509)). This option is to allow
  use of the new ASN1 code on platforms where exporting structures
  is problematical (for example in shared libraries) but exporting
  functions returning pointers to structures is not.

  _Steve Henson_

- Add support for overriding the generation of SSL/TLS session IDs.
  These callbacks can be registered either in an SSL_CTX or per SSL.
  The purpose of this is to allow applications to control, if they wish,
  the arbitrary values chosen for use as session IDs, particularly as it
  can be useful for session caching in multiple-server environments. A
  command-line switch for testing this (and any client code that wishes
  to use such a feature) has been added to "s_server".

  _Geoff Thorpe, Lutz Jaenicke_

- Modify mkdef.pl to recognise and parse preprocessor conditionals
  of the form `#if defined(...) || defined(...) || ...` and
  `#if !defined(...) && !defined(...) && ...`. This also avoids
  the growing number of special cases it was previously handling.

  _Richard Levitte_

- Make all configuration macros available for application by making
  sure they are available in opensslconf.h, by giving them names starting
  with `OPENSSL_` to avoid conflicts with other packages and by making
  sure e*os2.h will cover all platform-specific cases together with
  opensslconf.h.
  Additionally, it is now possible to define configuration/platform-
  specific names (called "system identities"). In the C code, these
  are prefixed with `OPENSSL_SYSNAME*`.  e_os2.h will create another
macro with the name beginning with `OPENSSL*SYS*`, which is determined
from `OPENSSL*SYSNAME*\*` or compiler-specific macros depending on
  what is available.

  _Richard Levitte_

- New option -set_serial to 'req' and 'x509' this allows the serial
  number to use to be specified on the command line. Previously self
  signed certificates were hard coded with serial number 0 and the
  CA options of 'x509' had to use a serial number in a file which was
  auto incremented.

  _Steve Henson_

- New options to 'ca' utility to support V2 CRL entry extensions.
  Currently CRL reason, invalidity date and hold instruction are
  supported. Add new CRL extensions to V3 code and some new objects.

  _Steve Henson_

- New function EVP_CIPHER_CTX_set_padding() this is used to
  disable standard block padding (aka PKCS#5 padding) in the EVP
  API, which was previously mandatory. This means that the data is
  not padded in any way and so the total length much be a multiple
  of the block size, otherwise an error occurs.

  _Steve Henson_

- Initial (incomplete) OCSP SSL support.

  _Steve Henson_

- New function OCSP_parse_url(). This splits up a URL into its host,
  port and path components: primarily to parse OCSP URLs. New -url
  option to ocsp utility.

  _Steve Henson_

- New nonce behavior. The return value of OCSP_check_nonce() now
  reflects the various checks performed. Applications can decide
  whether to tolerate certain situations such as an absent nonce
  in a response when one was present in a request: the ocsp application
  just prints out a warning. New function OCSP_add1_basic_nonce()
  this is to allow responders to include a nonce in a response even if
  the request is nonce-less.

  _Steve Henson_

- Disable stdin buffering in `load_cert()` (`apps/apps.c`) so that no certs are
  skipped when using openssl x509 multiple times on a single input file,
  e.g. `(openssl x509 -out cert1; openssl x509 -out cert2) <certs`.

  _Bodo Moeller_

- Make ASN1_UTCTIME_set_string() and ASN1_GENERALIZEDTIME_set_string()
  set string type: to handle setting ASN1_TIME structures. Fix ca
  utility to correctly initialize revocation date of CRLs.

  _Steve Henson_

- New option SSL_OP_CIPHER_SERVER_PREFERENCE allows the server to override
  the clients preferred ciphersuites and rather use its own preferences.
  Should help to work around M$ SGC (Server Gated Cryptography) bug in
  Internet Explorer by ensuring unchanged hash method during stepup.
  (Also replaces the broken/deactivated SSL_OP_NON_EXPORT_FIRST option.)

  _Lutz Jaenicke_

- Make mkdef.pl recognise all DECLARE_ASN1 macros, change rijndael
  to aes and add a new 'exist' option to print out symbols that don't
  appear to exist.

  _Steve Henson_

- Additional options to ocsp utility to allow flags to be set and
  additional certificates supplied.

  _Steve Henson_

- Add the option -VAfile to 'openssl ocsp', so the user can give the
  OCSP client a number of certificate to only verify the response
  signature against.

  _Richard Levitte_

- Update Rijndael code to version 3.0 and change EVP AES ciphers to
  handle the new API. Currently only ECB, CBC modes supported. Add new
  AES OIDs.

  Add TLS AES ciphersuites as described in RFC3268, "Advanced
  Encryption Standard (AES) Ciphersuites for Transport Layer
  Security (TLS)". (In beta versions of OpenSSL 0.9.7, these were
  not enabled by default and were not part of the "ALL" ciphersuite
  alias because they were not yet official; they could be
  explicitly requested by specifying the "AESdraft" ciphersuite
  group alias. In the final release of OpenSSL 0.9.7, the group
  alias is called "AES" and is part of "ALL".)

  _Ben Laurie, Steve Henson, Bodo Moeller_

- New function OCSP_copy_nonce() to copy nonce value (if present) from
  request to response.

  _Steve Henson_

- Functions for OCSP responders. OCSP_request_onereq_count(),
  OCSP_request_onereq_get0(), OCSP_onereq_get0_id() and OCSP_id_get0_info()
  extract information from a certificate request. OCSP_response_create()
  creates a response and optionally adds a basic response structure.
  OCSP_basic_add1_status() adds a complete single response to a basic
  response and returns the OCSP_SINGLERESP structure just added (to allow
  extensions to be included for example). OCSP_basic_add1_cert() adds a
  certificate to a basic response and OCSP_basic_sign() signs a basic
  response with various flags. New helper functions ASN1_TIME_check()
  (checks validity of ASN1_TIME structure) and ASN1_TIME_to_generalizedtime()
  (converts ASN1_TIME to GeneralizedTime).

  _Steve Henson_

- Various new functions. EVP_Digest() combines EVP_Digest{Init,Update,Final}()
  in a single operation. X509_get0_pubkey_bitstr() extracts the public_key
  structure from a certificate. X509_pubkey_digest() digests the public_key
  contents: this is used in various key identifiers.

  _Steve Henson_

- Make sk_sort() tolerate a NULL argument.

  _Steve Henson reported by Massimiliano Pala <madwolf@comune.modena.it>_

- New OCSP verify flag OCSP_TRUSTOTHER. When set the "other" certificates
  passed by the function are trusted implicitly. If any of them signed the
  response then it is assumed to be valid and is not verified.

  _Steve Henson_

- In PKCS7*set_type() initialise content_type in PKCS7_ENC_CONTENT
  to data. This was previously part of the PKCS7 ASN1 code. This
  was causing problems with OpenSSL created PKCS#12 and PKCS#7 structures.
  \_Steve Henson, reported by Kenneth R. Robinette
  <support@securenetterm.com>*

- Add CRYPTO_push_info() and CRYPTO_pop_info() calls to new ASN1
  routines: without these tracing memory leaks is very painful.
  Fix leaks in PKCS12 and PKCS7 routines.

  _Steve Henson_

- Make X509*time_adj() cope with the new behaviour of ASN1_TIME_new().
  Previously it initialised the 'type' argument to V_ASN1_UTCTIME which
  effectively meant GeneralizedTime would never be used. Now it
  is initialised to -1 but X509_time_adj() now has to check the value
  and use ASN1_TIME_set() if the value is not V_ASN1_UTCTIME or
  V_ASN1_GENERALIZEDTIME, without this it always uses GeneralizedTime.
  \_Steve Henson, reported by Kenneth R. Robinette
  <support@securenetterm.com>*

- Fixes to BN_to_ASN1_INTEGER when bn is zero. This would previously
  result in a zero length in the ASN1_INTEGER structure which was
  not consistent with the structure when d2i_ASN1_INTEGER() was used
  and would cause ASN1_INTEGER_cmp() to fail. Enhance s2i_ASN1_INTEGER()
  to cope with hex and negative integers. Fix bug in i2a_ASN1_INTEGER()
  where it did not print out a minus for negative ASN1_INTEGER.

  _Steve Henson_

- Add summary printout to ocsp utility. The various functions which
  convert status values to strings have been renamed to:
  OCSP_response_status_str(), OCSP_cert_status_str() and
  OCSP_crl_reason_str() and are no longer static. New options
  to verify nonce values and to disable verification. OCSP response
  printout format cleaned up.

  _Steve Henson_

- Add additional OCSP certificate checks. These are those specified
  in RFC2560. This consists of two separate checks: the CA of the
  certificate being checked must either be the OCSP signer certificate
  or the issuer of the OCSP signer certificate. In the latter case the
  OCSP signer certificate must contain the OCSP signing extended key
  usage. This check is performed by attempting to match the OCSP
  signer or the OCSP signer CA to the issuerNameHash and issuerKeyHash
  in the OCSP_CERTID structures of the response.

  _Steve Henson_

- Initial OCSP certificate verification added to OCSP_basic_verify()
  and related routines. This uses the standard OpenSSL certificate
  verify routines to perform initial checks (just CA validity) and
  to obtain the certificate chain. Then additional checks will be
  performed on the chain. Currently the root CA is checked to see
  if it is explicitly trusted for OCSP signing. This is used to set
  a root CA as a global signing root: that is any certificate that
  chains to that CA is an acceptable OCSP signing certificate.

  _Steve Henson_

- New '-extfile ...' option to 'openssl ca' for reading X.509v3
  extensions from a separate configuration file.
  As when reading extensions from the main configuration file,
  the '-extensions ...' option may be used for specifying the
  section to use.

  _Massimiliano Pala <madwolf@comune.modena.it>_

- New OCSP utility. Allows OCSP requests to be generated or
  read. The request can be sent to a responder and the output
  parsed, outputted or printed in text form. Not complete yet:
  still needs to check the OCSP response validity.

  _Steve Henson_

- New subcommands for 'openssl ca':
  `openssl ca -status <serial>` prints the status of the cert with
  the given serial number (according to the index file).
  `openssl ca -updatedb` updates the expiry status of certificates
  in the index file.

  _Massimiliano Pala <madwolf@comune.modena.it>_

- New '-newreq-nodes' command option to CA.pl. This is like
  '-newreq', but calls 'openssl req' with the '-nodes' option
  so that the resulting key is not encrypted.

  _Damien Miller <djm@mindrot.org>_

- New configuration for the GNU Hurd.

  _Jonathan Bartlett <johnnyb@wolfram.com> via Richard Levitte_

- Initial code to implement OCSP basic response verify. This
  is currently incomplete. Currently just finds the signer's
  certificate and verifies the signature on the response.

  _Steve Henson_

- New SSLeay_version code SSLEAY_DIR to determine the compiled-in
  value of OPENSSLDIR. This is available via the new '-d' option
  to 'openssl version', and is also included in 'openssl version -a'.

  _Bodo Moeller_

- Allowing defining memory allocation callbacks that will be given
  file name and line number information in additional arguments
  (a `const char*` and an int). The basic functionality remains, as
  well as the original possibility to just replace malloc(),
  realloc() and free() by functions that do not know about these
  additional arguments. To register and find out the current
  settings for extended allocation functions, the following
  functions are provided:

              CRYPTO_set_mem_ex_functions
              CRYPTO_set_locked_mem_ex_functions
              CRYPTO_get_mem_ex_functions
              CRYPTO_get_locked_mem_ex_functions

  These work the same way as CRYPTO*set_mem_functions and friends.
  `CRYPTO_get*[locked_]mem*functions`now writes 0 where such an
extended allocation function is enabled.
Similarly,`CRYPTO_get*[locked_]mem_ex_functions` writes 0 where
  a conventional allocation function is enabled.

  _Richard Levitte, Bodo Moeller_

- Finish off removing the remaining LHASH function pointer casts.
  There should no longer be any prototype-casting required when using
  the LHASH abstraction, and any casts that remain are "bugs". See
  the callback types and macros at the head of lhash.h for details
  (and "OBJ_cleanup" in crypto/objects/obj_dat.c as an example).

  _Geoff Thorpe_

- Add automatic query of EGD sockets in RAND_poll() for the unix variant.
  If /dev/[u]random devices are not available or do not return enough
  entropy, EGD style sockets (served by EGD or PRNGD) will automatically
  be queried.
  The locations /var/run/egd-pool, /dev/egd-pool, /etc/egd-pool, and
  /etc/entropy will be queried once each in this sequence, querying stops
  when enough entropy was collected without querying more sockets.

  _Lutz Jaenicke_

- Change the Unix RAND_poll() variant to be able to poll several
  random devices, as specified by DEVRANDOM, until a sufficient amount
  of data has been collected. We spend at most 10 ms on each file
  (select timeout) and read in non-blocking mode. DEVRANDOM now
  defaults to the list "/dev/urandom", "/dev/random", "/dev/srandom"
  (previously it was just the string "/dev/urandom"), so on typical
  platforms the 10 ms delay will never occur.
  Also separate out the Unix variant to its own file, rand_unix.c.
  For VMS, there's a currently-empty rand_vms.c.

  _Richard Levitte_

- Move OCSP client related routines to ocsp_cl.c. These
  provide utility functions which an application needing
  to issue a request to an OCSP responder and analyse the
  response will typically need: as opposed to those which an
  OCSP responder itself would need which will be added later.

  OCSP_request_sign() signs an OCSP request with an API similar
  to PKCS7_sign(). OCSP_response_status() returns status of OCSP
  response. OCSP_response_get1_basic() extracts basic response
  from response. OCSP_resp_find_status(): finds and extracts status
  information from an OCSP_CERTID structure (which will be created
  when the request structure is built). These are built from lower
  level functions which work on OCSP_SINGLERESP structures but
  won't normally be used unless the application wishes to examine
  extensions in the OCSP response for example.

  Replace nonce routines with a pair of functions.
  OCSP_request_add1_nonce() adds a nonce value and optionally
  generates a random value. OCSP_check_nonce() checks the
  validity of the nonce in an OCSP response.

  _Steve Henson_

- Change function OCSP_request_add() to OCSP_request_add0_id().
  This doesn't copy the supplied OCSP_CERTID and avoids the
  need to free up the newly created id. Change return type
  to OCSP_ONEREQ to return the internal OCSP_ONEREQ structure.
  This can then be used to add extensions to the request.
  Deleted OCSP_request_new(), since most of its functionality
  is now in OCSP_REQUEST_new() (and the case insensitive name
  clash) apart from the ability to set the request name which
  will be added elsewhere.

  _Steve Henson_

- Update OCSP API. Remove obsolete extensions argument from
  various functions. Extensions are now handled using the new
  OCSP extension code. New simple OCSP HTTP function which
  can be used to send requests and parse the response.

  _Steve Henson_

- Fix the PKCS#7 (S/MIME) code to work with new ASN1. Two new
  ASN1_ITEM structures help with sign and verify. PKCS7_ATTR_SIGN
  uses the special reorder version of SET OF to sort the attributes
  and reorder them to match the encoded order. This resolves a long
  standing problem: a verify on a PKCS7 structure just after signing
  it used to fail because the attribute order did not match the
  encoded order. PKCS7_ATTR_VERIFY does not reorder the attributes:
  it uses the received order. This is necessary to tolerate some broken
  software that does not order SET OF. This is handled by encoding
  as a SEQUENCE OF but using implicit tagging (with UNIVERSAL class)
  to produce the required SET OF.

  _Steve Henson_

- Have mk1mf.pl generate the macros OPENSSL_BUILD_SHLIBCRYPTO and
  OPENSSL_BUILD_SHLIBSSL and use them appropriately in the header
  files to get correct declarations of the ASN.1 item variables.

  _Richard Levitte_

- Rewrite of PKCS#12 code to use new ASN1 functionality. Replace many
  PKCS#12 macros with real functions. Fix two unrelated ASN1 bugs:
  asn1_check_tlen() would sometimes attempt to use 'ctx' when it was
  NULL and ASN1_TYPE was not dereferenced properly in asn1_ex_c2i().
  New ASN1 macro: DECLARE_ASN1_ITEM() which just declares the relevant
  ASN1_ITEM and no wrapper functions.

  _Steve Henson_

- New functions or ASN1_item_d2i_fp() and ASN1_item_d2i_bio(). These
  replace the old function pointer based I/O routines. Change most of
  the `*_d2i_bio()` and `*_d2i_fp()` functions to use these.

  _Steve Henson_

- Enhance mkdef.pl to be more accepting about spacing in C preprocessor
  lines, recognize more "algorithms" that can be deselected, and make
  it complain about algorithm deselection that isn't recognised.

  _Richard Levitte_

- New ASN1 functions to handle dup, sign, verify, digest, pack and
  unpack operations in terms of ASN1_ITEM. Modify existing wrappers
  to use new functions. Add NO_ASN1_OLD which can be set to remove
  some old style ASN1 functions: this can be used to determine if old
  code will still work when these eventually go away.

  _Steve Henson_

- New extension functions for OCSP structures, these follow the
  same conventions as certificates and CRLs.

  _Steve Henson_

- New function X509V3_add1_i2d(). This automatically encodes and
  adds an extension. Its behaviour can be customised with various
  flags to append, replace or delete. Various wrappers added for
  certificates and CRLs.

  _Steve Henson_

- Fix to avoid calling the underlying ASN1 print routine when
  an extension cannot be parsed. Correct a typo in the
  OCSP_SERVICELOC extension. Tidy up print OCSP format.

  _Steve Henson_

- Make mkdef.pl parse some of the ASN1 macros and add appropriate
  entries for variables.

  _Steve Henson_

- Add functionality to `apps/openssl.c` for detecting locking
  problems: As the program is single-threaded, all we have
  to do is register a locking callback using an array for
  storing which locks are currently held by the program.

  _Bodo Moeller_

- Use a lock around the call to CRYPTO_get_ex_new_index() in
  SSL_get_ex_data_X509_STORE_idx(), which is used in
  ssl_verify_cert_chain() and thus can be called at any time
  during TLS/SSL handshakes so that thread-safety is essential.
  Unfortunately, the ex_data design is not at all suited
  for multi-threaded use, so it probably should be abolished.

  _Bodo Moeller_

- Added Broadcom "ubsec" ENGINE to OpenSSL.

  _Broadcom, tweaked and integrated by Geoff Thorpe_

- Move common extension printing code to new function
  X509V3_print_extensions(). Reorganise OCSP print routines and
  implement some needed OCSP ASN1 functions. Add OCSP extensions.

  _Steve Henson_

- New function X509_signature_print() to remove duplication in some
  print routines.

  _Steve Henson_

- Add a special meaning when SET OF and SEQUENCE OF flags are both
  set (this was treated exactly the same as SET OF previously). This
  is used to reorder the STACK representing the structure to match the
  encoding. This will be used to get round a problem where a PKCS7
  structure which was signed could not be verified because the STACK
  order did not reflect the encoded order.

  _Steve Henson_

- Reimplement the OCSP ASN1 module using the new code.

  _Steve Henson_

- Update the X509V3 code to permit the use of an ASN1_ITEM structure
  for its ASN1 operations. The old style function pointers still exist
  for now but they will eventually go away.

  _Steve Henson_

- Merge in replacement ASN1 code from the ASN1 branch. This almost
  completely replaces the old ASN1 functionality with a table driven
  encoder and decoder which interprets an ASN1_ITEM structure describing
  the ASN1 module. Compatibility with the existing ASN1 API (i2d,d2i) is
  largely maintained. Almost all of the old asn1_mac.h macro based ASN1
  has also been converted to the new form.

  _Steve Henson_

- Change BN_mod_exp_recp so that negative moduli are tolerated
  (the sign is ignored). Similarly, ignore the sign in BN_MONT_CTX_set
  so that BN_mod_exp_mont and BN_mod_exp_mont_word work
  for negative moduli.

  _Bodo Moeller_

- Fix BN_uadd and BN_usub: Always return non-negative results instead
  of not touching the result's sign bit.

  _Bodo Moeller_

- BN_div bugfix: If the result is 0, the sign (res->neg) must not be
  set.

  _Bodo Moeller_

- Changed the LHASH code to use prototypes for callbacks, and created
  macros to declare and implement thin (optionally static) functions
  that provide type-safety and avoid function pointer casting for the
  type-specific callbacks.

  _Geoff Thorpe_

- Added Kerberos Cipher Suites to be used with TLS, as written in
  RFC 2712.
  _Veers Staats <staatsvr@asc.hpc.mil>,
  Jeffrey Altman <jaltman@columbia.edu>, via Richard Levitte_

- Reformat the FAQ so the different questions and answers can be divided
  in sections depending on the subject.

  _Richard Levitte_

- Have the zlib compression code load ZLIB.DLL dynamically under
  Windows.

  _Richard Levitte_

- New function BN_mod_sqrt for computing square roots modulo a prime
  (using the probabilistic Tonelli-Shanks algorithm unless
  p == 3 (mod 4) or p == 5 (mod 8), which are cases that can
  be handled deterministically).

  _Lenka Fibikova <fibikova@exp-math.uni-essen.de>, Bodo Moeller_

- Make BN_mod_inverse faster by explicitly handling small quotients
  in the Euclid loop. (Speed gain about 20% for small moduli [256 or
  512 bits], about 30% for larger ones [1024 or 2048 bits].)

  _Bodo Moeller_

- New function BN_kronecker.

  _Bodo Moeller_

- Fix BN_gcd so that it works on negative inputs; the result is
  positive unless both parameters are zero.
  Previously something reasonably close to an infinite loop was
  possible because numbers could be growing instead of shrinking
  in the implementation of Euclid's algorithm.

  _Bodo Moeller_

- Fix BN_is_word() and BN_is_one() macros to take into account the
  sign of the number in question.

  Fix BN_is_word(a,w) to work correctly for w == 0.

  The old BN*is_word(a,w) macro is now called BN_abs_is_word(a,w)
  because its test if the absolute value of 'a' equals 'w'.
  Note that BN_abs_is_word does \_not* handle w == 0 reliably;
  it exists mostly for use in the implementations of BN_is_zero(),
  BN_is_one(), and BN_is_word().

  _Bodo Moeller_

- New function BN_swap.

  _Bodo Moeller_

- Use BN_nnmod instead of BN_mod in crypto/bn/bn_exp.c so that
  the exponentiation functions are more likely to produce reasonable
  results on negative inputs.

  _Bodo Moeller_

- Change BN_mod_mul so that the result is always non-negative.
  Previously, it could be negative if one of the factors was negative;
  I don't think anyone really wanted that behaviour.

  _Bodo Moeller_

- Move `BN_mod_...` functions into new file `crypto/bn/bn_mod.c`
  (except for exponentiation, which stays in `crypto/bn/bn_exp.c`,
  and `BN_mod_mul_reciprocal`, which stays in `crypto/bn/bn_recp.c`)
  and add new functions:

          BN_nnmod
          BN_mod_sqr
          BN_mod_add
          BN_mod_add_quick
          BN_mod_sub
          BN_mod_sub_quick
          BN_mod_lshift1
          BN_mod_lshift1_quick
          BN_mod_lshift
          BN_mod_lshift_quick

  These functions always generate non-negative results.

  `BN_nnmod` otherwise is `like BN_mod` (if `BN_mod` computes a remainder `r`
  such that `|m| < r < 0`, `BN_nnmod` will output `rem + |m|` instead).

  `BN_mod_XXX_quick(r, a, [b,] m)` generates the same result as
  `BN_mod_XXX(r, a, [b,] m, ctx)`, but requires that `a` [and `b`]
  be reduced modulo `m`.

  _Lenka Fibikova <fibikova@exp-math.uni-essen.de>, Bodo Moeller_

<!--
   The following entry accidentally appeared in the CHANGES file
   distributed with OpenSSL 0.9.7.  The modifications described in
   it do *not* apply to OpenSSL 0.9.7.

 * Remove a few calls to bn_wexpand() in BN_sqr() (the one in there
   was actually never needed) and in BN_mul().  The removal in BN_mul()
   required a small change in bn_mul_part_recursive() and the addition
   of the functions bn_cmp_part_words(), bn_sub_part_words() and
   bn_add_part_words(), which do the same thing as bn_cmp_words(),
   bn_sub_words() and bn_add_words() except they take arrays with
   differing sizes.

   *Richard Levitte*
-->

- In 'openssl passwd', verify passwords read from the terminal
  unless the '-salt' option is used (which usually means that
  verification would just waste user's time since the resulting
  hash is going to be compared with some given password hash)
  or the new '-noverify' option is used.

  This is an incompatible change, but it does not affect
  non-interactive use of 'openssl passwd' (passwords on the command
  line, '-stdin' option, '-in ...' option) and thus should not
  cause any problems.

  _Bodo Moeller_

- Remove all references to RSAref, since there's no more need for it.

  _Richard Levitte_

- Make DSO load along a path given through an environment variable
  (SHLIB_PATH) with shl_load().

  _Richard Levitte_

- Constify the ENGINE code as a result of BIGNUM constification.
  Also constify the RSA code and most things related to it. In a
  few places, most notable in the depth of the ASN.1 code, ugly
  casts back to non-const were required (to be solved at a later
  time)

  _Richard Levitte_

- Make it so the openssl application has all engines loaded by default.

  _Richard Levitte_

- Constify the BIGNUM routines a little more.

  _Richard Levitte_

- Add the following functions:

          ENGINE_load_cswift()
          ENGINE_load_chil()
          ENGINE_load_atalla()
          ENGINE_load_nuron()
          ENGINE_load_builtin_engines()

  That way, an application can itself choose if external engines that
  are built-in in OpenSSL shall ever be used or not. The benefit is
  that applications won't have to be linked with libdl or other dso
  libraries unless it's really needed.

  Changed 'openssl engine' to load all engines on demand.
  Changed the engine header files to avoid the duplication of some
  declarations (they differed!).

  _Richard Levitte_

- 'openssl engine' can now list capabilities.

  _Richard Levitte_

- Better error reporting in 'openssl engine'.

  _Richard Levitte_

- Never call load_dh_param(NULL) in s_server.

  _Bodo Moeller_

- Add engine application. It can currently list engines by name and
  identity, and test if they are actually available.

  _Richard Levitte_

- Improve RPM specification file by forcing symbolic linking and making
  sure the installed documentation is also owned by root.root.

  _Damien Miller <djm@mindrot.org>_

- Give the OpenSSL applications more possibilities to make use of
  keys (public as well as private) handled by engines.

  _Richard Levitte_

- Add OCSP code that comes from CertCo.

  _Richard Levitte_

- Add VMS support for the Rijndael code.

  _Richard Levitte_

- Added untested support for Nuron crypto accelerator.

  _Ben Laurie_

- Add support for external cryptographic devices. This code was
  previously distributed separately as the "engine" branch.

  _Geoff Thorpe, Richard Levitte_

- Rework the filename-translation in the DSO code. It is now possible to
  have far greater control over how a "name" is turned into a filename
  depending on the operating environment and any oddities about the
  different shared library filenames on each system.

  _Geoff Thorpe_

- Support threads on FreeBSD-elf in Configure.

  _Richard Levitte_

- Fix for SHA1 assembly problem with MASM: it produces
  warnings about corrupt line number information when assembling
  with debugging information. This is caused by the overlapping
  of two sections.

  _Bernd Matthes <mainbug@celocom.de>, Steve Henson_

- NCONF changes.
  NCONF_get_number() has no error checking at all. As a replacement,
  NCONF_get_number_e() is defined (`_e` for "error checking") and is
  promoted strongly. The old NCONF_get_number is kept around for
  binary backward compatibility.
  Make it possible for methods to load from something other than a BIO,
  by providing a function pointer that is given a name instead of a BIO.
  For example, this could be used to load configuration data from an
  LDAP server.

  _Richard Levitte_

- Fix for non blocking accept BIOs. Added new I/O special reason
  BIO_RR_ACCEPT to cover this case. Previously use of accept BIOs
  with non blocking I/O was not possible because no retry code was
  implemented. Also added new SSL code SSL_WANT_ACCEPT to cover
  this case.

  _Steve Henson_

- Added the beginnings of Rijndael support.

  _Ben Laurie_

- Fix for bug in DirectoryString mask setting. Add support for
  X509_NAME_print_ex() in 'req' and X509_print_ex() function
  to allow certificate printing to more controllable, additional
  'certopt' option to 'x509' to allow new printing options to be
  set.

  _Steve Henson_

- Clean old EAY MD5 hack from e_os.h.

  _Richard Levitte_

### Changes between 0.9.6l and 0.9.6m [17 Mar 2004]

- Fix null-pointer assignment in do_change_cipher_spec() revealed
  by using the Codenomicon TLS Test Tool ([CVE-2004-0079])

  _Joe Orton, Steve Henson_

### Changes between 0.9.6k and 0.9.6l [04 Nov 2003]

- Fix additional bug revealed by the NISCC test suite:

  Stop bug triggering large recursion when presented with
  certain ASN.1 tags ([CVE-2003-0851])

  _Steve Henson_

### Changes between 0.9.6j and 0.9.6k [30 Sep 2003]

- Fix various bugs revealed by running the NISCC test suite:

  Stop out of bounds reads in the ASN1 code when presented with
  invalid tags (CVE-2003-0543 and CVE-2003-0544).

  If verify callback ignores invalid public key errors don't try to check
  certificate signature with the NULL public key.

  _Steve Henson_

- In ssl3_accept() (ssl/s3_srvr.c) only accept a client certificate
  if the server requested one: as stated in TLS 1.0 and SSL 3.0
  specifications.

  _Steve Henson_

- In ssl3_get_client_hello() (ssl/s3_srvr.c), tolerate additional
  extra data after the compression methods not only for TLS 1.0
  but also for SSL 3.0 (as required by the specification).

  _Bodo Moeller; problem pointed out by Matthias Loepfe_

- Change X509*certificate_type() to mark the key as exported/exportable
  when it's 512 \_bits* long, not 512 bytes.

  _Richard Levitte_

### Changes between 0.9.6i and 0.9.6j [10 Apr 2003]

- Countermeasure against the Klima-Pokorny-Rosa extension of
  Bleichbacher's attack on PKCS #1 v1.5 padding: treat
  a protocol version number mismatch like a decryption error
  in ssl3_get_client_key_exchange (ssl/s3_srvr.c).

  _Bodo Moeller_

- Turn on RSA blinding by default in the default implementation
  to avoid a timing attack. Applications that don't want it can call
  RSA_blinding_off() or use the new flag RSA_FLAG_NO_BLINDING.
  They would be ill-advised to do so in most cases.

  _Ben Laurie, Steve Henson, Geoff Thorpe, Bodo Moeller_

- Change RSA blinding code so that it works when the PRNG is not
  seeded (in this case, the secret RSA exponent is abused as
  an unpredictable seed -- if it is not unpredictable, there
  is no point in blinding anyway). Make RSA blinding thread-safe
  by remembering the creator's thread ID in rsa->blinding and
  having all other threads use local one-time blinding factors
  (this requires more computation than sharing rsa->blinding, but
  avoids excessive locking; and if an RSA object is not shared
  between threads, blinding will still be very fast).

  _Bodo Moeller_

### Changes between 0.9.6h and 0.9.6i [19 Feb 2003]

- In ssl3_get_record (ssl/s3_pkt.c), minimize information leaked
  via timing by performing a MAC computation even if incorrect
  block cipher padding has been found. This is a countermeasure
  against active attacks where the attacker has to distinguish
  between bad padding and a MAC verification error. ([CVE-2003-0078])

  _Bodo Moeller; problem pointed out by Brice Canvel (EPFL),
  Alain Hiltgen (UBS), Serge Vaudenay (EPFL), and
  Martin Vuagnoux (EPFL, Ilion)_

### Changes between 0.9.6g and 0.9.6h [5 Dec 2002]

- New function OPENSSL_cleanse(), which is used to cleanse a section of
  memory from its contents. This is done with a counter that will
  place alternating values in each byte. This can be used to solve
  two issues: 1) the removal of calls to memset() by highly optimizing
  compilers, and 2) cleansing with other values than 0, since those can
  be read through on certain media, for example a swap space on disk.

  _Geoff Thorpe_

- Bugfix: client side session caching did not work with external caching,
  because the session->cipher setting was not restored when reloading
  from the external cache. This problem was masked, when
  SSL_OP_NETSCAPE_REUSE_CIPHER_CHANGE_BUG (part of SSL_OP_ALL) was set.
  (Found by Steve Haslam <steve@araqnid.ddts.net>.)

  _Lutz Jaenicke_

- Fix client_certificate (ssl/s2_clnt.c): The permissible total
  length of the REQUEST-CERTIFICATE message is 18 .. 34, not 17 .. 33.

  _Zeev Lieber <zeev-l@yahoo.com>_

- Undo an undocumented change introduced in 0.9.6e which caused
  repeated calls to OpenSSL_add_all_ciphers() and
  OpenSSL_add_all_digests() to be ignored, even after calling
  EVP_cleanup().

  _Richard Levitte_

- Change the default configuration reader to deal with last line not
  being properly terminated.

  _Richard Levitte_

- Change X509_NAME_cmp() so it applies the special rules on handling
  DN values that are of type PrintableString, as well as RDNs of type
  emailAddress where the value has the type ia5String.

  *stefank@valicert.com via Richard Levitte*

- Add an SSL_SESS_CACHE_NO_INTERNAL_STORE flag to take over half
  the job SSL_SESS_CACHE_NO_INTERNAL_LOOKUP was inconsistently
  doing, define a new flag (SSL_SESS_CACHE_NO_INTERNAL) to be
  the bitwise-OR of the two for use by the majority of applications
  wanting this behaviour, and update the docs. The documented
  behaviour and actual behaviour were inconsistent and had been
  changing anyway, so this is more a bug-fix than a behavioural
  change.

  _Geoff Thorpe, diagnosed by Nadav Har'El_

- Don't impose a 16-byte length minimum on session IDs in ssl/s3_clnt.c
  (the SSL 3.0 and TLS 1.0 specifications allow any length up to 32 bytes).

  _Bodo Moeller_

- Fix initialization code race conditions in
  SSLv23_method(), SSLv23_client_method(), SSLv23_server_method(),
  SSLv2_method(), SSLv2_client_method(), SSLv2_server_method(),
  SSLv3_method(), SSLv3_client_method(), SSLv3_server_method(),
  TLSv1_method(), TLSv1_client_method(), TLSv1_server_method(),
  ssl2_get_cipher_by_char(),
  ssl3_get_cipher_by_char().

  _Patrick McCormick <patrick@tellme.com>, Bodo Moeller_

- Reorder cleanup sequence in SSL_CTX_free(): only remove the ex_data after
  the cached sessions are flushed, as the remove_cb() might use ex_data
  contents. Bug found by Sam Varshavchik <mrsam@courier-mta.com>
  (see [openssl.org #212]).

  _Geoff Thorpe, Lutz Jaenicke_

- Fix typo in OBJ_txt2obj which incorrectly passed the content
  length, instead of the encoding length to d2i_ASN1_OBJECT.

  _Steve Henson_

### Changes between 0.9.6f and 0.9.6g [9 Aug 2002]

- [In 0.9.6g-engine release:]
  Fix crypto/engine/vendor_defns/cswift.h for WIN32 (use `_stdcall`).

  _Lynn Gazis <lgazis@rainbow.com>_

### Changes between 0.9.6e and 0.9.6f [8 Aug 2002]

- Fix ASN1 checks. Check for overflow by comparing with LONG*MAX
  and get fix the header length calculation.
  \_Florian Weimer <Weimer@CERT.Uni-Stuttgart.DE>,
  Alon Kantor <alonk@checkpoint.com> (and others), Steve Henson*

- Use proper error handling instead of 'assertions' in buffer
  overflow checks added in 0.9.6e. This prevents DoS (the
  assertions could call abort()).

  _Arne Ansper <arne@ats.cyber.ee>, Bodo Moeller_

### Changes between 0.9.6d and 0.9.6e [30 Jul 2002]

- Add various sanity checks to asn1_get_length() to reject
  the ASN1 length bytes if they exceed sizeof(long), will appear
  negative or the content length exceeds the length of the
  supplied buffer.

  _Steve Henson, Adi Stav <stav@mercury.co.il>, James Yonan <jim@ntlp.com>_

- Fix cipher selection routines: ciphers without encryption had no flags
  for the cipher strength set and where therefore not handled correctly
  by the selection routines (PR #130).

  _Lutz Jaenicke_

- Fix EVP_dsa_sha macro.

  _Nils Larsch_

- New option
  SSL_OP_DONT_INSERT_EMPTY_FRAGMENTS
  for disabling the SSL 3.0/TLS 1.0 CBC vulnerability countermeasure
  that was added in OpenSSL 0.9.6d.

  As the countermeasure turned out to be incompatible with some
  broken SSL implementations, the new option is part of SSL_OP_ALL.
  SSL_OP_ALL is usually employed when compatibility with weird SSL
  implementations is desired (e.g. '-bugs' option to 's_client' and
  's_server'), so the new option is automatically set in many
  applications.

  _Bodo Moeller_

- Changes in security patch:

  Changes marked "(CHATS)" were sponsored by the Defense Advanced
  Research Projects Agency (DARPA) and Air Force Research Laboratory,
  Air Force Materiel Command, USAF, under agreement number
  F30602-01-2-0537.

- Add various sanity checks to asn1_get_length() to reject
  the ASN1 length bytes if they exceed sizeof(long), will appear
  negative or the content length exceeds the length of the
  supplied buffer. ([CVE-2002-0659])

  _Steve Henson, Adi Stav <stav@mercury.co.il>, James Yonan <jim@ntlp.com>_

- Assertions for various potential buffer overflows, not known to
  happen in practice.

  _Ben Laurie (CHATS)_

- Various temporary buffers to hold ASCII versions of integers were
  too small for 64 bit platforms. ([CVE-2002-0655])
  _Matthew Byng-Maddick <mbm@aldigital.co.uk> and Ben Laurie (CHATS)>_

- Remote buffer overflow in SSL3 protocol - an attacker could
  supply an oversized session ID to a client. ([CVE-2002-0656])

  _Ben Laurie (CHATS)_

- Remote buffer overflow in SSL2 protocol - an attacker could
  supply an oversized client master key. ([CVE-2002-0656])

  _Ben Laurie (CHATS)_

### Changes between 0.9.6c and 0.9.6d [9 May 2002]

- Fix crypto/asn1/a_sign.c so that 'parameters' is omitted (not
  encoded as NULL) with id-dsa-with-sha1.

  _Nils Larsch <nla@trustcenter.de>; problem pointed out by Bodo Moeller_

- Check various `X509_...()` return values in `apps/req.c`.

  _Nils Larsch <nla@trustcenter.de>_

- Fix BASE64 decode (EVP_DecodeUpdate) for data with CR/LF ended lines:
  an end-of-file condition would erroneously be flagged, when the CRLF
  was just at the end of a processed block. The bug was discovered when
  processing data through a buffering memory BIO handing the data to a
  BASE64-decoding BIO. Bug fund and patch submitted by Pavel Tsekov
  <ptsekov@syntrex.com> and Nedelcho Stanev.

  _Lutz Jaenicke_

- Implement a countermeasure against a vulnerability recently found
  in CBC ciphersuites in SSL 3.0/TLS 1.0: Send an empty fragment
  before application data chunks to avoid the use of known IVs
  with data potentially chosen by the attacker.

  _Bodo Moeller_

- Fix length checks in ssl3_get_client_hello().

  _Bodo Moeller_

- TLS/SSL library bugfix: use s->s3->in_read_app_data differently
  to prevent ssl3_read_internal() from incorrectly assuming that
  ssl3_read_bytes() found application data while handshake
  processing was enabled when in fact s->s3->in_read_app_data was
  merely automatically cleared during the initial handshake.

  _Bodo Moeller; problem pointed out by Arne Ansper <arne@ats.cyber.ee>_

- Fix object definitions for Private and Enterprise: they were not
  recognized in their shortname (=lowercase) representation. Extend
  obj_dat.pl to issue an error when using undefined keywords instead
  of silently ignoring the problem (Svenning Sorensen
  <sss@sss.dnsalias.net>).

  _Lutz Jaenicke_

- Fix DH_generate_parameters() so that it works for 'non-standard'
  generators, i.e. generators other than 2 and 5. (Previously, the
  code did not properly initialise the 'add' and 'rem' values to
  BN_generate_prime().)

  In the new general case, we do not insist that 'generator' is
  actually a primitive root: This requirement is rather pointless;
  a generator of the order-q subgroup is just as good, if not
  better.

  _Bodo Moeller_

- Map new X509 verification errors to alerts. Discovered and submitted by
  Tom Wu <tom@arcot.com>.

  _Lutz Jaenicke_

- Fix ssl3_pending() (ssl/s3_lib.c) to prevent SSL_pending() from
  returning non-zero before the data has been completely received
  when using non-blocking I/O.

  _Bodo Moeller; problem pointed out by John Hughes_

- Some of the ciphers missed the strength entry (SSL_LOW etc).

  _Ben Laurie, Lutz Jaenicke_

- Fix bug in SSL_clear(): bad sessions were not removed (found by
  Yoram Zahavi <YoramZ@gilian.com>).

  _Lutz Jaenicke_

- Add information about CygWin 1.3 and on, and preserve proper
  configuration for the versions before that.

  _Corinna Vinschen <vinschen@redhat.com> and Richard Levitte_

- Make removal from session cache (SSL_CTX_remove_session()) more robust:
  check whether we deal with a copy of a session and do not delete from
  the cache in this case. Problem reported by "Izhar Shoshani Levi"
  <izhar@checkpoint.com>.

  _Lutz Jaenicke_

- Do not store session data into the internal session cache, if it
  is never intended to be looked up (SSL_SESS_CACHE_NO_INTERNAL_LOOKUP
  flag is set). Proposed by Aslam <aslam@funk.com>.

  _Lutz Jaenicke_

- Have ASN1_BIT_STRING_set_bit() really clear a bit when the requested
  value is 0.

  _Richard Levitte_

- [In 0.9.6d-engine release:]
  Fix a crashbug and a logic bug in hwcrhk_load_pubkey().

  _Toomas Kiisk <vix@cyber.ee> via Richard Levitte_

- Add the configuration target linux-s390x.

  _Neale Ferguson <Neale.Ferguson@SoftwareAG-USA.com> via Richard Levitte_

- The earlier bugfix for the SSL3_ST_SW_HELLO_REQ_C case of
  ssl3_accept (ssl/s3_srvr.c) incorrectly used a local flag
  variable as an indication that a ClientHello message has been
  received. As the flag value will be lost between multiple
  invocations of ssl3_accept when using non-blocking I/O, the
  function may not be aware that a handshake has actually taken
  place, thus preventing a new session from being added to the
  session cache.

  To avoid this problem, we now set s->new_session to 2 instead of
  using a local variable.

  _Lutz Jaenicke, Bodo Moeller_

- Bugfix: Return -1 from ssl3_get_server_done (ssl3/s3_clnt.c)
  if the SSL_R_LENGTH_MISMATCH error is detected.

  _Geoff Thorpe, Bodo Moeller_

- New 'shared_ldflag' column in Configure platform table.

  _Richard Levitte_

- Fix EVP_CIPHER_mode macro.

  _"Dan S. Camper" <dan@bti.net>_

- Fix ssl3_read_bytes (ssl/s3_pkt.c): To ignore messages of unknown
  type, we must throw them away by setting rr->length to 0.

  _D P Chang <dpc@qualys.com>_

### Changes between 0.9.6b and 0.9.6c [21 dec 2001]

- Fix BN_rand_range bug pointed out by Dominikus Scherkl
  <Dominikus.Scherkl@biodata.com>. (The previous implementation
  worked incorrectly for those cases where range = `10..._2` and
  `3*range` is two bits longer than range.)

  _Bodo Moeller_

- Only add signing time to PKCS7 structures if it is not already
  present.

  _Steve Henson_

- Fix crypto/objects/objects.h: "ld-ce" should be "id-ce",
  OBJ_ld_ce should be OBJ_id_ce.
  Also some ip-pda OIDs in crypto/objects/objects.txt were
  incorrect (cf. RFC 3039).

  _Matt Cooper, Frederic Giudicelli, Bodo Moeller_

- Release CRYPTO_LOCK_DYNLOCK when CRYPTO_destroy_dynlockid()
  returns early because it has nothing to do.

  _Andy Schneider <andy.schneider@bjss.co.uk>_

- [In 0.9.6c-engine release:]
  Fix mutex callback return values in crypto/engine/hw_ncipher.c.

  _Andy Schneider <andy.schneider@bjss.co.uk>_

- [In 0.9.6c-engine release:]
  Add support for Cryptographic Appliance's keyserver technology.
  (Use engine 'keyclient')

  _Cryptographic Appliances and Geoff Thorpe_

- Add a configuration entry for OS/390 Unix. The C compiler 'c89'
  is called via tools/c89.sh because arguments have to be
  rearranged (all '-L' options must appear before the first object
  modules).

  _Richard Shapiro <rshapiro@abinitio.com>_

- [In 0.9.6c-engine release:]
  Add support for Broadcom crypto accelerator cards, backported
  from 0.9.7.

  _Broadcom, Nalin Dahyabhai <nalin@redhat.com>, Mark Cox_

- [In 0.9.6c-engine release:]
  Add support for SureWare crypto accelerator cards from
  Baltimore Technologies. (Use engine 'sureware')

  _Baltimore Technologies and Mark Cox_

- [In 0.9.6c-engine release:]
  Add support for crypto accelerator cards from Accelerated
  Encryption Processing, www.aep.ie. (Use engine 'aep')

  _AEP Inc. and Mark Cox_

- Add a configuration entry for gcc on UnixWare.

  _Gary Benson <gbenson@redhat.com>_

- Change ssl/s2_clnt.c and ssl/s2_srvr.c so that received handshake
  messages are stored in a single piece (fixed-length part and
  variable-length part combined) and fix various bugs found on the way.

  _Bodo Moeller_

- Disable caching in BIO*gethostbyname(), directly use gethostbyname()
  instead. BIO_gethostbyname() does not know what timeouts are
  appropriate, so entries would stay in cache even when they have
  become invalid.
  \_Bodo Moeller; problem pointed out by Rich Salz <rsalz@zolera.com>*

- Change ssl23_get_client_hello (ssl/s23_srvr.c) behaviour when
  faced with a pathologically small ClientHello fragment that does
  not contain client_version: Instead of aborting with an error,
  simply choose the highest available protocol version (i.e.,
  TLS 1.0 unless it is disabled). In practice, ClientHello
  messages are never sent like this, but this change gives us
  strictly correct behaviour at least for TLS.

  _Bodo Moeller_

- Fix SSL handshake functions and SSL_clear() such that SSL_clear()
  never resets s->method to s->ctx->method when called from within
  one of the SSL handshake functions.

  _Bodo Moeller; problem pointed out by Niko Baric_

- In ssl3_get_client_hello (ssl/s3_srvr.c), generate a fatal alert
  (sent using the client's version number) if client_version is
  smaller than the protocol version in use. Also change
  ssl23_get_client_hello (ssl/s23_srvr.c) to select TLS 1.0 if
  the client demanded SSL 3.0 but only TLS 1.0 is enabled; then
  the client will at least see that alert.

  _Bodo Moeller_

- Fix ssl3_get_message (ssl/s3_both.c) to handle message fragmentation
  correctly.

  _Bodo Moeller_

- Avoid infinite loop in ssl3_get_message (ssl/s3_both.c) if a
  client receives HelloRequest while in a handshake.

  _Bodo Moeller; bug noticed by Andy Schneider <andy.schneider@bjss.co.uk>_

- Bugfix in ssl3_accept (ssl/s3_srvr.c): Case SSL3_ST_SW_HELLO_REQ_C
  should end in 'break', not 'goto end' which circumvents various
  cleanups done in state SSL_ST_OK. But session related stuff
  must be disabled for SSL_ST_OK in the case that we just sent a
  HelloRequest.

  Also avoid some overhead by not calling ssl_init_wbio_buffer()
  before just sending a HelloRequest.

  _Bodo Moeller, Eric Rescorla <ekr@rtfm.com>_

- Fix ssl/s3_enc.c, ssl/t1_enc.c and ssl/s3_pkt.c so that we don't
  reveal whether illegal block cipher padding was found or a MAC
  verification error occurred. (Neither SSLerr() codes nor alerts
  are directly visible to potential attackers, but the information
  may leak via logfiles.)

  Similar changes are not required for the SSL 2.0 implementation
  because the number of padding bytes is sent in clear for SSL 2.0,
  and the extra bytes are just ignored. However ssl/s2_pkt.c
  failed to verify that the purported number of padding bytes is in
  the legal range.

  _Bodo Moeller_

- Add OpenUNIX-8 support including shared libraries
  (Boyd Lynn Gerber <gerberb@zenez.com>).

  _Lutz Jaenicke_

- Improve RSA_padding_check_PKCS1_OAEP() check again to avoid
  'wristwatch attack' using huge encoding parameters (cf.
  James H. Manger's CRYPTO 2001 paper). Note that the
  RSA_PKCS1_OAEP_PADDING case of RSA_private_decrypt() does not use
  encoding parameters and hence was not vulnerable.

  _Bodo Moeller_

- BN_sqr() bug fix.

  _Ulf Möller, reported by Jim Ellis <jim.ellis@cavium.com>_

- Rabin-Miller test analyses assume uniformly distributed witnesses,
  so use BN_pseudo_rand_range() instead of using BN_pseudo_rand()
  followed by modular reduction.

  _Bodo Moeller; pointed out by Adam Young <AYoung1@NCSUS.JNJ.COM>_

- Add BN_pseudo_rand_range() with obvious functionality: BN_rand_range()
  equivalent based on BN_pseudo_rand() instead of BN_rand().

  _Bodo Moeller_

- s3_srvr.c: allow sending of large client certificate lists (> 16 kB).
  This function was broken, as the check for a new client hello message
  to handle SGC did not allow these large messages.
  (Tracked down by "Douglas E. Engert" <deengert@anl.gov>.)

  _Lutz Jaenicke_

- Add alert descriptions for TLSv1 to `SSL_alert_desc_string[_long]()`.

  _Lutz Jaenicke_

- Fix buggy behaviour of BIO_get_num_renegotiates() and BIO_ctrl()
  for BIO_C_GET_WRITE_BUF_SIZE ("Stephen Hinton" <shinton@netopia.com>).

  _Lutz Jaenicke_

- Rework the configuration and shared library support for Tru64 Unix.
  The configuration part makes use of modern compiler features and
  still retains old compiler behavior for those that run older versions
  of the OS. The shared library support part includes a variant that
  uses the RPATH feature, and is available through the special
  configuration target "alpha-cc-rpath", which will never be selected
  automatically.

  _Tim Mooney <mooney@dogbert.cc.ndsu.NoDak.edu> via Richard Levitte_

- In ssl3_get_key_exchange (ssl/s3_clnt.c), call ssl3_get_message()
  with the same message size as in ssl3_get_certificate_request().
  Otherwise, if no ServerKeyExchange message occurs, CertificateRequest
  messages might inadvertently be reject as too long.

  _Petr Lampa <lampa@fee.vutbr.cz>_

- Enhanced support for IA-64 Unix platforms (well, Linux and HP-UX).

  _Andy Polyakov_

- Modified SSL library such that the verify_callback that has been set
  specifically for an SSL object with SSL_set_verify() is actually being
  used. Before the change, a verify_callback set with this function was
  ignored and the verify_callback() set in the SSL_CTX at the time of
  the call was used. New function X509_STORE_CTX_set_verify_cb() introduced
  to allow the necessary settings.

  _Lutz Jaenicke_

- Initialize static variable in crypto/dsa/dsa_lib.c and crypto/dh/dh_lib.c
  explicitly to NULL, as at least on Solaris 8 this seems not always to be
  done automatically (in contradiction to the requirements of the C
  standard). This made problems when used from OpenSSH.

  _Lutz Jaenicke_

- In OpenSSL 0.9.6a and 0.9.6b, crypto/dh/dh_key.c ignored
  dh->length and always used

          BN_rand_range(priv_key, dh->p).

  BN_rand_range() is not necessary for Diffie-Hellman, and this
  specific range makes Diffie-Hellman unnecessarily inefficient if
  dh->length (recommended exponent length) is much smaller than the
  length of dh->p. We could use BN_rand_range() if the order of
  the subgroup was stored in the DH structure, but we only have
  dh->length.

  So switch back to

          BN_rand(priv_key, l, ...)

  where 'l' is dh->length if this is defined, or BN_num_bits(dh->p)-1
  otherwise.

  _Bodo Moeller_

- In

          RSA_eay_public_encrypt
          RSA_eay_private_decrypt
          RSA_eay_private_encrypt (signing)
          RSA_eay_public_decrypt (signature verification)

  (default implementations for RSA_public_encrypt,
  RSA_private_decrypt, RSA_private_encrypt, RSA_public_decrypt),
  always reject numbers >= n.

  _Bodo Moeller_

- In crypto/rand/md_rand.c, use a new short-time lock CRYPTO_LOCK_RAND2
  to synchronize access to 'locking_thread'. This is necessary on
  systems where access to 'locking_thread' (an 'unsigned long'
  variable) is not atomic.

  _Bodo Moeller_

- In crypto/rand/md*rand.c, set 'locking_thread' to current thread's ID
  \_before* setting the 'crypto_lock_rand' flag. The previous code had
  a race condition if 0 is a valid thread ID.

  _Travis Vitek <vitek@roguewave.com>_

- Add support for shared libraries under Irix.

  _Albert Chin-A-Young <china@thewrittenword.com>_

- Add configuration option to build on Linux on both big-endian and
  little-endian MIPS.

  _Ralf Baechle <ralf@uni-koblenz.de>_

- Add the possibility to create shared libraries on HP-UX.

  _Richard Levitte_

### Changes between 0.9.6a and 0.9.6b [9 Jul 2001]

- Change ssleay_rand_bytes (crypto/rand/md_rand.c)
  to avoid an SSLeay/OpenSSL PRNG weakness pointed out by
  Markku-Juhani O. Saarinen <markku-juhani.saarinen@nokia.com>:
  PRNG state recovery was possible based on the output of
  one PRNG request appropriately sized to gain knowledge on
  'md' followed by enough consecutive 1-byte PRNG requests
  to traverse all of 'state'.
  1.  When updating 'md_local' (the current thread's copy of 'md')
      during PRNG output generation, hash all of the previous
      'md_local' value, not just the half used for PRNG output.

  2.  Make the number of bytes from 'state' included into the hash
      independent from the number of PRNG bytes requested.

  The first measure alone would be sufficient to avoid
  Markku-Juhani's attack. (Actually it had never occurred
  to me that the half of 'md_local' used for chaining was the
  half from which PRNG output bytes were taken -- I had always
  assumed that the secret half would be used.) The second
  measure makes sure that additional data from 'state' is never
  mixed into 'md_local' in small portions; this heuristically
  further strengthens the PRNG.

  _Bodo Moeller_

- Fix crypto/bn/asm/mips3.s.

  _Andy Polyakov_

- When only the key is given to "enc", the IV is undefined. Print out
  an error message in this case.

  _Lutz Jaenicke_

- Handle special case when X509_NAME is empty in X509 printing routines.

  _Steve Henson_

- In dsa_do_verify (crypto/dsa/dsa_ossl.c), verify that r and s are
  positive and less than q.

  _Bodo Moeller_

- Don't change `*pointer` in CRYPTO_add_lock() is add_lock_callback is
  used: it isn't thread safe and the add_lock_callback should handle
  that itself.

  _Paul Rose <Paul.Rose@bridge.com>_

- Verify that incoming data obeys the block size in
  ssl3_enc (ssl/s3_enc.c) and tls1_enc (ssl/t1_enc.c).

  _Bodo Moeller_

- Fix OAEP check.

  _Ulf Möller, Bodo Möller_

- The countermeasure against Bleichbacher's attack on PKCS #1 v1.5
  RSA encryption was accidentally removed in s3_srvr.c in OpenSSL 0.9.5
  when fixing the server behaviour for backwards-compatible 'client
  hello' messages. (Note that the attack is impractical against
  SSL 3.0 and TLS 1.0 anyway because length and version checking
  means that the probability of guessing a valid ciphertext is
  around 2^-40; see section 5 in Bleichenbacher's CRYPTO '98
  paper.)

  Before 0.9.5, the countermeasure (hide the error by generating a
  random 'decryption result') did not work properly because
  ERR_clear_error() was missing, meaning that SSL_get_error() would
  detect the supposedly ignored error.

  Both problems are now fixed.

  _Bodo Moeller_

- In crypto/bio/bf_buff.c, increase DEFAULT_BUFFER_SIZE to 4096
  (previously it was 1024).

  _Bodo Moeller_

- Fix for compatibility mode trust settings: ignore trust settings
  unless some valid trust or reject settings are present.

  _Steve Henson_

- Fix for blowfish EVP: its a variable length cipher.

  _Steve Henson_

- Fix various bugs related to DSA S/MIME verification. Handle missing
  parameters in DSA public key structures and return an error in the
  DSA routines if parameters are absent.

  _Steve Henson_

- In versions up to 0.9.6, RAND_file_name() resorted to file ".rnd"
  in the current directory if neither $RANDFILE nor $HOME was set.
  RAND_file_name() in 0.9.6a returned NULL in this case. This has
  caused some confusion to Windows users who haven't defined $HOME.
  Thus RAND_file_name() is changed again: e_os.h can define a
  DEFAULT_HOME, which will be used if $HOME is not set.
  For Windows, we use "C:"; on other platforms, we still require
  environment variables.

- Move 'if (!initialized) RAND_poll()' into regions protected by
  CRYPTO_LOCK_RAND. This is not strictly necessary, but avoids
  having multiple threads call RAND_poll() concurrently.

  _Bodo Moeller_

- In crypto/rand/md*rand.c, replace 'add_do_not_lock' flag by a
  combination of a flag and a thread ID variable.
  Otherwise while one thread is in ssleay_rand_bytes (which sets the
  flag), \_other* threads can enter ssleay_add_bytes without obeying
  the CRYPTO_LOCK_RAND lock (and may even illegally release the lock
  that they do not hold after the first thread unsets add_do_not_lock).

  _Bodo Moeller_

- Change bctest again: '-x' expressions are not available in all
  versions of 'test'.

  _Bodo Moeller_

### Changes between 0.9.6 and 0.9.6a [5 Apr 2001]

- Fix a couple of memory leaks in PKCS7_dataDecode()

  _Steve Henson, reported by Heyun Zheng <hzheng@atdsprint.com>_

- Change Configure and Makefiles to provide EXE_EXT, which will contain
  the default extension for executables, if any. Also, make the perl
  scripts that use symlink() to test if it really exists and use "cp"
  if it doesn't. All this made OpenSSL compilable and installable in
  CygWin.

  _Richard Levitte_

- Fix for asn1_GetSequence() for indefinite length constructed data.
  If SEQUENCE is length is indefinite just set c->slen to the total
  amount of data available.

  _Steve Henson, reported by shige@FreeBSD.org_

  _This change does not apply to 0.9.7._

- Change bctest to avoid here-documents inside command substitution
  (workaround for FreeBSD /bin/sh bug).
  For compatibility with Ultrix, avoid shell functions (introduced
  in the bctest version that searches along $PATH).

  _Bodo Moeller_

- Rename 'des_encrypt' to 'des_encrypt1'. This avoids the clashes
  with des_encrypt() defined on some operating systems, like Solaris
  and UnixWare.

  _Richard Levitte_

- Check the result of RSA-CRT (see D. Boneh, R. DeMillo, R. Lipton:
  On the Importance of Eliminating Errors in Cryptographic
  Computations, J. Cryptology 14 (2001) 2, 101-119,
  <http://theory.stanford.edu/~dabo/papers/faults.ps.gz>).

  _Ulf Moeller_

- MIPS assembler BIGNUM division bug fix.

  _Andy Polyakov_

- Disabled incorrect Alpha assembler code.

  _Richard Levitte_

- Fix PKCS#7 decode routines so they correctly update the length
  after reading an EOC for the EXPLICIT tag.

  _Steve Henson_

  _This change does not apply to 0.9.7._

- Fix bug in PKCS#12 key generation routines. This was triggered
  if a 3DES key was generated with a 0 initial byte. Include
  PKCS12_BROKEN_KEYGEN compilation option to retain the old
  (but broken) behaviour.

  _Steve Henson_

- Enhance bctest to search for a working bc along $PATH and print
  it when found.

  _Tim Rice <tim@multitalents.net> via Richard Levitte_

- Fix memory leaks in err.c: free err_data string if necessary;
  don't write to the wrong index in ERR_set_error_data.

  _Bodo Moeller_

- Implement ssl23_peek (analogous to ssl23_read), which previously
  did not exist.

  _Bodo Moeller_

- Replace rdtsc with `_emit` statements for VC++ version 5.

  _Jeremy Cooper <jeremy@baymoo.org>_

- Make it possible to reuse SSLv2 sessions.

  _Richard Levitte_

- In copy_email() check for >= 0 as a return value for
  X509_NAME_get_index_by_NID() since 0 is a valid index.

  _Steve Henson reported by Massimiliano Pala <madwolf@opensca.org>_

- Avoid coredump with unsupported or invalid public keys by checking if
  X509_get_pubkey() fails in PKCS7_verify(). Fix memory leak when
  PKCS7_verify() fails with non detached data.

  _Steve Henson_

- Don't use getenv in library functions when run as setuid/setgid.
  New function OPENSSL_issetugid().

  _Ulf Moeller_

- Avoid false positives in memory leak detection code (crypto/mem_dbg.c)
  due to incorrect handling of multi-threading:
  1.  Fix timing glitch in the MemCheck_off() portion of CRYPTO_mem_ctrl().

  2.  Fix logical glitch in is_MemCheck_on() aka CRYPTO_is_mem_check_on().

  3.  Count how many times MemCheck_off() has been called so that
      nested use can be treated correctly. This also avoids
      inband-signalling in the previous code (which relied on the
      assumption that thread ID 0 is impossible).

  _Bodo Moeller_

- Add "-rand" option also to s_client and s_server.

  _Lutz Jaenicke_

- Fix CPU detection on Irix 6.x.
  _Kurt Hockenbury <khockenb@stevens-tech.edu> and
  "Bruce W. Forsberg" <bruce.forsberg@baesystems.com>_

- Fix X509_NAME bug which produced incorrect encoding if X509_NAME
  was empty.

  _Steve Henson_

  _This change does not apply to 0.9.7._

- Use the cached encoding of an X509_NAME structure rather than
  copying it. This is apparently the reason for the libsafe "errors"
  but the code is actually correct.

  _Steve Henson_

- Add new function BN*rand_range(), and fix DSA_sign_setup() to prevent
  Bleichenbacher's DSA attack.
  Extend BN*[pseudo_]rand: As before, top=1 forces the highest two bits
  to be set and top=0 forces the highest bit to be set; top=-1 is new
  and leaves the highest bit random.

  _Ulf Moeller, Bodo Moeller_

- In the `NCONF_...`-based implementations for `CONF_...` queries
  (crypto/conf/conf_lib.c), if the input LHASH is NULL, avoid using
  a temporary CONF structure with the data component set to NULL
  (which gives segmentation faults in lh_retrieve).
  Instead, use NULL for the CONF pointer in CONF_get_string and
  CONF_get_number (which may use environment variables) and directly
  return NULL from CONF_get_section.

  _Bodo Moeller_

- Fix potential buffer overrun for EBCDIC.

  _Ulf Moeller_

- Tolerate nonRepudiation as being valid for S/MIME signing and certSign
  keyUsage if basicConstraints absent for a CA.

  _Steve Henson_

- Make SMIME_write_PKCS7() write mail header values with a format that
  is more generally accepted (no spaces before the semicolon), since
  some programs can't parse those values properly otherwise. Also make
  sure BIO's that break lines after each write do not create invalid
  headers.

  _Richard Levitte_

- Make the CRL encoding routines work with empty SEQUENCE OF. The
  macros previously used would not encode an empty SEQUENCE OF
  and break the signature.

  _Steve Henson_

  _This change does not apply to 0.9.7._

- Zero the premaster secret after deriving the master secret in
  DH ciphersuites.

  _Steve Henson_

- Add some EVP_add_digest_alias registrations (as found in
  OpenSSL_add_all_digests()) to SSL_library_init()
  aka OpenSSL_add_ssl_algorithms(). This provides improved
  compatibility with peers using X.509 certificates
  with unconventional AlgorithmIdentifier OIDs.

  _Bodo Moeller_

- Fix for Irix with NO_ASM.

  _"Bruce W. Forsberg" <bruce.forsberg@baesystems.com>_

- ./config script fixes.

  _Ulf Moeller, Richard Levitte_

- Fix 'openssl passwd -1'.

  _Bodo Moeller_

- Change PKCS12_key_gen_asc() so it can cope with non null
  terminated strings whose length is passed in the passlen
  parameter, for example from PEM callbacks. This was done
  by adding an extra length parameter to asc2uni().

  _Steve Henson, reported by <oddissey@samsung.co.kr>_

- Fix C code generated by 'openssl dsaparam -C': If a BN_bin2bn
  call failed, free the DSA structure.

  _Bodo Moeller_

- Fix to uni2asc() to cope with zero length Unicode strings.
  These are present in some PKCS#12 files.

  _Steve Henson_

- Increase s2->wbuf allocation by one byte in ssl2_new (ssl/s2_lib.c).
  Otherwise do_ssl_write (ssl/s2_pkt.c) will write beyond buffer limits
  when writing a 32767 byte record.

  _Bodo Moeller; problem reported by Eric Day <eday@concentric.net>_

- In `RSA_eay_public_{en,ed}crypt` and RSA*eay_mod_exp (rsa_eay.c),
  obtain lock CRYPTO_LOCK_RSA before setting `rsa->\_method_mod*{n,p,q}`.

  (RSA objects have a reference count access to which is protected
  by CRYPTO*LOCK_RSA [see rsa_lib.c, s3_srvr.c, ssl_cert.c, ssl_rsa.c],
  so they are meant to be shared between threads.)
  \_Bodo Moeller, Geoff Thorpe; original patch submitted by
  "Reddie, Steven" <Steven.Reddie@ca.com>*

- Fix a deadlock in CRYPTO_mem_leaks().

  _Bodo Moeller_

- Use better test patterns in bntest.

  _Ulf Möller_

- rand_win.c fix for Borland C.

  _Ulf Möller_

- BN_rshift bugfix for n == 0.

  _Bodo Moeller_

- Add a 'bctest' script that checks for some known 'bc' bugs
  so that 'make test' does not abort just because 'bc' is broken.

  _Bodo Moeller_

- Store verify_result within SSL_SESSION also for client side to
  avoid potential security hole. (Reused sessions on the client side
  always resulted in verify_result==X509_V_OK, not using the original
  result of the server certificate verification.)

  _Lutz Jaenicke_

- Fix ssl3_pending: If the record in s->s3->rrec is not of type
  SSL3_RT_APPLICATION_DATA, return 0.
  Similarly, change ssl2_pending to return 0 if SSL_in_init(s) is true.

  _Bodo Moeller_

- Fix SSL*peek:
  Both ssl2_peek and ssl3_peek, which were totally broken in earlier
  releases, have been re-implemented by renaming the previous
  implementations of ssl2_read and ssl3_read to ssl2_read_internal
  and ssl3_read_internal, respectively, and adding 'peek' parameters
  to them. The new ssl[23]*{read,peek} functions are calls to
  ssl[23]\_read_internal with the 'peek' flag set appropriately.
  A 'peek' parameter has also been added to ssl3_read_bytes, which
  does the actual work for ssl3_read_internal.

  _Bodo Moeller_

- Initialise "ex_data" member of RSA/DSA/DH structures prior to calling
  the method-specific "init()" handler. Also clean up ex_data after
  calling the method-specific "finish()" handler. Previously, this was
  happening the other way round.

  _Geoff Thorpe_

- Increase BN_CTX_NUM (the number of BIGNUMs in a BN_CTX) to 16.
  The previous value, 12, was not always sufficient for BN_mod_exp().

  _Bodo Moeller_

- Make sure that shared libraries get the internal name engine with
  the full version number and not just 0. This should mark the
  shared libraries as not backward compatible. Of course, this should
  be changed again when we can guarantee backward binary compatibility.

  _Richard Levitte_

- Fix typo in get_cert_by_subject() in by_dir.c

  _Jean-Marc Desperrier <jean-marc.desperrier@certplus.com>_

- Rework the system to generate shared libraries:
  - Make note of the expected extension for the shared libraries and
    if there is a need for symbolic links from for example libcrypto.so.0
    to libcrypto.so.0.9.7. There is extended info in Configure for
    that.

  - Make as few rebuilds of the shared libraries as possible.

  - Still avoid linking the OpenSSL programs with the shared libraries.

  - When installing, install the shared libraries separately from the
    static ones.

  _Richard Levitte_

- Fix SSL_CTX_set_read_ahead macro to actually use its argument.

  Copy SSL_CTX's read_ahead flag to SSL object directly in SSL_new
  and not in SSL_clear because the latter is also used by the
  accept/connect functions; previously, the settings made by
  SSL_set_read_ahead would be lost during the handshake.

  _Bodo Moeller; problems reported by Anders Gertz <gertz@epact.se>_

- Correct util/mkdef.pl to be selective about disabled algorithms.
  Previously, it would create entries for disabled algorithms no
  matter what.

  _Richard Levitte_

- Added several new manual pages for SSL\_\* function.

  _Lutz Jaenicke_

### Changes between 0.9.5a and 0.9.6 [24 Sep 2000]

- In ssl23_get_client_hello, generate an error message when faced
  with an initial SSL 3.0/TLS record that is too small to contain the
  first two bytes of the ClientHello message, i.e. client_version.
  (Note that this is a pathologic case that probably has never happened
  in real life.) The previous approach was to use the version number
  from the record header as a substitute; but our protocol choice
  should not depend on that one because it is not authenticated
  by the Finished messages.

  _Bodo Moeller_

- More robust randomness gathering functions for Windows.

  _Jeffrey Altman <jaltman@columbia.edu>_

- For compatibility reasons if the flag X509_V_FLAG_ISSUER_CHECK is
  not set then we don't setup the error code for issuer check errors
  to avoid possibly overwriting other errors which the callback does
  handle. If an application does set the flag then we assume it knows
  what it is doing and can handle the new informational codes
  appropriately.

  _Steve Henson_

- Fix for a nasty bug in ASN1_TYPE handling. ASN1_TYPE is used for
  a general "ANY" type, as such it should be able to decode anything
  including tagged types. However it didn't check the class so it would
  wrongly interpret tagged types in the same way as their universal
  counterpart and unknown types were just rejected. Changed so that the
  tagged and unknown types are handled in the same way as a SEQUENCE:
  that is the encoding is stored intact. There is also a new type
  "V_ASN1_OTHER" which is used when the class is not universal, in this
  case we have no idea what the actual type is so we just lump them all
  together.

  _Steve Henson_

- On VMS, stdout may very well lead to a file that is written to
  in a record-oriented fashion. That means that every write() will
  write a separate record, which will be read separately by the
  programs trying to read from it. This can be very confusing.

  The solution is to put a BIO filter in the way that will buffer
  text until a linefeed is reached, and then write everything a
  line at a time, so every record written will be an actual line,
  not chunks of lines and not (usually doesn't happen, but I've
  seen it once) several lines in one record. BIO_f_linebuffer() is
  the answer.

  Currently, it's a VMS-only method, because that's where it has
  been tested well enough.

  _Richard Levitte_

- Remove 'optimized' squaring variant in BN_mod_mul_montgomery,
  it can return incorrect results.
  (Note: The buggy variant was not enabled in OpenSSL 0.9.5a,
  but it was in 0.9.6-beta[12].)

  _Bodo Moeller_

- Disable the check for content being present when verifying detached
  signatures in pk7_smime.c. Some versions of Netscape (wrongly)
  include zero length content when signing messages.

  _Steve Henson_

- New BIO_shutdown_wr macro, which invokes the BIO_C_SHUTDOWN_WR
  BIO_ctrl (for BIO pairs).

  _Bodo Möller_

- Add DSO method for VMS.

  _Richard Levitte_

- Bug fix: Montgomery multiplication could produce results with the
  wrong sign.

  _Ulf Möller_

- Add RPM specification openssl.spec and modify it to build three
  packages. The default package contains applications, application
  documentation and run-time libraries. The devel package contains
  include files, static libraries and function documentation. The
  doc package contains the contents of the doc directory. The original
  openssl.spec was provided by Damien Miller <djm@mindrot.org>.

  _Richard Levitte_

- Add a large number of documentation files for many SSL routines.

  _Lutz Jaenicke <Lutz.Jaenicke@aet.TU-Cottbus.DE>_

- Add a configuration entry for Sony News 4.

  _NAKAJI Hiroyuki <nakaji@tutrp.tut.ac.jp>_

- Don't set the two most significant bits to one when generating a
  random number < q in the DSA library.

  _Ulf Möller_

- New SSL API mode 'SSL_MODE_AUTO_RETRY'. This disables the default
  behaviour that SSL_read may result in SSL_ERROR_WANT_READ (even if
  the underlying transport is blocking) if a handshake took place.
  (The default behaviour is needed by applications such as s_client
  and s_server that use select() to determine when to use SSL_read;
  but for applications that know in advance when to expect data, it
  just makes things more complicated.)

  _Bodo Moeller_

- Add RAND_egd_bytes(), which gives control over the number of bytes read
  from EGD.

  _Ben Laurie_

- Add a few more EBCDIC conditionals that make `req` and `x509`
  work better on such systems.

  _Martin Kraemer <Martin.Kraemer@MchP.Siemens.De>_

- Add two demo programs for PKCS12_parse() and PKCS12_create().
  Update PKCS12_parse() so it copies the friendlyName and the
  keyid to the certificates aux info.

  _Steve Henson_

- Fix bug in PKCS7_verify() which caused an infinite loop
  if there was more than one signature.

  _Sven Uszpelkat <su@celocom.de>_

- Major change in util/mkdef.pl to include extra information
  about each symbol, as well as presenting variables as well
  as functions. This change means that there's n more need
  to rebuild the .num files when some algorithms are excluded.

  _Richard Levitte_

- Allow the verify time to be set by an application,
  rather than always using the current time.

  _Steve Henson_

- Phase 2 verify code reorganisation. The certificate
  verify code now looks up an issuer certificate by a
  number of criteria: subject name, authority key id
  and key usage. It also verifies self signed certificates
  by the same criteria. The main comparison function is
  X509_check_issued() which performs these checks.

  Lot of changes were necessary in order to support this
  without completely rewriting the lookup code.

  Authority and subject key identifier are now cached.

  The LHASH 'certs' is X509_STORE has now been replaced
  by a STACK_OF(X509_OBJECT). This is mainly because an
  LHASH can't store or retrieve multiple objects with
  the same hash value.

  As a result various functions (which were all internal
  use only) have changed to handle the new X509_STORE
  structure. This will break anything that messed round
  with X509_STORE internally.

  The functions X509_STORE_add_cert() now checks for an
  exact match, rather than just subject name.

  The X509_STORE API doesn't directly support the retrieval
  of multiple certificates matching a given criteria, however
  this can be worked round by performing a lookup first
  (which will fill the cache with candidate certificates)
  and then examining the cache for matches. This is probably
  the best we can do without throwing out X509_LOOKUP
  entirely (maybe later...).

  The X509_VERIFY_CTX structure has been enhanced considerably.

  All certificate lookup operations now go via a get_issuer()
  callback. Although this currently uses an X509_STORE it
  can be replaced by custom lookups. This is a simple way
  to bypass the X509_STORE hackery necessary to make this
  work and makes it possible to use more efficient techniques
  in future. A very simple version which uses a simple
  STACK for its trusted certificate store is also provided
  using X509_STORE_CTX_trusted_stack().

  The verify_cb() and verify() callbacks now have equivalents
  in the X509_STORE_CTX structure.

  X509_STORE_CTX also has a 'flags' field which can be used
  to customise the verify behaviour.

  _Steve Henson_

- Add new PKCS#7 signing option PKCS7_NOSMIMECAP which
  excludes S/MIME capabilities.

  _Steve Henson_

- When a certificate request is read in keep a copy of the
  original encoding of the signed data and use it when outputting
  again. Signatures then use the original encoding rather than
  a decoded, encoded version which may cause problems if the
  request is improperly encoded.

  _Steve Henson_

- For consistency with other BIO_puts implementations, call
  buffer_write(b, ...) directly in buffer_puts instead of calling
  BIO_write(b, ...).

  In BIO_puts, increment b->num_write as in BIO_write.

  *Peter.Sylvester@EdelWeb.fr*

- Fix BN_mul_word for the case where the word is 0. (We have to use
  BN_zero, we may not return a BIGNUM with an array consisting of
  words set to zero.)

  _Bodo Moeller_

- Avoid calling abort() from within the library when problems are
  detected, except if preprocessor symbols have been defined
  (such as REF_CHECK, BN_DEBUG etc.).

  _Bodo Moeller_

- New openssl application 'rsautl'. This utility can be
  used for low-level RSA operations. DER public key
  BIO/fp routines also added.

  _Steve Henson_

- New Configure entry and patches for compiling on QNX 4.

  _Andreas Schneider <andreas@ds3.etech.fh-hamburg.de>_

- A demo state-machine implementation was sponsored by
  Nuron (<http://www.nuron.com/>) and is now available in
  demos/state_machine.

  _Ben Laurie_

- New options added to the 'dgst' utility for signature
  generation and verification.

  _Steve Henson_

- Unrecognized PKCS#7 content types are now handled via a
  catch all ASN1_TYPE structure. This allows unsupported
  types to be stored as a "blob" and an application can
  encode and decode it manually.

  _Steve Henson_

- Fix various signed/unsigned issues to make a_strex.c
  compile under VC++.

  _Oscar Jacobsson <oscar.jacobsson@celocom.com>_

- ASN1 fixes. i2d_ASN1_OBJECT was not returning the correct
  length if passed a buffer. ASN1_INTEGER_to_BN failed
  if passed a NULL BN and its argument was negative.

  _Steve Henson, pointed out by Sven Heiberg <sven@tartu.cyber.ee>_

- Modification to PKCS#7 encoding routines to output definite
  length encoding. Since currently the whole structures are in
  memory there's not real point in using indefinite length
  constructed encoding. However if OpenSSL is compiled with
  the flag PKCS7_INDEFINITE_ENCODING the old form is used.

  _Steve Henson_

- Added BIO_vprintf() and BIO_vsnprintf().

  _Richard Levitte_

- Added more prefixes to parse for in the strings written
  through a logging bio, to cover all the levels that are available
  through syslog. The prefixes are now:

          PANIC, EMERG, EMR       =>      LOG_EMERG
          ALERT, ALR              =>      LOG_ALERT
          CRIT, CRI               =>      LOG_CRIT
          ERROR, ERR              =>      LOG_ERR
          WARNING, WARN, WAR      =>      LOG_WARNING
          NOTICE, NOTE, NOT       =>      LOG_NOTICE
          INFO, INF               =>      LOG_INFO
          DEBUG, DBG              =>      LOG_DEBUG

  and as before, if none of those prefixes are present at the
  beginning of the string, LOG_ERR is chosen.

  On Win32, the `LOG_*` levels are mapped according to this:

          LOG_EMERG, LOG_ALERT, LOG_CRIT, LOG_ERR => EVENTLOG_ERROR_TYPE
          LOG_WARNING                             => EVENTLOG_WARNING_TYPE
          LOG_NOTICE, LOG_INFO, LOG_DEBUG         => EVENTLOG_INFORMATION_TYPE

  _Richard Levitte_

- Made it possible to reconfigure with just the configuration
  argument "reconf" or "reconfigure". The command line arguments
  are stored in Makefile.ssl in the variable CONFIGURE_ARGS,
  and are retrieved from there when reconfiguring.

  _Richard Levitte_

- MD4 implemented.

  _Assar Westerlund <assar@sics.se>, Richard Levitte_

- Add the arguments -CAfile and -CApath to the pkcs12 utility.

  _Richard Levitte_

- The obj_dat.pl script was messing up the sorting of object
  names. The reason was that it compared the quoted version
  of strings as a result "OCSP" > "OCSP Signing" because
  " > SPACE. Changed script to store unquoted versions of
  names and add quotes on output. It was also omitting some
  names from the lookup table if they were given a default
  value (that is if SN is missing it is given the same
  value as LN and vice versa), these are now added on the
  grounds that if an object has a name we should be able to
  look it up. Finally added warning output when duplicate
  short or long names are found.

  _Steve Henson_

- Changes needed for Tandem NSK.

  _Scott Uroff <scott@xypro.com>_

- Fix SSL 2.0 rollback checking: Due to an off-by-one error in
  RSA_padding_check_SSLv23(), special padding was never detected
  and thus the SSL 3.0/TLS 1.0 countermeasure against protocol
  version rollback attacks was not effective.

  In s23_clnt.c, don't use special rollback-attack detection padding
  (RSA_SSLV23_PADDING) if SSL 2.0 is the only protocol enabled in the
  client; similarly, in s23_srvr.c, don't do the rollback check if
  SSL 2.0 is the only protocol enabled in the server.

  _Bodo Moeller_

- Make it possible to get hexdumps of unprintable data with 'openssl
  asn1parse'. By implication, the functions ASN1_parse_dump() and
  BIO_dump_indent() are added.

  _Richard Levitte_

- New functions ASN1_STRING_print_ex() and X509_NAME_print_ex()
  these print out strings and name structures based on various
  flags including RFC2253 support and proper handling of
  multibyte characters. Added options to the 'x509' utility
  to allow the various flags to be set.

  _Steve Henson_

- Various fixes to use ASN1_TIME instead of ASN1_UTCTIME.
  Also change the functions X509_cmp_current_time() and
  X509_gmtime_adj() work with an ASN1_TIME structure,
  this will enable certificates using GeneralizedTime in validity
  dates to be checked.

  _Steve Henson_

- Make the NEG_PUBKEY_BUG code (which tolerates invalid
  negative public key encodings) on by default,
  NO_NEG_PUBKEY_BUG can be set to disable it.

  _Steve Henson_

- New function c2i_ASN1_OBJECT() which acts on ASN1_OBJECT
  content octets. An i2c_ASN1_OBJECT is unnecessary because
  the encoding can be trivially obtained from the structure.

  _Steve Henson_

- crypto/err.c locking bugfix: Use write locks (`CRYPTO_w_[un]lock`),
  not read locks (`CRYPTO_r_[un]lock`).

  _Bodo Moeller_

- A first attempt at creating official support for shared
  libraries through configuration. I've kept it so the
  default is static libraries only, and the OpenSSL programs
  are always statically linked for now, but there are
  preparations for dynamic linking in place.
  This has been tested on Linux and Tru64.

  _Richard Levitte_

- Randomness polling function for Win9x, as described in:
  Peter Gutmann, Software Generation of Practically Strong
  Random Numbers.

  _Ulf Möller_

- Fix so PRNG is seeded in req if using an already existing
  DSA key.

  _Steve Henson_

- New options to smime application. -inform and -outform
  allow alternative formats for the S/MIME message including
  PEM and DER. The -content option allows the content to be
  specified separately. This should allow things like Netscape
  form signing output easier to verify.

  _Steve Henson_

- Fix the ASN1 encoding of tags using the 'long form'.

  _Steve Henson_

- New ASN1 functions, `i2c_*` and `c2i_*` for INTEGER and BIT
  STRING types. These convert content octets to and from the
  underlying type. The actual tag and length octets are
  already assumed to have been read in and checked. These
  are needed because all other string types have virtually
  identical handling apart from the tag. By having versions
  of the ASN1 functions that just operate on content octets
  IMPLICIT tagging can be handled properly. It also allows
  the ASN1_ENUMERATED code to be cut down because ASN1_ENUMERATED
  and ASN1_INTEGER are identical apart from the tag.

  _Steve Henson_

- Change the handling of OID objects as follows:
  - New object identifiers are inserted in objects.txt, following
    the syntax given in [crypto/objects/README.md](crypto/objects/README.md).
  - objects.pl is used to process obj_mac.num and create a new
    obj_mac.h.
  - obj_dat.pl is used to create a new obj_dat.h, using the data in
    obj_mac.h.

  This is currently kind of a hack, and the perl code in objects.pl
  isn't very elegant, but it works as I intended. The simplest way
  to check that it worked correctly is to look in obj_dat.h and
  check the array nid_objs and make sure the objects haven't moved
  around (this is important!). Additions are OK, as well as
  consistent name changes.

  _Richard Levitte_

- Add BSD-style MD5-based passwords to 'openssl passwd' (option '-1').

  _Bodo Moeller_

- Addition of the command line parameter '-rand file' to 'openssl req'.
  The given file adds to whatever has already been seeded into the
  random pool through the RANDFILE configuration file option or
  environment variable, or the default random state file.

  _Richard Levitte_

- mkstack.pl now sorts each macro group into lexical order.
  Previously the output order depended on the order the files
  appeared in the directory, resulting in needless rewriting
  of safestack.h .

  _Steve Henson_

- Patches to make OpenSSL compile under Win32 again. Mostly
  work arounds for the VC++ problem that it treats func() as
  func(void). Also stripped out the parts of mkdef.pl that
  added extra typesafe functions: these no longer exist.

  _Steve Henson_

- Reorganisation of the stack code. The macros are now all
  collected in safestack.h . Each macro is defined in terms of
  a "stack macro" of the form `SKM_<name>(type, a, b)`. The
  DEBUG_SAFESTACK is now handled in terms of function casts,
  this has the advantage of retaining type safety without the
  use of additional functions. If DEBUG_SAFESTACK is not defined
  then the non typesafe macros are used instead. Also modified the
  mkstack.pl script to handle the new form. Needs testing to see
  if which (if any) compilers it chokes and maybe make DEBUG_SAFESTACK
  the default if no major problems. Similar behaviour for ASN1_SET_OF
  and PKCS12_STACK_OF.

  _Steve Henson_

- When some versions of IIS use the 'NET' form of private key the
  key derivation algorithm is different. Normally MD5(password) is
  used as a 128 bit RC4 key. In the modified case
  MD5(MD5(password) + "SGCKEYSALT") is used instead. Added some
  new functions i2d_RSA_NET(), d2i_RSA_NET() etc which are the same
  as the old Netscape_RSA functions except they have an additional
  'sgckey' parameter which uses the modified algorithm. Also added
  an -sgckey command line option to the rsa utility. Thanks to
  Adrian Peck <bertie@ncipher.com> for posting details of the modified
  algorithm to openssl-dev.

  _Steve Henson_

- The evp_local.h macros were using 'c.##kname' which resulted in
  invalid expansion on some systems (SCO 5.0.5 for example).
  Corrected to 'c.kname'.

  _Phillip Porch <root@theporch.com>_

- New X509_get1_email() and X509_REQ_get1_email() functions that return
  a STACK of email addresses from a certificate or request, these look
  in the subject name and the subject alternative name extensions and
  omit any duplicate addresses.

  _Steve Henson_

- Re-implement BN_mod_exp2_mont using independent (and larger) windows.
  This makes DSA verification about 2 % faster.

  _Bodo Moeller_

- Increase maximum window size in `BN_mod_exp_...` to 6 bits instead of 5
  (meaning that now 2^5 values will be precomputed, which is only 4 KB
  plus overhead for 1024 bit moduli).
  This makes exponentiations about 0.5 % faster for 1024 bit
  exponents (as measured by "openssl speed rsa2048").

  _Bodo Moeller_

- Rename memory handling macros to avoid conflicts with other
  software:
  Malloc => OPENSSL_malloc
  Malloc_locked => OPENSSL_malloc_locked
  Realloc => OPENSSL_realloc
  Free => OPENSSL_free

  _Richard Levitte_

- New function BN_mod_exp_mont_word for small bases (roughly 15%
  faster than BN_mod_exp_mont, i.e. 7% for a full DH exchange).

  _Bodo Moeller_

- CygWin32 support.

  _John Jarvie <jjarvie@newsguy.com>_

- The type-safe stack code has been rejigged. It is now only compiled
  in when OpenSSL is configured with the DEBUG_SAFESTACK option and
  by default all type-specific stack functions are "#define"d back to
  standard stack functions. This results in more streamlined output
  but retains the type-safety checking possibilities of the original
  approach.

  _Geoff Thorpe_

- The STACK code has been cleaned up, and certain type declarations
  that didn't make a lot of sense have been brought in line. This has
  also involved a cleanup of sorts in safestack.h to more correctly
  map type-safe stack functions onto their plain stack counterparts.
  This work has also resulted in a variety of "const"ifications of
  lots of the code, especially `_cmp` operations which should normally
  be prototyped with "const" parameters anyway.

  _Geoff Thorpe_

- When generating bytes for the first time in md_rand.c, 'stir the pool'
  by seeding with STATE_SIZE dummy bytes (with zero entropy count).
  (The PRNG state consists of two parts, the large pool 'state' and 'md',
  where all of 'md' is used each time the PRNG is used, but 'state'
  is used only indexed by a cyclic counter. As entropy may not be
  well distributed from the beginning, 'md' is important as a
  chaining variable. However, the output function chains only half
  of 'md', i.e. 80 bits. ssleay_rand_add, on the other hand, chains
  all of 'md', and seeding with STATE_SIZE dummy bytes will result
  in all of 'state' being rewritten, with the new values depending
  on virtually all of 'md'. This overcomes the 80 bit limitation.)

  _Bodo Moeller_

- In ssl/s2_clnt.c and ssl/s3_clnt.c, call ERR_clear_error() when
  the handshake is continued after ssl_verify_cert_chain();
  otherwise, if SSL_VERIFY_NONE is set, remaining error codes
  can lead to 'unexplainable' connection aborts later.

  _Bodo Moeller; problem tracked down by Lutz Jaenicke_

- Major EVP API cipher revision.
  Add hooks for extra EVP features. This allows various cipher
  parameters to be set in the EVP interface. Support added for variable
  key length ciphers via the EVP_CIPHER_CTX_set_key_length() function and
  setting of RC2 and RC5 parameters.

  Modify EVP_OpenInit() and EVP_SealInit() to cope with variable key length
  ciphers.

  Remove lots of duplicated code from the EVP library. For example _every_
  cipher init() function handles the 'iv' in the same way according to the
  cipher mode. They also all do nothing if the 'key' parameter is NULL and
  for CFB and OFB modes they zero ctx->num.

  New functionality allows removal of S/MIME code RC2 hack.

  Most of the routines have the same form and so can be declared in terms
  of macros.

  By shifting this to the top level EVP_CipherInit() it can be removed from
  all individual ciphers. If the cipher wants to handle IVs or keys
  differently it can set the EVP_CIPH_CUSTOM_IV or EVP_CIPH_ALWAYS_CALL_INIT
  flags.

  Change lots of functions like EVP_EncryptUpdate() to now return a
  value: although software versions of the algorithms cannot fail
  any installed hardware versions can.

  _Steve Henson_

- Implement SSL_OP_TLS_ROLLBACK_BUG: In ssl3_get_client_key_exchange, if
  this option is set, tolerate broken clients that send the negotiated
  protocol version number instead of the requested protocol version
  number.

  _Bodo Moeller_

- Call dh_tmp_cb (set by `..._TMP_DH_CB`) with correct 'is_export' flag;
  i.e. non-zero for export ciphersuites, zero otherwise.
  Previous versions had this flag inverted, inconsistent with
  rsa_tmp_cb (...\_TMP_RSA_CB).

  _Bodo Moeller; problem reported by Amit Chopra_

- Add missing DSA library text string. Work around for some IIS
  key files with invalid SEQUENCE encoding.

  _Steve Henson_

- Add a document (doc/standards.txt) that list all kinds of standards
  and so on that are implemented in OpenSSL.

  _Richard Levitte_

- Enhance c_rehash script. Old version would mishandle certificates
  with the same subject name hash and wouldn't handle CRLs at all.
  Added -fingerprint option to crl utility, to support new c_rehash
  features.

  _Steve Henson_

- Eliminate non-ANSI declarations in crypto.h and stack.h.

  _Ulf Möller_

- Fix for SSL server purpose checking. Server checking was
  rejecting certificates which had extended key usage present
  but no ssl client purpose.

  _Steve Henson, reported by Rene Grosser <grosser@hisolutions.com>_

- Make PKCS#12 code work with no password. The PKCS#12 spec
  is a little unclear about how a blank password is handled.
  Since the password in encoded as a BMPString with terminating
  double NULL a zero length password would end up as just the
  double NULL. However no password at all is different and is
  handled differently in the PKCS#12 key generation code. NS
  treats a blank password as zero length. MSIE treats it as no
  password on export: but it will try both on import. We now do
  the same: PKCS12_parse() tries zero length and no password if
  the password is set to "" or NULL (NULL is now a valid password:
  it wasn't before) as does the pkcs12 application.

  _Steve Henson_

- Bugfixes in `apps/x509.c`: Avoid a memory leak; and don't use
  perror when PEM_read_bio_X509_REQ fails, the error message must
  be obtained from the error queue.

  _Bodo Moeller_

- Avoid 'thread_hash' memory leak in crypto/err/err.c by freeing
  it in ERR_remove_state if appropriate, and change ERR_get_state
  accordingly to avoid race conditions (this is necessary because
  thread_hash is no longer constant once set).

  _Bodo Moeller_

- Bugfix for linux-elf makefile.one.

  _Ulf Möller_

- RSA_get_default_method() will now cause a default
  RSA_METHOD to be chosen if one doesn't exist already.
  Previously this was only set during a call to RSA_new()
  or RSA_new_method(NULL) meaning it was possible for
  RSA_get_default_method() to return NULL.

  _Geoff Thorpe_

- Added native name translation to the existing DSO code
  that will convert (if the flag to do so is set) filenames
  that are sufficiently small and have no path information
  into a canonical native form. Eg. "blah" converted to
  "libblah.so" or "blah.dll" etc.

  _Geoff Thorpe_

- New function ERR_error_string_n(e, buf, len) which is like
  ERR_error_string(e, buf), but writes at most 'len' bytes
  including the 0 terminator. For ERR_error_string_n, 'buf'
  may not be NULL.

  _Damien Miller <djm@mindrot.org>, Bodo Moeller_

- CONF library reworked to become more general. A new CONF
  configuration file reader "class" is implemented as well as a
  new functions (`NCONF_*`, for "New CONF") to handle it. The now
  old `CONF_*` functions are still there, but are reimplemented to
  work in terms of the new functions. Also, a set of functions
  to handle the internal storage of the configuration data is
  provided to make it easier to write new configuration file
  reader "classes" (I can definitely see something reading a
  configuration file in XML format, for example), called `_CONF_*`,
  or "the configuration storage API"...

  The new configuration file reading functions are:

              NCONF_new, NCONF_free, NCONF_load, NCONF_load_fp, NCONF_load_bio,
              NCONF_get_section, NCONF_get_string, NCONF_get_numbre

              NCONF_default, NCONF_WIN32

              NCONF_dump_fp, NCONF_dump_bio

  NCONF*default and NCONF_WIN32 are method (or "class") choosers,
  NCONF_new creates a new CONF object. This works in the same way
  as other interfaces in OpenSSL, like the BIO interface.
  `NCONF_dump*\_`dump the internal storage of the configuration file,
which is useful for debugging.  All other functions take the same
arguments as the old`CONF\__`functions with the exception of the
first that must be a`CONF _`instead of a`LHASH \_`.

  To make it easier to use the new classes with the old `CONF_*` functions,
  the function CONF_set_default_method is provided.

  _Richard Levitte_

- Add '-tls1' option to 'openssl ciphers', which was already
  mentioned in the documentation but had not been implemented.
  (This option is not yet really useful because even the additional
  experimental TLS 1.0 ciphers are currently treated as SSL 3.0 ciphers.)

  _Bodo Moeller_

- Initial DSO code added into libcrypto for letting OpenSSL (and
  OpenSSL-based applications) load shared libraries and bind to
  them in a portable way.

  _Geoff Thorpe, with contributions from Richard Levitte_

### Changes between 0.9.5 and 0.9.5a [1 Apr 2000]

- Make sure \_lrotl and \_lrotr are only used with MSVC.

- Use lock CRYPTO_LOCK_RAND correctly in ssleay_rand_status
  (the default implementation of RAND_status).

- Rename openssl x509 option '-crlext', which was added in 0.9.5,
  to '-clrext' (= clear extensions), as intended and documented.
  _Bodo Moeller; inconsistency pointed out by Michael Attili
  <attili@amaxo.com>_

- Fix for HMAC. It wasn't zeroing the rest of the block if the key length
  was larger than the MD block size.

  _Steve Henson, pointed out by Yost William <YostW@tce.com>_

- Modernise PKCS12_parse() so it uses STACK_OF(X509) for its ca argument
  fix a leak when the ca argument was passed as NULL. Stop X509_PUBKEY_set()
  using the passed key: if the passed key was a private key the result
  of X509_print(), for example, would be to print out all the private key
  components.

  _Steve Henson_

- des*quad_cksum() byte order bug fix.
  \_Ulf Möller, using the problem description in krb4-0.9.7, where
  the solution is attributed to Derrick J Brashear <shadow@DEMENTIA.ORG>*

- Fix so V_ASN1_APP_CHOOSE works again: however its use is strongly
  discouraged.

  _Steve Henson, pointed out by Brian Korver <briank@cs.stanford.edu>_

- For easily testing in shell scripts whether some command
  'openssl XXX' exists, the new pseudo-command 'openssl no-XXX'
  returns with exit code 0 iff no command of the given name is available.
  'no-XXX' is printed in this case, 'XXX' otherwise. In both cases,
  the output goes to stdout and nothing is printed to stderr.
  Additional arguments are always ignored.

  Since for each cipher there is a command of the same name,
  the 'no-cipher' compilation switches can be tested this way.

  ('openssl no-XXX' is not able to detect pseudo-commands such
  as 'quit', 'list-XXX-commands', or 'no-XXX' itself.)

  _Bodo Moeller_

- Update test suite so that 'make test' succeeds in 'no-rsa' configuration.

  _Bodo Moeller_

- For SSL*[CTX*]set_tmp_dh, don't create a DH key if SSL_OP_SINGLE_DH_USE
  is set; it will be thrown away anyway because each handshake creates
  its own key.
  ssl_cert_dup, which is used by SSL_new, now copies DH keys in addition
  to parameters -- in previous versions (since OpenSSL 0.9.3) the
  'default key' from SSL_CTX_set_tmp_dh would always be lost, meaning
  you effectively got SSL_OP_SINGLE_DH_USE when using this macro.

  _Bodo Moeller_

- New s_client option -ign_eof: EOF at stdin is ignored, and
  'Q' and 'R' lose their special meanings (quit/renegotiate).
  This is part of what -quiet does; unlike -quiet, -ign_eof
  does not suppress any output.

  _Richard Levitte_

- Add compatibility options to the purpose and trust code. The
  purpose X509_PURPOSE_ANY is "any purpose" which automatically
  accepts a certificate or CA, this was the previous behaviour,
  with all the associated security issues.

  X509_TRUST_COMPAT is the old trust behaviour: only and
  automatically trust self signed roots in certificate store. A
  new trust setting X509_TRUST_DEFAULT is used to specify that
  a purpose has no associated trust setting and it should instead
  use the value in the default purpose.

  _Steve Henson_

- Fix the PKCS#8 DSA private key code so it decodes keys again
  and fix a memory leak.

  _Steve Henson_

- In util/mkerr.pl (which implements 'make errors'), preserve
  reason strings from the previous version of the .c file, as
  the default to have only downcase letters (and digits) in
  automatically generated reasons codes is not always appropriate.

  _Bodo Moeller_

- In ERR_load_ERR_strings(), build an ERR_LIB_SYS error reason table
  using strerror. Previously, ERR_reason_error_string() returned
  library names as reason strings for SYSerr; but SYSerr is a special
  case where small numbers are errno values, not library numbers.

  _Bodo Moeller_

- Add '-dsaparam' option to 'openssl dhparam' application. This
  converts DSA parameters into DH parameters. (When creating parameters,
  DSA_generate_parameters is used.)

  _Bodo Moeller_

- Include 'length' (recommended exponent length) in C code generated
  by 'openssl dhparam -C'.

  _Bodo Moeller_

- The second argument to set_label in perlasm was already being used
  so couldn't be used as a "file scope" flag. Moved to third argument
  which was free.

  _Steve Henson_

- In PEM_ASN1_write_bio and some other functions, use RAND_pseudo_bytes
  instead of RAND_bytes for encryption IVs and salts.

  _Bodo Moeller_

- Include RAND_status() into RAND_METHOD instead of implementing
  it only for md_rand.c Otherwise replacing the PRNG by calling
  RAND_set_rand_method would be impossible.

  _Bodo Moeller_

- Don't let DSA_generate_key() enter an infinite loop if the random
  number generation fails.

  _Bodo Moeller_

- New 'rand' application for creating pseudo-random output.

  _Bodo Moeller_

- Added configuration support for Linux/IA64

  _Rolf Haberrecker <rolf@suse.de>_

- Assembler module support for Mingw32.

  _Ulf Möller_

- Shared library support for HPUX (in shlib/).

  _Lutz Jaenicke <Lutz.Jaenicke@aet.TU-Cottbus.DE> and Anonymous_

- Shared library support for Solaris gcc.

  _Lutz Behnke <behnke@trustcenter.de>_

### Changes between 0.9.4 and 0.9.5 [28 Feb 2000]

- PKCS7_encrypt() was adding text MIME headers twice because they
  were added manually and by SMIME_crlf_copy().

  _Steve Henson_

- In bntest.c don't call BN_rand with zero bits argument.

  _Steve Henson, pointed out by Andrew W. Gray <agray@iconsinc.com>_

- BN_mul bugfix: In bn_mul_part_recursion() only the a>a[n] && b>b[n]
  case was implemented. This caused BN_div_recp() to fail occasionally.

  _Ulf Möller_

- Add an optional second argument to the set_label() in the perl
  assembly language builder. If this argument exists and is set
  to 1 it signals that the assembler should use a symbol whose
  scope is the entire file, not just the current function. This
  is needed with MASM which uses the format label:: for this scope.

  _Steve Henson, pointed out by Peter Runestig <peter@runestig.com>_

- Change the ASN1 types so they are typedefs by default. Before
  almost all types were #define'd to ASN1_STRING which was causing
  STACK_OF() problems: you couldn't declare STACK_OF(ASN1_UTF8STRING)
  for example.

  _Steve Henson_

- Change names of new functions to the new get1/get0 naming
  convention: After 'get1', the caller owns a reference count
  and has to call `..._free`; 'get0' returns a pointer to some
  data structure without incrementing reference counters.
  (Some of the existing 'get' functions increment a reference
  counter, some don't.)
  Similarly, 'set1' and 'add1' functions increase reference
  counters or duplicate objects.

  _Steve Henson_

- Allow for the possibility of temp RSA key generation failure:
  the code used to assume it always worked and crashed on failure.

  _Steve Henson_

- Fix potential buffer overrun problem in BIO*printf().
  \_Ulf Möller, using public domain code by Patrick Powell; problem
  pointed out by David Sacerdote <das33@cornell.edu>*

- Support EGD <http://www.lothar.com/tech/crypto/>. New functions
  RAND_egd() and RAND_status(). In the command line application,
  the EGD socket can be specified like a seed file using RANDFILE
  or -rand.

  _Ulf Möller_

- Allow the string CERTIFICATE to be tolerated in PKCS#7 structures.
  Some CAs (e.g. Verisign) distribute certificates in this form.

  _Steve Henson_

- Remove the SSL_ALLOW_ADH compile option and set the default cipher
  list to exclude them. This means that no special compilation option
  is needed to use anonymous DH: it just needs to be included in the
  cipher list.

  _Steve Henson_

- Change the EVP_MD_CTX_type macro so its meaning consistent with
  EVP_MD_type. The old functionality is available in a new macro called
  EVP_MD_md(). Change code that uses it and update docs.

  _Steve Henson_

- `..._ctrl` functions now have corresponding `..._callback_ctrl` functions
  where the `void *` argument is replaced by a function pointer argument.
  Previously `void *` was abused to point to functions, which works on
  many platforms, but is not correct. As these functions are usually
  called by macros defined in OpenSSL header files, most source code
  should work without changes.

  _Richard Levitte_

- `<openssl/opensslconf.h>` (which is created by Configure) now contains
  sections with information on -D... compiler switches used for
  compiling the library so that applications can see them. To enable
  one of these sections, a pre-processor symbol `OPENSSL_..._DEFINES`
  must be defined. E.g.,
  #define OPENSSL*ALGORITHM_DEFINES
  #include <openssl/opensslconf.h>
  defines all pertinent `NO*<algo>` symbols, such as NO_IDEA, NO_RSA, etc.

  _Richard Levitte, Ulf and Bodo Möller_

- Bugfix: Tolerate fragmentation and interleaving in the SSL 3/TLS
  record layer.

  _Bodo Moeller_

- Change the 'other' type in certificate aux info to a STACK_OF
  X509_ALGOR. Although not an AlgorithmIdentifier as such it has
  the required ASN1 format: arbitrary types determined by an OID.

  _Steve Henson_

- Add some PEM_write_X509_REQ_NEW() functions and a command line
  argument to 'req'. This is not because the function is newer or
  better than others it just uses the work 'NEW' in the certificate
  request header lines. Some software needs this.

  _Steve Henson_

- Reorganise password command line arguments: now passwords can be
  obtained from various sources. Delete the PEM_cb function and make
  it the default behaviour: i.e. if the callback is NULL and the
  usrdata argument is not NULL interpret it as a null terminated pass
  phrase. If usrdata and the callback are NULL then the pass phrase
  is prompted for as usual.

  _Steve Henson_

- Add support for the Compaq Atalla crypto accelerator. If it is installed,
  the support is automatically enabled. The resulting binaries will
  autodetect the card and use it if present.

  _Ben Laurie and Compaq Inc._

- Work around for Netscape hang bug. This sends certificate request
  and server done in one record. Since this is perfectly legal in the
  SSL/TLS protocol it isn't a "bug" option and is on by default. See
  the bugs/SSLv3 entry for more info.

  _Steve Henson_

- HP-UX tune-up: new unified configs, HP C compiler bug workaround.

  _Andy Polyakov_

- Add -rand argument to smime and pkcs12 applications and read/write
  of seed file.

  _Steve Henson_

- New 'passwd' tool for crypt(3) and apr1 password hashes.

  _Bodo Moeller_

- Add command line password options to the remaining applications.

  _Steve Henson_

- Bug fix for BN_div_recp() for numerators with an even number of
  bits.

  _Ulf Möller_

- More tests in bntest.c, and changed test_bn output.

  _Ulf Möller_

- ./config recognizes MacOS X now.

  _Andy Polyakov_

- Bug fix for BN_div() when the first words of num and divisor are
  equal (it gave wrong results if `(rem=(n1-q*d0)&BN_MASK2) < d0)`.

  _Ulf Möller_

- Add support for various broken PKCS#8 formats, and command line
  options to produce them.

  _Steve Henson_

- New functions BN_CTX_start(), BN_CTX_get() and BT_CTX_end() to
  get temporary BIGNUMs from a BN_CTX.

  _Ulf Möller_

- Correct return values in BN_mod_exp_mont() and BN_mod_exp2_mont()
  for p == 0.

  _Ulf Möller_

- Change the `SSLeay_add_all_*()` functions to `OpenSSL_add_all_*()` and
  include a #define from the old name to the new. The original intent
  was that statically linked binaries could for example just call
  SSLeay_add_all_ciphers() to just add ciphers to the table and not
  link with digests. This never worked because SSLeay_add_all_digests()
  and SSLeay_add_all_ciphers() were in the same source file so calling
  one would link with the other. They are now in separate source files.

  _Steve Henson_

- Add a new -notext option to 'ca' and a -pubkey option to 'spkac'.

  _Steve Henson_

- Use a less unusual form of the Miller-Rabin primality test (it used
  a binary algorithm for exponentiation integrated into the Miller-Rabin
  loop, our standard modexp algorithms are faster).

  _Bodo Moeller_

- Support for the EBCDIC character set completed.

  _Martin Kraemer <Martin.Kraemer@Mch.SNI.De>_

- Source code cleanups: use const where appropriate, eliminate casts,
  use `void *` instead of `char *` in lhash.

  _Ulf Möller_

- Bugfix: ssl3_send_server_key_exchange was not restartable
  (the state was not changed to SSL3_ST_SW_KEY_EXCH_B, and because of
  this the server could overwrite ephemeral keys that the client
  has already seen).

  _Bodo Moeller_

- Turn DSA_is_prime into a macro that calls BN_is_prime,
  using 50 iterations of the Rabin-Miller test.

  DSA_generate_parameters now uses BN_is_prime_fasttest (with 50
  iterations of the Rabin-Miller test as required by the appendix
  to FIPS PUB 186[-1]) instead of DSA_is_prime.
  As BN_is_prime_fasttest includes trial division, DSA parameter
  generation becomes much faster.

  This implies a change for the callback functions in DSA_is_prime
  and DSA_generate_parameters: The callback function is called once
  for each positive witness in the Rabin-Miller test, not just
  occasionally in the inner loop; and the parameters to the
  callback function now provide an iteration count for the outer
  loop rather than for the current invocation of the inner loop.
  DSA_generate_parameters additionally can call the callback
  function with an 'iteration count' of -1, meaning that a
  candidate has passed the trial division test (when q is generated
  from an application-provided seed, trial division is skipped).

  _Bodo Moeller_

- New function BN_is_prime_fasttest that optionally does trial
  division before starting the Rabin-Miller test and has
  an additional BN_CTX \* argument (whereas BN_is_prime always
  has to allocate at least one BN_CTX).
  'callback(1, -1, cb_arg)' is called when a number has passed the
  trial division stage.

  _Bodo Moeller_

- Fix for bug in CRL encoding. The validity dates weren't being handled
  as ASN1_TIME.

  _Steve Henson_

- New -pkcs12 option to CA.pl script to write out a PKCS#12 file.

  _Steve Henson_

- New function BN_pseudo_rand().

  _Ulf Möller_

- Clean up BN_mod_mul_montgomery(): replace the broken (and unreadable)
  bignum version of BN_from_montgomery() with the working code from
  SSLeay 0.9.0 (the word based version is faster anyway), and clean up
  the comments.

  _Ulf Möller_

- Avoid a race condition in s2_clnt.c (function get_server_hello) that
  made it impossible to use the same SSL_SESSION data structure in
  SSL2 clients in multiple threads.

  _Bodo Moeller_

- The return value of RAND_load_file() no longer counts bytes obtained
  by stat(). RAND_load_file(..., -1) is new and uses the complete file
  to seed the PRNG (previously an explicit byte count was required).

  _Ulf Möller, Bodo Möller_

- Clean up CRYPTO_EX_DATA functions, some of these didn't have prototypes
  used `char *` instead of `void *` and had casts all over the place.

  _Steve Henson_

- Make BN_generate_prime() return NULL on error if ret!=NULL.

  _Ulf Möller_

- Retain source code compatibility for BN_prime_checks macro:
  BN_is_prime(..., BN_prime_checks, ...) now uses
  BN_prime_checks_for_size to determine the appropriate number of
  Rabin-Miller iterations.

  _Ulf Möller_

- Diffie-Hellman uses "safe" primes: DH_check() return code renamed to
  DH_CHECK_P_NOT_SAFE_PRIME.
  (Check if this is true? OpenPGP calls them "strong".)

  _Ulf Möller_

- Merge the functionality of "dh" and "gendh" programs into a new program
  "dhparam". The old programs are retained for now but will handle DH keys
  (instead of parameters) in future.

  _Steve Henson_

- Make the ciphers, s_server and s_client programs check the return values
  when a new cipher list is set.

  _Steve Henson_

- Enhance the SSL/TLS cipher mechanism to correctly handle the TLS 56bit
  ciphers. Before when the 56bit ciphers were enabled the sorting was
  wrong.

  The syntax for the cipher sorting has been extended to support sorting by
  cipher-strength (using the strength_bits hard coded in the tables).
  The new command is `@STRENGTH` (see also `doc/apps/ciphers.pod`).

  Fix a bug in the cipher-command parser: when supplying a cipher command
  string with an "undefined" symbol (neither command nor alphanumeric
  _A-Za-z0-9_, ssl_set_cipher_list used to hang in an endless loop. Now
  an error is flagged.

  Due to the strength-sorting extension, the code of the
  ssl_create_cipher_list() function was completely rearranged. I hope that
  the readability was also increased :-)

  _Lutz Jaenicke <Lutz.Jaenicke@aet.TU-Cottbus.DE>_

- Minor change to 'x509' utility. The -CAcreateserial option now uses 1
  for the first serial number and places 2 in the serial number file. This
  avoids problems when the root CA is created with serial number zero and
  the first user certificate has the same issuer name and serial number
  as the root CA.

  _Steve Henson_

- Fixes to X509_ATTRIBUTE utilities, change the 'req' program so it uses
  the new code. Add documentation for this stuff.

  _Steve Henson_

- Changes to X509*ATTRIBUTE utilities. These have been renamed from
  `X509*\_()`to`X509at\_\_()` on the grounds that they don't handle X509
  structures and behave in an analogous way to the X509v3 functions:
  they shouldn't be called directly but wrapper functions should be used
  instead.

  So we also now have some wrapper functions that call the X509at functions
  when passed certificate requests. (TO DO: similar things can be done with
  PKCS#7 signed and unsigned attributes, PKCS#12 attributes and a few other
  things. Some of these need some d2i or i2d and print functionality
  because they handle more complex structures.)

  _Steve Henson_

- Add missing #ifndefs that caused missing symbols when building libssl
  as a shared library without RSA. Use #ifndef NO_SSL2 instead of
  NO_RSA in `ssl/s2*.c`.

  _Kris Kennaway <kris@hub.freebsd.org>, modified by Ulf Möller_

- Precautions against using the PRNG uninitialized: RAND_bytes() now
  has a return value which indicates the quality of the random data
  (1 = ok, 0 = not seeded). Also an error is recorded on the thread's
  error queue. New function RAND_pseudo_bytes() generates output that is
  guaranteed to be unique but not unpredictable. RAND_add is like
  RAND_seed, but takes an extra argument for an entropy estimate
  (RAND_seed always assumes full entropy).

  _Ulf Möller_

- Do more iterations of Rabin-Miller probable prime test (specifically,
  3 for 1024-bit primes, 6 for 512-bit primes, 12 for 256-bit primes
  instead of only 2 for all lengths; see BN_prime_checks_for_size definition
  in crypto/bn/bn_prime.c for the complete table). This guarantees a
  false-positive rate of at most 2^-80 for random input.

  _Bodo Moeller_

- Rewrite ssl3_read_n (ssl/s3_pkt.c) avoiding a couple of bugs.

  _Bodo Moeller_

- New function X509_CTX_rget_chain() (renamed to X509_CTX_get1_chain
  in the 0.9.5 release), this returns the chain
  from an X509_CTX structure with a dup of the stack and all
  the X509 reference counts upped: so the stack will exist
  after X509_CTX_cleanup() has been called. Modify pkcs12.c
  to use this.

  Also make SSL_SESSION_print() print out the verify return
  code.

  _Steve Henson_

- Add manpage for the pkcs12 command. Also change the default
  behaviour so MAC iteration counts are used unless the new
  -nomaciter option is used. This improves file security and
  only older versions of MSIE (4.0 for example) need it.

  _Steve Henson_

- Honor the no-xxx Configure options when creating .DEF files.

  _Ulf Möller_

- Add PKCS#10 attributes to field table: challengePassword,
  unstructuredName and unstructuredAddress. These are taken from
  draft PKCS#9 v2.0 but are compatible with v1.2 provided no
  international characters are used.

  More changes to X509_ATTRIBUTE code: allow the setting of types
  based on strings. Remove the 'loc' parameter when adding
  attributes because these will be a SET OF encoding which is sorted
  in ASN1 order.

  _Steve Henson_

- Initial changes to the 'req' utility to allow request generation
  automation. This will allow an application to just generate a template
  file containing all the field values and have req construct the
  request.

  Initial support for X509_ATTRIBUTE handling. Stacks of these are
  used all over the place including certificate requests and PKCS#7
  structures. They are currently handled manually where necessary with
  some primitive wrappers for PKCS#7. The new functions behave in a
  manner analogous to the X509 extension functions: they allow
  attributes to be looked up by NID and added.

  Later something similar to the X509V3 code would be desirable to
  automatically handle the encoding, decoding and printing of the
  more complex types. The string types like challengePassword can
  be handled by the string table functions.

  Also modified the multi byte string table handling. Now there is
  a 'global mask' which masks out certain types. The table itself
  can use the flag STABLE_NO_MASK to ignore the mask setting: this
  is useful when for example there is only one permissible type
  (as in countryName) and using the mask might result in no valid
  types at all.

  _Steve Henson_

- Clean up 'Finished' handling, and add functions SSL_get_finished and
  SSL_get_peer_finished to allow applications to obtain the latest
  Finished messages sent to the peer or expected from the peer,
  respectively. (SSL_get_peer_finished is usually the Finished message
  actually received from the peer, otherwise the protocol will be aborted.)

  As the Finished message are message digests of the complete handshake
  (with a total of 192 bits for TLS 1.0 and more for SSL 3.0), they can
  be used for external authentication procedures when the authentication
  provided by SSL/TLS is not desired or is not enough.

  _Bodo Moeller_

- Enhanced support for Alpha Linux is added. Now ./config checks if
  the host supports BWX extension and if Compaq C is present on the
  $PATH. Just exploiting of the BWX extension results in 20-30%
  performance kick for some algorithms, e.g. DES and RC4 to mention
  a couple. Compaq C in turn generates ~20% faster code for MD5 and
  SHA1.

  _Andy Polyakov_

- Add support for MS "fast SGC". This is arguably a violation of the
  SSL3/TLS protocol. Netscape SGC does two handshakes: the first with
  weak crypto and after checking the certificate is SGC a second one
  with strong crypto. MS SGC stops the first handshake after receiving
  the server certificate message and sends a second client hello. Since
  a server will typically do all the time consuming operations before
  expecting any further messages from the client (server key exchange
  is the most expensive) there is little difference between the two.

  To get OpenSSL to support MS SGC we have to permit a second client
  hello message after we have sent server done. In addition we have to
  reset the MAC if we do get this second client hello.

  _Steve Henson_

- Add a function 'd2i_AutoPrivateKey()' this will automatically decide
  if a DER encoded private key is RSA or DSA traditional format. Changed
  d2i_PrivateKey_bio() to use it. This is only needed for the "traditional"
  format DER encoded private key. Newer code should use PKCS#8 format which
  has the key type encoded in the ASN1 structure. Added DER private key
  support to pkcs8 application.

  _Steve Henson_

- SSL 3/TLS 1 servers now don't request certificates when an anonymous
  ciphersuites has been selected (as required by the SSL 3/TLS 1
  specifications). Exception: When SSL_VERIFY_FAIL_IF_NO_PEER_CERT
  is set, we interpret this as a request to violate the specification
  (the worst that can happen is a handshake failure, and 'correct'
  behaviour would result in a handshake failure anyway).

  _Bodo Moeller_

- In SSL_CTX_add_session, take into account that there might be multiple
  SSL_SESSION structures with the same session ID (e.g. when two threads
  concurrently obtain them from an external cache).
  The internal cache can handle only one SSL_SESSION with a given ID,
  so if there's a conflict, we now throw out the old one to achieve
  consistency.

  _Bodo Moeller_

- Add OIDs for idea and blowfish in CBC mode. This will allow both
  to be used in PKCS#5 v2.0 and S/MIME. Also add checking to
  some routines that use cipher OIDs: some ciphers do not have OIDs
  defined and so they cannot be used for S/MIME and PKCS#5 v2.0 for
  example.

  _Steve Henson_

- Simplify the trust setting structure and code. Now we just have
  two sequences of OIDs for trusted and rejected settings. These will
  typically have values the same as the extended key usage extension
  and any application specific purposes.

  The trust checking code now has a default behaviour: it will just
  check for an object with the same NID as the passed id. Functions can
  be provided to override either the default behaviour or the behaviour
  for a given id. SSL client, server and email already have functions
  in place for compatibility: they check the NID and also return "trusted"
  if the certificate is self signed.

  _Steve Henson_

- Add d2i,i2d bio/fp functions for PrivateKey: these convert the
  traditional format into an EVP_PKEY structure.

  _Steve Henson_

- Add a password callback function PEM_cb() which either prompts for
  a password if usr_data is NULL or otherwise assumes it is a null
  terminated password. Allow passwords to be passed on command line
  environment or config files in a few more utilities.

  _Steve Henson_

- Add a bunch of DER and PEM functions to handle PKCS#8 format private
  keys. Add some short names for PKCS#8 PBE algorithms and allow them
  to be specified on the command line for the pkcs8 and pkcs12 utilities.
  Update documentation.

  _Steve Henson_

- Support for ASN1 "NULL" type. This could be handled before by using
  ASN1_TYPE but there wasn't any function that would try to read a NULL
  and produce an error if it couldn't. For compatibility we also have
  ASN1_NULL_new() and ASN1_NULL_free() functions but these are faked and
  don't allocate anything because they don't need to.

  _Steve Henson_

- Initial support for MacOS is now provided. Examine INSTALL.MacOS
  for details.

  _Andy Polyakov, Roy Woods <roy@centicsystems.ca>_

- Rebuild of the memory allocation routines used by OpenSSL code and
  possibly others as well. The purpose is to make an interface that
  provide hooks so anyone can build a separate set of allocation and
  deallocation routines to be used by OpenSSL, for example memory
  pool implementations, or something else, which was previously hard
  since Malloc(), Realloc() and Free() were defined as macros having
  the values malloc, realloc and free, respectively (except for Win32
  compilations). The same is provided for memory debugging code.
  OpenSSL already comes with functionality to find memory leaks, but
  this gives people a chance to debug other memory problems.

  With these changes, a new set of functions and macros have appeared:

  CRYPTO_set_mem_debug_functions() [F]
  CRYPTO_get_mem_debug_functions() [F]
  CRYPTO_dbg_set_options() [F]
  CRYPTO_dbg_get_options() [F]
  CRYPTO_malloc_debug_init() [M]

  The memory debug functions are NULL by default, unless the library
  is compiled with CRYPTO_MDEBUG or friends is defined. If someone
  wants to debug memory anyway, CRYPTO_malloc_debug_init() (which
  gives the standard debugging functions that come with OpenSSL) or
  CRYPTO_set_mem_debug_functions() (tells OpenSSL to use functions
  provided by the library user) must be used. When the standard
  debugging functions are used, CRYPTO_dbg_set_options can be used to
  request additional information:
  CRYPTO_dbg_set_options(V_CYRPTO_MDEBUG_xxx) corresponds to setting
  the CRYPTO_MDEBUG_xxx macro when compiling the library.

  Also, things like CRYPTO_set_mem_functions will always give the
  expected result (the new set of functions is used for allocation
  and deallocation) at all times, regardless of platform and compiler
  options.

  To finish it up, some functions that were never use in any other
  way than through macros have a new API and new semantic:

  CRYPTO_dbg_malloc()
  CRYPTO_dbg_realloc()
  CRYPTO_dbg_free()

  All macros of value have retained their old syntax.

  _Richard Levitte and Bodo Moeller_

- Some S/MIME fixes. The OID for SMIMECapabilities was wrong, the
  ordering of SMIMECapabilities wasn't in "strength order" and there
  was a missing NULL in the AlgorithmIdentifier for the SHA1 signature
  algorithm.

  _Steve Henson_

- Some ASN1 types with illegal zero length encoding (INTEGER,
  ENUMERATED and OBJECT IDENTIFIER) choked the ASN1 routines.

  _Frans Heymans <fheymans@isaserver.be>, modified by Steve Henson_

- Merge in my S/MIME library for OpenSSL. This provides a simple
  S/MIME API on top of the PKCS#7 code, a MIME parser (with enough
  functionality to handle multipart/signed properly) and a utility
  called 'smime' to call all this stuff. This is based on code I
  originally wrote for Celo who have kindly allowed it to be
  included in OpenSSL.

  _Steve Henson_

- Add variants des_set_key_checked and des_set_key_unchecked of
  des_set_key (aka des_key_sched). Global variable des_check_key
  decides which of these is called by des_set_key; this way
  des_check_key behaves as it always did, but applications and
  the library itself, which was buggy for des_check_key == 1,
  have a cleaner way to pick the version they need.

  _Bodo Moeller_

- New function PKCS12_newpass() which changes the password of a
  PKCS12 structure.

  _Steve Henson_

- Modify X509_TRUST and X509_PURPOSE so it also uses a static and
  dynamic mix. In both cases the ids can be used as an index into the
  table. Also modified the X509_TRUST_add() and X509_PURPOSE_add()
  functions so they accept a list of the field values and the
  application doesn't need to directly manipulate the X509_TRUST
  structure.

  _Steve Henson_

- Modify the ASN1_STRING_TABLE stuff so it also uses bsearch and doesn't
  need initialising.

  _Steve Henson_

- Modify the way the V3 extension code looks up extensions. This now
  works in a similar way to the object code: we have some "standard"
  extensions in a static table which is searched with OBJ_bsearch()
  and the application can add dynamic ones if needed. The file
  crypto/x509v3/ext_dat.h now has the info: this file needs to be
  updated whenever a new extension is added to the core code and kept
  in ext_nid order. There is a simple program 'tabtest.c' which checks
  this. New extensions are not added too often so this file can readily
  be maintained manually.

  There are two big advantages in doing things this way. The extensions
  can be looked up immediately and no longer need to be "added" using
  X509V3*add_standard_extensions(): this function now does nothing.
  Side note: I get \_lots* of email saying the extension code doesn't
  work because people forget to call this function.
  Also no dynamic allocation is done unless new extensions are added:
  so if we don't add custom extensions there is no need to call
  X509V3_EXT_cleanup().

  _Steve Henson_

- Modify enc utility's salting as follows: make salting the default. Add a
  magic header, so unsalted files fail gracefully instead of just decrypting
  to garbage. This is because not salting is a big security hole, so people
  should be discouraged from doing it.

  _Ben Laurie_

- Fixes and enhancements to the 'x509' utility. It allowed a message
  digest to be passed on the command line but it only used this
  parameter when signing a certificate. Modified so all relevant
  operations are affected by the digest parameter including the
  -fingerprint and -x509toreq options. Also -x509toreq choked if a
  DSA key was used because it didn't fix the digest.

  _Steve Henson_

- Initial certificate chain verify code. Currently tests the untrusted
  certificates for consistency with the verify purpose (which is set
  when the X509_STORE_CTX structure is set up) and checks the pathlength.

  There is a NO_CHAIN_VERIFY compilation option to keep the old behaviour:
  this is because it will reject chains with invalid extensions whereas
  every previous version of OpenSSL and SSLeay made no checks at all.

  Trust code: checks the root CA for the relevant trust settings. Trust
  settings have an initial value consistent with the verify purpose: e.g.
  if the verify purpose is for SSL client use it expects the CA to be
  trusted for SSL client use. However the default value can be changed to
  permit custom trust settings: one example of this would be to only trust
  certificates from a specific "secure" set of CAs.

  Also added X509_STORE_CTX_new() and X509_STORE_CTX_free() functions
  which should be used for version portability: especially since the
  verify structure is likely to change more often now.

  SSL integration. Add purpose and trust to SSL_CTX and SSL and functions
  to set them. If not set then assume SSL clients will verify SSL servers
  and vice versa.

  Two new options to the verify program: -untrusted allows a set of
  untrusted certificates to be passed in and -purpose which sets the
  intended purpose of the certificate. If a purpose is set then the
  new chain verify code is used to check extension consistency.

  _Steve Henson_

- Support for the authority information access extension.

  _Steve Henson_

- Modify RSA and DSA PEM read routines to transparently handle
  PKCS#8 format private keys. New _*PUBKEY*_ functions that handle
  public keys in a format compatible with certificate
  SubjectPublicKeyInfo structures. Unfortunately there were already
  functions called _*PublicKey*_ which used various odd formats so
  these are retained for compatibility: however the DSA variants were
  never in a public release so they have been deleted. Changed dsa/rsa
  utilities to handle the new format: note no releases ever handled public
  keys so we should be OK.

  The primary motivation for this change is to avoid the same fiasco
  that dogs private keys: there are several incompatible private key
  formats some of which are standard and some OpenSSL specific and
  require various evil hacks to allow partial transparent handling and
  even then it doesn't work with DER formats. Given the option anything
  other than PKCS#8 should be dumped: but the other formats have to
  stay in the name of compatibility.

  With public keys and the benefit of hindsight one standard format
  is used which works with EVP_PKEY, RSA or DSA structures: though
  it clearly returns an error if you try to read the wrong kind of key.

  Added a -pubkey option to the 'x509' utility to output the public key.
  Also rename the `EVP_PKEY_get_*()` to `EVP_PKEY_rget_*()`
  (renamed to `EVP_PKEY_get1_*()` in the OpenSSL 0.9.5 release) and add
  `EVP_PKEY_rset_*()` functions (renamed to `EVP_PKEY_set1_*()`)
  that do the same as the `EVP_PKEY_assign_*()` except they up the
  reference count of the added key (they don't "swallow" the
  supplied key).

  _Steve Henson_

- Fixes to crypto/x509/by_file.c the code to read in certificates and
  CRLs would fail if the file contained no certificates or no CRLs:
  added a new function to read in both types and return the number
  read: this means that if none are read it will be an error. The
  DER versions of the certificate and CRL reader would always fail
  because it isn't possible to mix certificates and CRLs in DER format
  without choking one or the other routine. Changed this to just read
  a certificate: this is the best we can do. Also modified the code
  in `apps/verify.c` to take notice of return codes: it was previously
  attempting to read in certificates from NULL pointers and ignoring
  any errors: this is one reason why the cert and CRL reader seemed
  to work. It doesn't check return codes from the default certificate
  routines: these may well fail if the certificates aren't installed.

  _Steve Henson_

- Code to support otherName option in GeneralName.

  _Steve Henson_

- First update to verify code. Change the verify utility
  so it warns if it is passed a self signed certificate:
  for consistency with the normal behaviour. X509*verify
  has been modified to it will now verify a self signed
  certificate if \_exactly* the same certificate appears
  in the store: it was previously impossible to trust a
  single self signed certificate. This means that:
  openssl verify ss.pem
  now gives a warning about a self signed certificate but
  openssl verify -CAfile ss.pem ss.pem
  is OK.

  _Steve Henson_

- For servers, store verify_result in SSL_SESSION data structure
  (and add it to external session representation).
  This is needed when client certificate verifications fails,
  but an application-provided verification callback (set by
  SSL_CTX_set_cert_verify_callback) allows accepting the session
  anyway (i.e. leaves x509_store_ctx->error != X509_V_OK
  but returns 1): When the session is reused, we have to set
  ssl->verify_result to the appropriate error code to avoid
  security holes.

  _Bodo Moeller, problem pointed out by Lutz Jaenicke_

- Fix a bug in the new PKCS#7 code: it didn't consider the
  case in PKCS7_dataInit() where the signed PKCS7 structure
  didn't contain any existing data because it was being created.

  _Po-Cheng Chen <pocheng@nst.com.tw>, slightly modified by Steve Henson_

- Add a salt to the key derivation routines in enc.c. This
  forms the first 8 bytes of the encrypted file. Also add a
  -S option to allow a salt to be input on the command line.

  _Steve Henson_

- New function X509_cmp(). Oddly enough there wasn't a function
  to compare two certificates. We do this by working out the SHA1
  hash and comparing that. X509_cmp() will be needed by the trust
  code.

  _Steve Henson_

- SSL_get1_session() is like SSL_get_session(), but increments
  the reference count in the SSL_SESSION returned.

  _Geoff Thorpe <geoff@eu.c2.net>_

- Fix for 'req': it was adding a null to request attributes.
  Also change the X509_LOOKUP and X509_INFO code to handle
  certificate auxiliary information.

  _Steve Henson_

- Add support for 40 and 64 bit RC2 and RC4 algorithms: document
  the 'enc' command.

  _Steve Henson_

- Add the possibility to add extra information to the memory leak
  detecting output, to form tracebacks, showing from where each
  allocation was originated: CRYPTO_push_info("constant string") adds
  the string plus current file name and line number to a per-thread
  stack, CRYPTO_pop_info() does the obvious, CRYPTO_remove_all_info()
  is like calling CYRPTO_pop_info() until the stack is empty.
  Also updated memory leak detection code to be multi-thread-safe.

  _Richard Levitte_

- Add options -text and -noout to pkcs7 utility and delete the
  encryption options which never did anything. Update docs.

  _Steve Henson_

- Add options to some of the utilities to allow the pass phrase
  to be included on either the command line (not recommended on
  OSes like Unix) or read from the environment. Update the
  manpages and fix a few bugs.

  _Steve Henson_

- Add a few manpages for some of the openssl commands.

  _Steve Henson_

- Fix the -revoke option in ca. It was freeing up memory twice,
  leaking and not finding already revoked certificates.

  _Steve Henson_

- Extensive changes to support certificate auxiliary information.
  This involves the use of X509_CERT_AUX structure and X509_AUX
  functions. An X509_AUX function such as PEM_read_X509_AUX()
  can still read in a certificate file in the usual way but it
  will also read in any additional "auxiliary information". By
  doing things this way a fair degree of compatibility can be
  retained: existing certificates can have this information added
  using the new 'x509' options.

  Current auxiliary information includes an "alias" and some trust
  settings. The trust settings will ultimately be used in enhanced
  certificate chain verification routines: currently a certificate
  can only be trusted if it is self signed and then it is trusted
  for all purposes.

  _Steve Henson_

- Fix assembler for Alpha (tested only on DEC OSF not Linux or `*BSD`).
  The problem was that one of the replacement routines had not been working
  since SSLeay releases. For now the offending routine has been replaced
  with non-optimised assembler. Even so, this now gives around 95%
  performance improvement for 1024 bit RSA signs.

  _Mark Cox_

- Hack to fix PKCS#7 decryption when used with some unorthodox RC2
  handling. Most clients have the effective key size in bits equal to
  the key length in bits: so a 40 bit RC2 key uses a 40 bit (5 byte) key.
  A few however don't do this and instead use the size of the decrypted key
  to determine the RC2 key length and the AlgorithmIdentifier to determine
  the effective key length. In this case the effective key length can still
  be 40 bits but the key length can be 168 bits for example. This is fixed
  by manually forcing an RC2 key into the EVP_PKEY structure because the
  EVP code can't currently handle unusual RC2 key sizes: it always assumes
  the key length and effective key length are equal.

  _Steve Henson_

- Add a bunch of functions that should simplify the creation of
  X509_NAME structures. Now you should be able to do:
  X509_NAME_add_entry_by_txt(nm, "CN", MBSTRING_ASC, "Steve", -1, -1, 0);
  and have it automatically work out the correct field type and fill in
  the structures. The more adventurous can try:
  X509_NAME_add_entry_by_txt(nm, field, MBSTRING_UTF8, str, -1, -1, 0);
  and it will (hopefully) work out the correct multibyte encoding.

  _Steve Henson_

- Change the 'req' utility to use the new field handling and multibyte
  copy routines. Before the DN field creation was handled in an ad hoc
  way in req, ca, and x509 which was rather broken and didn't support
  BMPStrings or UTF8Strings. Since some software doesn't implement
  BMPStrings or UTF8Strings yet, they can be enabled using the config file
  using the dirstring_type option. See the new comment in the default
  openssl.cnf for more info.

  _Steve Henson_

- Make crypto/rand/md_rand.c more robust:
  - Assure unique random numbers after fork().
  - Make sure that concurrent threads access the global counter and
    md serializably so that we never lose entropy in them
    or use exactly the same state in multiple threads.
    Access to the large state is not always serializable because
    the additional locking could be a performance killer, and
    md should be large enough anyway.

  _Bodo Moeller_

- New file `apps/app_rand.c` with commonly needed functionality
  for handling the random seed file.

  Use the random seed file in some applications that previously did not:
  ca,
  dsaparam -genkey (which also ignored its '-rand' option),
  s_client,
  s_server,
  x509 (when signing).
  Except on systems with /dev/urandom, it is crucial to have a random
  seed file at least for key creation, DSA signing, and for DH exchanges;
  for RSA signatures we could do without one.

  gendh and gendsa (unlike genrsa) used to read only the first byte
  of each file listed in the '-rand' option. The function as previously
  found in genrsa is now in app_rand.c and is used by all programs
  that support '-rand'.

  _Bodo Moeller_

- In RAND_write_file, use mode 0600 for creating files;
  don't just chmod when it may be too late.

  _Bodo Moeller_

- Report an error from X509_STORE_load_locations
  when X509_LOOKUP_load_file or X509_LOOKUP_add_dir failed.

  _Bill Perry_

- New function ASN1_mbstring_copy() this copies a string in either
  ASCII, Unicode, Universal (4 bytes per character) or UTF8 format
  into an ASN1_STRING type. A mask of permissible types is passed
  and it chooses the "minimal" type to use or an error if not type
  is suitable.

  _Steve Henson_

- Add function equivalents to the various macros in asn1.h. The old
  macros are retained with an `M_` prefix. Code inside the library can
  use the `M_` macros. External code (including the openssl utility)
  should _NOT_ in order to be "shared library friendly".

  _Steve Henson_

- Add various functions that can check a certificate's extensions
  to see if it usable for various purposes such as SSL client,
  server or S/MIME and CAs of these types. This is currently
  VERY EXPERIMENTAL but will ultimately be used for certificate chain
  verification. Also added a -purpose flag to x509 utility to
  print out all the purposes.

  _Steve Henson_

- Add a CRYPTO_EX_DATA to X509 certificate structure and associated
  functions.

  _Steve Henson_

- New `X509V3_{X509,CRL,REVOKED}_get_d2i()` functions. These will search
  for, obtain and decode and extension and obtain its critical flag.
  This allows all the necessary extension code to be handled in a
  single function call.

  _Steve Henson_

- RC4 tune-up featuring 30-40% performance improvement on most RISC
  platforms. See crypto/rc4/rc4_enc.c for further details.

  _Andy Polyakov_

- New -noout option to asn1parse. This causes no output to be produced
  its main use is when combined with -strparse and -out to extract data
  from a file (which may not be in ASN.1 format).

  _Steve Henson_

- Fix for pkcs12 program. It was hashing an invalid certificate pointer
  when producing the local key id.

  _Richard Levitte <levitte@stacken.kth.se>_

- New option -dhparam in s_server. This allows a DH parameter file to be
  stated explicitly. If it is not stated then it tries the first server
  certificate file. The previous behaviour hard coded the filename
  "server.pem".

  _Steve Henson_

- Add -pubin and -pubout options to the rsa and dsa commands. These allow
  a public key to be input or output. For example:
  openssl rsa -in key.pem -pubout -out pubkey.pem
  Also added necessary DSA public key functions to handle this.

  _Steve Henson_

- Fix so PKCS7_dataVerify() doesn't crash if no certificates are contained
  in the message. This was handled by allowing
  X509_find_by_issuer_and_serial() to tolerate a NULL passed to it.

  _Steve Henson, reported by Sampo Kellomaki <sampo@mail.neuronio.pt>_

- Fix for bug in d2i_ASN1_bytes(): other ASN1 functions add an extra null
  to the end of the strings whereas this didn't. This would cause problems
  if strings read with d2i_ASN1_bytes() were later modified.

  _Steve Henson, reported by Arne Ansper <arne@ats.cyber.ee>_

- Fix for base64 decode bug. When a base64 bio reads only one line of
  data and it contains EOF it will end up returning an error. This is
  caused by input 46 bytes long. The cause is due to the way base64
  BIOs find the start of base64 encoded data. They do this by trying a
  trial decode on each line until they find one that works. When they
  do a flag is set and it starts again knowing it can pass all the
  data directly through the decoder. Unfortunately it doesn't reset
  the context it uses. This means that if EOF is reached an attempt
  is made to pass two EOFs through the context and this causes the
  resulting error. This can also cause other problems as well. As is
  usual with these problems it takes _ages_ to find and the fix is
  trivial: move one line.

  _Steve Henson, reported by ian@uns.ns.ac.yu (Ivan Nejgebauer)_

- Ugly workaround to get s_client and s_server working under Windows. The
  old code wouldn't work because it needed to select() on sockets and the
  tty (for keypresses and to see if data could be written). Win32 only
  supports select() on sockets so we select() with a 1s timeout on the
  sockets and then see if any characters are waiting to be read, if none
  are present then we retry, we also assume we can always write data to
  the tty. This isn't nice because the code then blocks until we've
  received a complete line of data and it is effectively polling the
  keyboard at 1s intervals: however it's quite a bit better than not
  working at all :-) A dedicated Windows application might handle this
  with an event loop for example.

  _Steve Henson_

- Enhance RSA*METHOD structure. Now there are two extra methods, rsa_sign
  and rsa_verify. When the RSA_FLAGS_SIGN_VER option is set these functions
  will be called when RSA_sign() and RSA_verify() are used. This is useful
  if rsa_pub_dec() and rsa_priv_enc() equivalents are not available.
  For this to work properly RSA_public_decrypt() and RSA_private_encrypt()
  should \_not* be used: RSA_sign() and RSA_verify() must be used instead.
  This necessitated the support of an extra signature type NID_md5_sha1
  for SSL signatures and modifications to the SSL library to use it instead
  of calling RSA_public_decrypt() and RSA_private_encrypt().

  _Steve Henson_

- Add new -verify -CAfile and -CApath options to the crl program, these
  will lookup a CRL issuers certificate and verify the signature in a
  similar way to the verify program. Tidy up the crl program so it
  no longer accesses structures directly. Make the ASN1 CRL parsing a bit
  less strict. It will now permit CRL extensions even if it is not
  a V2 CRL: this will allow it to tolerate some broken CRLs.

  _Steve Henson_

- Initialize all non-automatic variables each time one of the openssl
  sub-programs is started (this is necessary as they may be started
  multiple times from the "OpenSSL>" prompt).

  _Lennart Bang, Bodo Moeller_

- Preliminary compilation option RSA_NULL which disables RSA crypto without
  removing all other RSA functionality (this is what NO_RSA does). This
  is so (for example) those in the US can disable those operations covered
  by the RSA patent while allowing storage and parsing of RSA keys and RSA
  key generation.

  _Steve Henson_

- Non-copying interface to BIO pairs.
  (still largely untested)

  _Bodo Moeller_

- New function ASN1_tag2str() to convert an ASN1 tag to a descriptive
  ASCII string. This was handled independently in various places before.

  _Steve Henson_

- New functions UTF8_getc() and UTF8_putc() that parse and generate
  UTF8 strings a character at a time.

  _Steve Henson_

- Use client_version from client hello to select the protocol
  (s23_srvr.c) and for RSA client key exchange verification
  (s3_srvr.c), as required by the SSL 3.0/TLS 1.0 specifications.

  _Bodo Moeller_

- Add various utility functions to handle SPKACs, these were previously
  handled by poking round in the structure internals. Added new function
  NETSCAPE_SPKI_print() to print out SPKAC and a new utility 'spkac' to
  print, verify and generate SPKACs. Based on an original idea from
  Massimiliano Pala <madwolf@comune.modena.it> but extensively modified.

  _Steve Henson_

- RIPEMD160 is operational on all platforms and is back in 'make test'.

  _Andy Polyakov_

- Allow the config file extension section to be overwritten on the
  command line. Based on an original idea from Massimiliano Pala
  <madwolf@comune.modena.it>. The new option is called -extensions
  and can be applied to ca, req and x509. Also -reqexts to override
  the request extensions in req and -crlexts to override the crl extensions
  in ca.

  _Steve Henson_

- Add new feature to the SPKAC handling in ca. Now you can include
  the same field multiple times by preceding it by "XXXX." for example:
  1.OU="Unit name 1"
  2.OU="Unit name 2"
  this is the same syntax as used in the req config file.

  _Steve Henson_

- Allow certificate extensions to be added to certificate requests. These
  are specified in a 'req_extensions' option of the req section of the
  config file. They can be printed out with the -text option to req but
  are otherwise ignored at present.

  _Steve Henson_

- Fix a horrible bug in enc_read() in crypto/evp/bio_enc.c: if the first
  data read consists of only the final block it would not decrypted because
  EVP_CipherUpdate() would correctly report zero bytes had been decrypted.
  A misplaced 'break' also meant the decrypted final block might not be
  copied until the next read.

  _Steve Henson_

- Initial support for DH_METHOD. Again based on RSA_METHOD. Also added
  a few extra parameters to the DH structure: these will be useful if
  for example we want the value of 'q' or implement X9.42 DH.

  _Steve Henson_

- Initial support for DSA_METHOD. This is based on the RSA_METHOD and
  provides hooks that allow the default DSA functions or functions on a
  "per key" basis to be replaced. This allows hardware acceleration and
  hardware key storage to be handled without major modification to the
  library. Also added low-level modexp hooks and CRYPTO_EX structure and
  associated functions.

  _Steve Henson_

- Add a new flag to memory BIOs, BIO_FLAG_MEM_RDONLY. This marks the BIO
  as "read only": it can't be written to and the buffer it points to will
  not be freed. Reading from a read only BIO is much more efficient than
  a normal memory BIO. This was added because there are several times when
  an area of memory needs to be read from a BIO. The previous method was
  to create a memory BIO and write the data to it, this results in two
  copies of the data and an O(n^2) reading algorithm. There is a new
  function BIO_new_mem_buf() which creates a read only memory BIO from
  an area of memory. Also modified the PKCS#7 routines to use read only
  memory BIOs.

  _Steve Henson_

- Bugfix: ssl23_get_client_hello did not work properly when called in
  state SSL23_ST_SR_CLNT_HELLO_B, i.e. when the first 7 bytes of
  an SSLv2-compatible client hello for SSLv3 or TLSv1 could be read,
  but a retry condition occurred while trying to read the rest.

  _Bodo Moeller_

- The PKCS7_ENC_CONTENT_new() function was setting the content type as
  NID_pkcs7_encrypted by default: this was wrong since this should almost
  always be NID_pkcs7_data. Also modified the PKCS7_set_type() to handle
  the encrypted data type: this is a more sensible place to put it and it
  allows the PKCS#12 code to be tidied up that duplicated this
  functionality.

  _Steve Henson_

- Changed obj_dat.pl script so it takes its input and output files on
  the command line. This should avoid shell escape redirection problems
  under Win32.

  _Steve Henson_

- Initial support for certificate extension requests, these are included
  in things like Xenroll certificate requests. Included functions to allow
  extensions to be obtained and added.

  _Steve Henson_

- -crlf option to s_client and s_server for sending newlines as
  CRLF (as required by many protocols).

  _Bodo Moeller_

### Changes between 0.9.3a and 0.9.4 [09 Aug 1999]

- Install libRSAglue.a when OpenSSL is built with RSAref.

  _Ralf S. Engelschall_

- A few more `#ifndef NO_FP_API / #endif` pairs for consistency.

  _Andrija Antonijevic <TheAntony2@bigfoot.com>_

- Fix -startdate and -enddate (which was missing) arguments to 'ca'
  program.

  _Steve Henson_

- New function DSA_dup_DH, which duplicates DSA parameters/keys as
  DH parameters/keys (q is lost during that conversion, but the resulting
  DH parameters contain its length).

  For 1024-bit p, DSA_generate_parameters followed by DSA_dup_DH is
  much faster than DH_generate_parameters (which creates parameters
  where `p = 2*q + 1`), and also the smaller q makes DH computations
  much more efficient (160-bit exponentiation instead of 1024-bit
  exponentiation); so this provides a convenient way to support DHE
  ciphersuites in SSL/TLS servers (see ssl/ssltest.c). It is of
  utter importance to use
  SSL_CTX_set_options(s_ctx, SSL_OP_SINGLE_DH_USE);
  or
  SSL_set_options(s_ctx, SSL_OP_SINGLE_DH_USE);
  when such DH parameters are used, because otherwise small subgroup
  attacks may become possible!

  _Bodo Moeller_

- Avoid memory leak in i2d_DHparams.

  _Bodo Moeller_

- Allow the -k option to be used more than once in the enc program:
  this allows the same encrypted message to be read by multiple recipients.

  _Steve Henson_

- New function OBJ_obj2txt(buf, buf_len, a, no_name), this converts
  an ASN1_OBJECT to a text string. If the "no_name" parameter is set then
  it will always use the numerical form of the OID, even if it has a short
  or long name.

  _Steve Henson_

- Added an extra RSA flag: RSA_FLAG_EXT_PKEY. Previously the rsa_mod_exp
  method only got called if p,q,dmp1,dmq1,iqmp components were present,
  otherwise bn_mod_exp was called. In the case of hardware keys for example
  no private key components need be present and it might store extra data
  in the RSA structure, which cannot be accessed from bn_mod_exp.
  By setting RSA_FLAG_EXT_PKEY rsa_mod_exp will always be called for
  private key operations.

  _Steve Henson_

- Added support for SPARC Linux.

  _Andy Polyakov_

- pem*password_cb function type incompatibly changed from
  typedef int pem_password_cb(char *buf, int size, int rwflag);
  to
  ....(char _buf, int size, int rwflag, void \*userdata);
  so that applications can pass data to their callbacks:
  The `PEM[_ASN1]_{read,write}...` functions and macros now take an
  additional void \* argument, which is just handed through whenever
  the password callback is called.

  _Damien Miller <dmiller@ilogic.com.au>; tiny changes by Bodo Moeller_

  New function SSL_CTX_set_default_passwd_cb_userdata.

  Compatibility note: As many C implementations push function arguments
  onto the stack in reverse order, the new library version is likely to
  interoperate with programs that have been compiled with the old
  pem_password_cb definition (PEM_whatever takes some data that
  happens to be on the stack as its last argument, and the callback
  just ignores this garbage); but there is no guarantee whatsoever that
  this will work.

- The -DPLATFORM="\"$(PLATFORM)\"" definition and the similar -DCFLAGS=...
  (both in crypto/Makefile.ssl for use by crypto/cversion.c) caused
  problems not only on Windows, but also on some Unix platforms.
  To avoid problematic command lines, these definitions are now in an
  auto-generated file crypto/buildinf.h (created by crypto/Makefile.ssl
  for standard "make" builds, by util/mk1mf.pl for "mk1mf" builds).

  _Bodo Moeller_

- MIPS III/IV assembler module is reimplemented.

  _Andy Polyakov_

- More DES library cleanups: remove references to srand/rand and
  delete an unused file.

  _Ulf Möller_

- Add support for the free Netwide assembler (NASM) under Win32,
  since not many people have MASM (ml) and it can be hard to obtain.
  This is currently experimental but it seems to work OK and pass all
  the tests. Check out INSTALL.W32 for info.

  _Steve Henson_

- Fix memory leaks in s3_clnt.c: All non-anonymous SSL3/TLS1 connections
  without temporary keys kept an extra copy of the server key,
  and connections with temporary keys did not free everything in case
  of an error.

  _Bodo Moeller_

- New function RSA_check_key and new openssl rsa option -check
  for verifying the consistency of RSA keys.

  _Ulf Moeller, Bodo Moeller_

- Various changes to make Win32 compile work:
  1.  Casts to avoid "loss of data" warnings in p5_crpt2.c
  2.  Change unsigned int to int in b_dump.c to avoid "signed/unsigned
      comparison" warnings.
  3.  Add `sk_<TYPE>_sort` to DEF file generator and do make update.

  _Steve Henson_

- Add a debugging option to PKCS#5 v2 key generation function: when
  you #define DEBUG_PKCS5V2 passwords, salts, iteration counts and
  derived keys are printed to stderr.

  _Steve Henson_

- Copy the flags in ASN1_STRING_dup().

  _Roman E. Pavlov <pre@mo.msk.ru>_

- The x509 application mishandled signing requests containing DSA
  keys when the signing key was also DSA and the parameters didn't match.

  It was supposed to omit the parameters when they matched the signing key:
  the verifying software was then supposed to automatically use the CA's
  parameters if they were absent from the end user certificate.

  Omitting parameters is no longer recommended. The test was also
  the wrong way round! This was probably due to unusual behaviour in
  EVP*cmp_parameters() which returns 1 if the parameters match.
  This meant that parameters were omitted when they \_didn't* match and
  the certificate was useless. Certificates signed with 'ca' didn't have
  this bug.

  _Steve Henson, reported by Doug Erickson <Doug.Erickson@Part.NET>_

- Memory leak checking (-DCRYPTO_MDEBUG) had some problems.
  The interface is as follows:
  Applications can use
  CRYPTO_mem_ctrl(CRYPTO_MEM_CHECK_ON) aka MemCheck_start(),
  CRYPTO_mem_ctrl(CRYPTO_MEM_CHECK_OFF) aka MemCheck_stop();
  "off" is now the default.
  The library internally uses
  CRYPTO_mem_ctrl(CRYPTO_MEM_CHECK_DISABLE) aka MemCheck_off(),
  CRYPTO_mem_ctrl(CRYPTO_MEM_CHECK_ENABLE) aka MemCheck_on()
  to disable memory-checking temporarily.

  Some inconsistent states that previously were possible (and were
  even the default) are now avoided.

  -DCRYPTO_MDEBUG_TIME is new and additionally stores the current time
  with each memory chunk allocated; this is occasionally more helpful
  than just having a counter.

  -DCRYPTO_MDEBUG_THREAD is also new and adds the thread ID.

  -DCRYPTO_MDEBUG_ALL enables all of the above, plus any future
  extensions.

  _Bodo Moeller_

- Introduce "mode" for SSL structures (with defaults in SSL_CTX),
  which largely parallels "options", but is for changing API behaviour,
  whereas "options" are about protocol behaviour.
  Initial "mode" flags are:

  SSL_MODE_ENABLE_PARTIAL_WRITE Allow SSL_write to report success when
  a single record has been written.
  SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER Don't insist that SSL_write
  retries use the same buffer location.
  (But all of the contents must be
  copied!)

  _Bodo Moeller_

- Bugfix: SSL_set_options ignored its parameter, only SSL_CTX_set_options
  worked.

- Fix problems with no-hmac etc.

  _Ulf Möller, pointed out by Brian Wellington <bwelling@tislabs.com>_

- New functions RSA_get_default_method(), RSA_set_method() and
  RSA_get_method(). These allows replacement of RSA_METHODs without having
  to mess around with the internals of an RSA structure.

  _Steve Henson_

- Fix memory leaks in DSA_do_sign and DSA_is_prime.
  Also really enable memory leak checks in openssl.c and in some
  test programs.

  _Chad C. Mulligan, Bodo Moeller_

- Fix a bug in d2i*ASN1_INTEGER() and i2d_ASN1_INTEGER() which can mess
  up the length of negative integers. This has now been simplified to just
  store the length when it is first determined and use it later, rather
  than trying to keep track of where data is copied and updating it to
  point to the end.
  \_Steve Henson, reported by Brien Wheeler <bwheeler@authentica-security.com>*

- Add a new function PKCS7_signatureVerify. This allows the verification
  of a PKCS#7 signature but with the signing certificate passed to the
  function itself. This contrasts with PKCS7_dataVerify which assumes the
  certificate is present in the PKCS#7 structure. This isn't always the
  case: certificates can be omitted from a PKCS#7 structure and be
  distributed by "out of band" means (such as a certificate database).

  _Steve Henson_

- Complete the `PEM_*` macros with DECLARE_PEM versions to replace the
  function prototypes in pem.h, also change util/mkdef.pl to add the
  necessary function names.

  _Steve Henson_

- mk1mf.pl (used by Windows builds) did not properly read the
  options set by Configure in the top level Makefile, and Configure
  was not even able to write more than one option correctly.
  Fixed, now "no-idea no-rc5 -DCRYPTO_MDEBUG" etc. works as intended.

  _Bodo Moeller_

- New functions CONF_load_bio() and CONF_load_fp() to allow a config
  file to be loaded from a BIO or FILE pointer. The BIO version will
  for example allow memory BIOs to contain config info.

  _Steve Henson_

- New function "CRYPTO_num_locks" that returns CRYPTO_NUM_LOCKS.
  Whoever hopes to achieve shared-library compatibility across versions
  must use this, not the compile-time macro.
  (Exercise 0.9.4: Which is the minimum library version required by
  such programs?)
  Note: All this applies only to multi-threaded programs, others don't
  need locks.

  _Bodo Moeller_

- Add missing case to s3_clnt.c state machine -- one of the new SSL tests
  through a BIO pair triggered the default case, i.e.
  SSLerr(...,SSL_R_UNKNOWN_STATE).

  _Bodo Moeller_

- New "BIO pair" concept (crypto/bio/bss_bio.c) so that applications
  can use the SSL library even if none of the specific BIOs is
  appropriate.

  _Bodo Moeller_

- Fix a bug in i2d_DSAPublicKey() which meant it returned the wrong value
  for the encoded length.

  _Jeon KyoungHo <khjeon@sds.samsung.co.kr>_

- Add initial documentation of the X509V3 functions.

  _Steve Henson_

- Add a new pair of functions PEM_write_PKCS8PrivateKey() and
  PEM_write_bio_PKCS8PrivateKey() that are equivalent to
  PEM_write_PrivateKey() and PEM_write_bio_PrivateKey() but use the more
  secure PKCS#8 private key format with a high iteration count.

  _Steve Henson_

- Fix determination of Perl interpreter: A perl or perl5
  _directory_ in $PATH was also accepted as the interpreter.

  _Ralf S. Engelschall_

- Fix demos/sign/sign.c: well there wasn't anything strictly speaking
  wrong with it but it was very old and did things like calling
  PEM_ASN1_read() directly and used MD5 for the hash not to mention some
  unusual formatting.

  _Steve Henson_

- Fix demos/selfsign.c: it used obsolete and deleted functions, changed
  to use the new extension code.

  _Steve Henson_

- Implement the PEM_read/PEM_write functions in crypto/pem/pem_all.c
  with macros. This should make it easier to change their form, add extra
  arguments etc. Fix a few PEM prototypes which didn't have cipher as a
  constant.

  _Steve Henson_

- Add to configuration table a new entry that can specify an alternative
  name for unistd.h (for pre-POSIX systems); we need this for NeXTstep,
  according to Mark Crispin <MRC@Panda.COM>.

  _Bodo Moeller_

- DES CBC did not update the IV. Weird.

  _Ben Laurie_
  lse
  des_cbc_encrypt does not update the IV, but des_ncbc_encrypt does.
  Changing the behaviour of the former might break existing programs --
  where IV updating is needed, des_ncbc_encrypt can be used.
  ndif

- When bntest is run from "make test" it drives bc to check its
  calculations, as well as internally checking them. If an internal check
  fails, it needs to cause bc to give a non-zero result or make test carries
  on without noticing the failure. Fixed.

  _Ben Laurie_

- DES library cleanups.

  _Ulf Möller_

- Add support for PKCS#5 v2.0 PBE algorithms. This will permit PKCS#8 to be
  used with any cipher unlike PKCS#5 v1.5 which can at most handle 64 bit
  ciphers. NOTE: although the key derivation function has been verified
  against some published test vectors it has not been extensively tested
  yet. Added a -v2 "cipher" option to pkcs8 application to allow the use
  of v2.0.

  _Steve Henson_

- Instead of "mkdir -p", which is not fully portable, use new
  Perl script "util/mkdir-p.pl".

  _Bodo Moeller_

- Rewrite the way password based encryption (PBE) is handled. It used to
  assume that the ASN1 AlgorithmIdentifier parameter was a PBEParameter
  structure. This was true for the PKCS#5 v1.5 and PKCS#12 PBE algorithms
  but doesn't apply to PKCS#5 v2.0 where it can be something else. Now
  the 'parameter' field of the AlgorithmIdentifier is passed to the
  underlying key generation function so it must do its own ASN1 parsing.
  This has also changed the EVP_PBE_CipherInit() function which now has a
  'parameter' argument instead of literal salt and iteration count values
  and the function EVP_PBE_ALGOR_CipherInit() has been deleted.

  _Steve Henson_

- Support for PKCS#5 v1.5 compatible password based encryption algorithms
  and PKCS#8 functionality. New 'pkcs8' application linked to openssl.
  Needed to change the PEM_STRING_EVP_PKEY value which was just "PRIVATE
  KEY" because this clashed with PKCS#8 unencrypted string. Since this
  value was just used as a "magic string" and not used directly its
  value doesn't matter.

  _Steve Henson_

- Introduce some semblance of const correctness to BN. Shame C doesn't
  support mutable.

  _Ben Laurie_

- "linux-sparc64" configuration (ultrapenguin).

  _Ray Miller <ray.miller@oucs.ox.ac.uk>_
  "linux-sparc" configuration.

  _Christian Forster <fo@hawo.stw.uni-erlangen.de>_

- config now generates no-xxx options for missing ciphers.

  _Ulf Möller_

- Support the EBCDIC character set (work in progress).
  File ebcdic.c not yet included because it has a different license.

  _Martin Kraemer <Martin.Kraemer@MchP.Siemens.De>_

- Support BS2000/OSD-POSIX.

  _Martin Kraemer <Martin.Kraemer@MchP.Siemens.De>_

- Make callbacks for key generation use `void *` instead of `char *`.

  _Ben Laurie_

- Make S/MIME samples compile (not yet tested).

  _Ben Laurie_

- Additional typesafe stacks.

  _Ben Laurie_

- New configuration variants "bsdi-elf-gcc" (BSD/OS 4.x).

  _Bodo Moeller_

### Changes between 0.9.3 and 0.9.3a [29 May 1999]

- New configuration variant "sco5-gcc".

- Updated some demos.

  _Sean O Riordain, Wade Scholine_

- Add missing BIO_free at exit of pkcs12 application.

  _Wu Zhigang_

- Fix memory leak in conf.c.

  _Steve Henson_

- Updates for Win32 to assembler version of MD5.

  _Steve Henson_

- Set #! path to perl in `apps/der_chop` to where we found it
  instead of using a fixed path.

  _Bodo Moeller_

- SHA library changes for irix64-mips4-cc.

  _Andy Polyakov_

- Improvements for VMS support.

  _Richard Levitte_

### Changes between 0.9.2b and 0.9.3 [24 May 1999]

- Bignum library bug fix. IRIX 6 passes "make test" now!
  This also avoids the problems with SC4.2 and unpatched SC5.

  _Andy Polyakov <appro@fy.chalmers.se>_

- New functions sk_num, sk_value and sk_set to replace the previous macros.
  These are required because of the typesafe stack would otherwise break
  existing code. If old code used a structure member which used to be STACK
  and is now STACK_OF (for example cert in a PKCS7_SIGNED structure) with
  sk_num or sk_value it would produce an error because the num, data members
  are not present in STACK_OF. Now it just produces a warning. sk_set
  replaces the old method of assigning a value to sk_value
  (e.g. sk_value(x, i) = y) which the library used in a few cases. Any code
  that does this will no longer work (and should use sk_set instead) but
  this could be regarded as a "questionable" behaviour anyway.

  _Steve Henson_

- Fix most of the other PKCS#7 bugs. The "experimental" code can now
  correctly handle encrypted S/MIME data.

  _Steve Henson_

- Change type of various DES function arguments from des_cblock
  (which means, in function argument declarations, pointer to char)
  to des_cblock \* (meaning pointer to array with 8 char elements),
  which allows the compiler to do more typechecking; it was like
  that back in SSLeay, but with lots of ugly casts.

  Introduce new type const_des_cblock.

  _Bodo Moeller_

- Reorganise the PKCS#7 library and get rid of some of the more obvious
  problems: find RecipientInfo structure that matches recipient certificate
  and initialise the ASN1 structures properly based on passed cipher.

  _Steve Henson_

- Belatedly make the BN tests actually check the results.

  _Ben Laurie_

- Fix the encoding and decoding of negative ASN1 INTEGERS and conversion
  to and from BNs: it was completely broken. New compilation option
  NEG_PUBKEY_BUG to allow for some broken certificates that encode public
  key elements as negative integers.

  _Steve Henson_

- Reorganize and speed up MD5.

  _Andy Polyakov <appro@fy.chalmers.se>_

- VMS support.

  _Richard Levitte <richard@levitte.org>_

- New option -out to asn1parse to allow the parsed structure to be
  output to a file. This is most useful when combined with the -strparse
  option to examine the output of things like OCTET STRINGS.

  _Steve Henson_

- Make SSL library a little more fool-proof by not requiring any longer
  that `SSL_set_{accept,connect}_state` be called before
  `SSL_{accept,connect}` may be used (`SSL_set_..._state` is omitted
  in many applications because usually everything _appeared_ to work as
  intended anyway -- now it really works as intended).

  _Bodo Moeller_

- Move openssl.cnf out of lib/.

  _Ulf Möller_

- Fix various things to let OpenSSL even pass "egcc -pipe -O2 -Wall
  -Wshadow -Wpointer-arith -Wcast-align -Wmissing-prototypes
  -Wmissing-declarations -Wnested-externs -Winline" with EGCS 1.1.2+

  _Ralf S. Engelschall_

- Various fixes to the EVP and PKCS#7 code. It may now be able to
  handle PKCS#7 enveloped data properly.

  _Sebastian Akerman <sak@parallelconsulting.com>, modified by Steve_

- Create a duplicate of the SSL*CTX's CERT in SSL_new instead of
  copying pointers. The cert_st handling is changed by this in
  various ways (and thus what used to be known as ctx->default_cert
  is now called ctx->cert, since we don't resort to `s->ctx->[default*]cert`
  any longer when s->cert does not give us what we need).
  ssl_cert_instantiate becomes obsolete by this change.
  As soon as we've got the new code right (possibly it already is?),
  we have solved a couple of bugs of the earlier code where s->cert
  was used as if it could not have been shared with other SSL structures.

  Note that using the SSL API in certain dirty ways now will result
  in different behaviour than observed with earlier library versions:
  Changing settings for an `SSL_CTX *ctx` after having done s = SSL_new(ctx)
  does not influence s as it used to.

  In order to clean up things more thoroughly, inside SSL_SESSION
  we don't use CERT any longer, but a new structure SESS_CERT
  that holds per-session data (if available); currently, this is
  the peer's certificate chain and, for clients, the server's certificate
  and temporary key. CERT holds only those values that can have
  meaningful defaults in an SSL_CTX.

  _Bodo Moeller_

- New function X509V3_EXT_i2d() to create an X509_EXTENSION structure
  from the internal representation. Various PKCS#7 fixes: remove some
  evil casts and set the enc_dig_alg field properly based on the signing
  key type.

  _Steve Henson_

- Allow PKCS#12 password to be set from the command line or the
  environment. Let 'ca' get its config file name from the environment
  variables "OPENSSL_CONF" or "SSLEAY_CONF" (for consistency with 'req'
  and 'x509').

  _Steve Henson_

- Allow certificate policies extension to use an IA5STRING for the
  organization field. This is contrary to the PKIX definition but
  VeriSign uses it and IE5 only recognises this form. Document 'x509'
  extension option.

  _Steve Henson_

- Add PEDANTIC compiler flag to allow compilation with gcc -pedantic,
  without disallowing inline assembler and the like for non-pedantic builds.

  _Ben Laurie_

- Support Borland C++ builder.

  _Janez Jere <jj@void.si>, modified by Ulf Möller_

- Support Mingw32.

  _Ulf Möller_

- SHA-1 cleanups and performance enhancements.

  _Andy Polyakov <appro@fy.chalmers.se>_

- Sparc v8plus assembler for the bignum library.

  _Andy Polyakov <appro@fy.chalmers.se>_

- Accept any -xxx and +xxx compiler options in Configure.

  _Ulf Möller_

- Update HPUX configuration.

  _Anonymous_

- Add missing `sk_<type>_unshift()` function to safestack.h

  _Ralf S. Engelschall_

- New function SSL_CTX_use_certificate_chain_file that sets the
  "extra_cert"s in addition to the certificate. (This makes sense
  only for "PEM" format files, as chains as a whole are not
  DER-encoded.)

  _Bodo Moeller_

- Support verify_depth from the SSL API.
  x509_vfy.c had what can be considered an off-by-one-error:
  Its depth (which was not part of the external interface)
  was actually counting the number of certificates in a chain;
  now it really counts the depth.

  _Bodo Moeller_

- Bugfix in crypto/x509/x509_cmp.c: The SSLerr macro was used
  instead of X509err, which often resulted in confusing error
  messages since the error codes are not globally unique
  (e.g. an alleged error in ssl3_accept when a certificate
  didn't match the private key).

- New function SSL_CTX_set_session_id_context that allows to set a default
  value (so that you don't need SSL_set_session_id_context for each
  connection using the SSL_CTX).

  _Bodo Moeller_

- OAEP decoding bug fix.

  _Ulf Möller_

- Support INSTALL_PREFIX for package builders, as proposed by
  David Harris.

  _Bodo Moeller_

- New Configure options "threads" and "no-threads". For systems
  where the proper compiler options are known (currently Solaris
  and Linux), "threads" is the default.

  _Bodo Moeller_

- New script util/mklink.pl as a faster substitute for util/mklink.sh.

  _Bodo Moeller_

- Install various scripts to $(OPENSSLDIR)/misc, not to
  $(INSTALLTOP)/bin -- they shouldn't clutter directories
  such as /usr/local/bin.

  _Bodo Moeller_

- "make linux-shared" to build shared libraries.

  _Niels Poppe <niels@netbox.org>_

- New Configure option `no-<cipher>` (rsa, idea, rc5, ...).

  _Ulf Möller_

- Add the PKCS#12 API documentation to openssl.txt. Preliminary support for
  extension adding in x509 utility.

  _Steve Henson_

- Remove NOPROTO sections and error code comments.

  _Ulf Möller_

- Partial rewrite of the DEF file generator to now parse the ANSI
  prototypes.

  _Steve Henson_

- New Configure options --prefix=DIR and --openssldir=DIR.

  _Ulf Möller_

- Complete rewrite of the error code script(s). It is all now handled
  by one script at the top level which handles error code gathering,
  header rewriting and C source file generation. It should be much better
  than the old method: it now uses a modified version of Ulf's parser to
  read the ANSI prototypes in all header files (thus the old K&R definitions
  aren't needed for error creation any more) and do a better job of
  translating function codes into names. The old 'ASN1 error code embedded
  in a comment' is no longer necessary and it doesn't use .err files which
  have now been deleted. Also the error code call doesn't have to appear all
  on one line (which resulted in some large lines...).

  _Steve Henson_

- Change #include filenames from `<foo.h>` to `<openssl/foo.h>`.

  _Bodo Moeller_

- Change behaviour of ssl2_read when facing length-0 packets: Don't return
  0 (which usually indicates a closed connection), but continue reading.

  _Bodo Moeller_

- Fix some race conditions.

  _Bodo Moeller_

- Add support for CRL distribution points extension. Add Certificate
  Policies and CRL distribution points documentation.

  _Steve Henson_

- Move the autogenerated header file parts to crypto/opensslconf.h.

  _Ulf Möller_

- Fix new 56-bit DES export ciphersuites: they were using 7 bytes instead of
  8 of keying material. Merlin has also confirmed interop with this fix
  between OpenSSL and Baltimore C/SSL 2.0 and J/SSL 2.0.

  _Merlin Hughes <merlin@baltimore.ie>_

- Fix lots of warnings.

  _Richard Levitte <levitte@stacken.kth.se>_

- In add_cert_dir() in crypto/x509/by_dir.c, break out of the loop if
  the directory spec didn't end with a LIST_SEPARATOR_CHAR.

  _Richard Levitte <levitte@stacken.kth.se>_

- Fix problems with sizeof(long) == 8.

  _Andy Polyakov <appro@fy.chalmers.se>_

- Change functions to ANSI C.

  _Ulf Möller_

- Fix typos in error codes.

  _Martin Kraemer <Martin.Kraemer@MchP.Siemens.De>, Ulf Möller_

- Remove defunct assembler files from Configure.

  _Ulf Möller_

- SPARC v8 assembler BIGNUM implementation.

  _Andy Polyakov <appro@fy.chalmers.se>_

- Support for Certificate Policies extension: both print and set.
  Various additions to support the r2i method this uses.

  _Steve Henson_

- A lot of constification, and fix a bug in X509_NAME_oneline() that could
  return a const string when you are expecting an allocated buffer.

  _Ben Laurie_

- Add support for ASN1 types UTF8String and VISIBLESTRING, also the CHOICE
  types DirectoryString and DisplayText.

  _Steve Henson_

- Add code to allow r2i extensions to access the configuration database,
  add an LHASH database driver and add several ctx helper functions.

  _Steve Henson_

- Fix an evil bug in bn_expand2() which caused various BN functions to
  fail when they extended the size of a BIGNUM.

  _Steve Henson_

- Various utility functions to handle SXNet extension. Modify mkdef.pl to
  support typesafe stack.

  _Steve Henson_

- Fix typo in SSL\_[gs]et_options().

  _Nils Frostberg <nils@medcom.se>_

- Delete various functions and files that belonged to the (now obsolete)
  old X509V3 handling code.

  _Steve Henson_

- New Configure option "rsaref".

  _Ulf Möller_

- Don't auto-generate pem.h.

  _Bodo Moeller_

- Introduce type-safe ASN.1 SETs.

  _Ben Laurie_

- Convert various additional casted stacks to type-safe STACK_OF() variants.

  _Ben Laurie, Ralf S. Engelschall, Steve Henson_

- Introduce type-safe STACKs. This will almost certainly break lots of code
  that links with OpenSSL (well at least cause lots of warnings), but fear
  not: the conversion is trivial, and it eliminates loads of evil casts. A
  few STACKed things have been converted already. Feel free to convert more.
  In the fullness of time, I'll do away with the STACK type altogether.

  _Ben Laurie_

- Add `openssl ca -revoke <certfile>` facility which revokes a certificate
  specified in `<certfile>` by updating the entry in the index.txt file.
  This way one no longer has to edit the index.txt file manually for
  revoking a certificate. The -revoke option does the gory details now.

  _Massimiliano Pala <madwolf@openca.org>, Ralf S. Engelschall_

- Fix `openssl crl -noout -text` combination where `-noout` killed the
  `-text` option at all and this way the `-noout -text` combination was
  inconsistent in `openssl crl` with the friends in `openssl x509|rsa|dsa`.

  _Ralf S. Engelschall_

- Make sure a corresponding plain text error message exists for the
  X509_V_ERR_CERT_REVOKED/23 error number which can occur when a
  verify callback function determined that a certificate was revoked.

  _Ralf S. Engelschall_

- Bugfix: In test/testenc, don't test `openssl <cipher>` for
  ciphers that were excluded, e.g. by -DNO_IDEA. Also, test
  all available ciphers including rc5, which was forgotten until now.
  In order to let the testing shell script know which algorithms
  are available, a new (up to now undocumented) command
  `openssl list-cipher-commands` is used.

  _Bodo Moeller_

- Bugfix: s_client occasionally would sleep in select() when
  it should have checked SSL_pending() first.

  _Bodo Moeller_

- New functions DSA_do_sign and DSA_do_verify to provide access to
  the raw DSA values prior to ASN.1 encoding.

  _Ulf Möller_

- Tweaks to Configure

  _Niels Poppe <niels@netbox.org>_

- Add support for PKCS#5 v2.0 ASN1 PBES2 structures. No other support,
  yet...

  _Steve Henson_

- New variables $(RANLIB) and $(PERL) in the Makefiles.

  _Ulf Möller_

- New config option to avoid instructions that are illegal on the 80386.
  The default code is faster, but requires at least a 486.

  _Ulf Möller_

- Got rid of old SSL2_CLIENT_VERSION (inconsistently used) and
  SSL2_SERVER_VERSION (not used at all) macros, which are now the
  same as SSL2_VERSION anyway.

  _Bodo Moeller_

- New "-showcerts" option for s_client.

  _Bodo Moeller_

- Still more PKCS#12 integration. Add pkcs12 application to openssl
  application. Various cleanups and fixes.

  _Steve Henson_

- More PKCS#12 integration. Add new pkcs12 directory with Makefile.ssl and
  modify error routines to work internally. Add error codes and PBE init
  to library startup routines.

  _Steve Henson_

- Further PKCS#12 integration. Added password based encryption, PKCS#8 and
  packing functions to asn1 and evp. Changed function names and error
  codes along the way.

  _Steve Henson_

- PKCS12 integration: and so it begins... First of several patches to
  slowly integrate PKCS#12 functionality into OpenSSL. Add PKCS#12
  objects to objects.h

  _Steve Henson_

- Add a new 'indent' option to some X509V3 extension code. Initial ASN1
  and display support for Thawte strong extranet extension.

  _Steve Henson_

- Add LinuxPPC support.

  _Jeff Dubrule <igor@pobox.org>_

- Get rid of redundant BN file bn_mulw.c, and rename bn_div64 to
  bn_div_words in alpha.s.

  _Hannes Reinecke <H.Reinecke@hw.ac.uk> and Ben Laurie_

- Make sure the RSA OAEP test is skipped under -DRSAref because
  OAEP isn't supported when OpenSSL is built with RSAref.

  _Ulf Moeller <ulf@fitug.de>_

- Move definitions of IS_SET/IS_SEQUENCE inside crypto/asn1/asn1.h
  so they no longer are missing under -DNOPROTO.

  _Soren S. Jorvang <soren@t.dk>_

### Changes between 0.9.1c and 0.9.2b [22 Mar 1999]

- Make SSL_get_peer_cert_chain() work in servers. Unfortunately, it still
  doesn't work when the session is reused. Coming soon!

  _Ben Laurie_

- Fix a security hole, that allows sessions to be reused in the wrong
  context thus bypassing client cert protection! All software that uses
  client certs and session caches in multiple contexts NEEDS PATCHING to
  allow session reuse! A fuller solution is in the works.

  _Ben Laurie, problem pointed out by Holger Reif, Bodo Moeller (and ???)_

- Some more source tree cleanups (removed obsolete files
  crypto/bf/asm/bf586.pl, test/test.txt and crypto/sha/asm/f.s; changed
  permission on "config" script to be executable) and a fix for the INSTALL
  document.

  _Ulf Moeller <ulf@fitug.de>_

- Remove some legacy and erroneous uses of malloc, free instead of
  Malloc, Free.

  _Lennart Bang <lob@netstream.se>, with minor changes by Steve_

- Make rsa_oaep_test return non-zero on error.

  _Ulf Moeller <ulf@fitug.de>_

- Add support for native Solaris shared libraries. Configure
  solaris-sparc-sc4-pic, make, then run shlib/solaris-sc4.sh. It'd be nice
  if someone would make that last step automatic.

  _Matthias Loepfe <Matthias.Loepfe@AdNovum.CH>_

- ctx_size was not built with the right compiler during "make links". Fixed.

  _Ben Laurie_

- Change the meaning of 'ALL' in the cipher list. It now means "everything
  except NULL ciphers". This means the default cipher list will no longer
  enable NULL ciphers. They need to be specifically enabled e.g. with
  the string "DEFAULT:eNULL".

  _Steve Henson_

- Fix to RSA private encryption routines: if p < q then it would
  occasionally produce an invalid result. This will only happen with
  externally generated keys because OpenSSL (and SSLeay) ensure p > q.

  _Steve Henson_

- Be less restrictive and allow also `perl util/perlpath.pl
/path/to/bin/perl` in addition to `perl util/perlpath.pl /path/to/bin`,
  because this way one can also use an interpreter named `perl5` (which is
  usually the name of Perl 5.xxx on platforms where an Perl 4.x is still
  installed as `perl`).

  _Matthias Loepfe <Matthias.Loepfe@adnovum.ch>_

- Let util/clean-depend.pl work also with older Perl 5.00x versions.

  _Matthias Loepfe <Matthias.Loepfe@adnovum.ch>_

- Fix Makefile.org so CC,CFLAG etc are passed to 'make links' add
  advapi32.lib to Win32 build and change the pem test comparison
  to fc.exe (thanks to Ulrich Kroener <kroneru@yahoo.com> for the
  suggestion). Fix misplaced ASNI prototypes and declarations in evp.h
  and crypto/des/ede_cbcm_enc.c.

  _Steve Henson_

- DES quad checksum was broken on big-endian architectures. Fixed.

  _Ben Laurie_

- Comment out two functions in bio.h that aren't implemented. Fix up the
  Win32 test batch file so it (might) work again. The Win32 test batch file
  is horrible: I feel ill....

  _Steve Henson_

- Move various #ifdefs around so NO_SYSLOG, NO_DIRENT etc are now selected
  in e_os.h. Audit of header files to check ANSI and non ANSI
  sections: 10 functions were absent from non ANSI section and not exported
  from Windows DLLs. Fixed up libeay.num for new functions.

  _Steve Henson_

- Make `openssl version` output lines consistent.

  _Ralf S. Engelschall_

- Fix Win32 symbol export lists for BIO functions: Added
  BIO_get_ex_new_index, BIO_get_ex_num, BIO_get_ex_data and BIO_set_ex_data
  to ms/libeay{16,32}.def.

  _Ralf S. Engelschall_

- Second round of fixing the OpenSSL perl/ stuff. It now at least compiled
  fine under Unix and passes some trivial tests I've now added. But the
  whole stuff is horribly incomplete, so a README.1ST with a disclaimer was
  added to make sure no one expects that this stuff really works in the
  OpenSSL 0.9.2 release. Additionally I've started to clean the XS sources
  up and fixed a few little bugs and inconsistencies in OpenSSL.{pm,xs} and
  openssl_bio.xs.

  _Ralf S. Engelschall_

- Fix the generation of two part addresses in perl.

  _Kenji Miyake <kenji@miyake.org>, integrated by Ben Laurie_

- Add config entry for Linux on MIPS.

  _John Tobey <jtobey@channel1.com>_

- Make links whenever Configure is run, unless we are on Windoze.

  _Ben Laurie_

- Permit extensions to be added to CRLs using crl_section in openssl.cnf.
  Currently only issuerAltName and AuthorityKeyIdentifier make any sense
  in CRLs.

  _Steve Henson_

- Add a useful kludge to allow package maintainers to specify compiler and
  other platforms details on the command line without having to patch the
  Configure script every time: One now can use
  `perl Configure <id>:<details>`,
  i.e. platform ids are allowed to have details appended
  to them (separated by colons). This is treated as there would be a static
  pre-configured entry in Configure's %table under key `<id>` with value
  `<details>` and `perl Configure <id>` is called. So, when you want to
  perform a quick test-compile under FreeBSD 3.1 with pgcc and without
  assembler stuff you can use `perl Configure "FreeBSD-elf:pgcc:-O6:::"`
  now, which overrides the FreeBSD-elf entry on-the-fly.

  _Ralf S. Engelschall_

- Disable new TLS1 ciphersuites by default: they aren't official yet.

  _Ben Laurie_

- Allow DSO flags like -fpic, -fPIC, -KPIC etc. to be specified
  on the `perl Configure ...` command line. This way one can compile
  OpenSSL libraries with Position Independent Code (PIC) which is needed
  for linking it into DSOs.

  _Ralf S. Engelschall_

- Remarkably, export ciphers were totally broken and no-one had noticed!
  Fixed.

  _Ben Laurie_

- Cleaned up the LICENSE document: The official contact for any license
  questions now is the OpenSSL core team under openssl-core@openssl.org.
  And add a paragraph about the dual-license situation to make sure people
  recognize that _BOTH_ the OpenSSL license _AND_ the SSLeay license apply
  to the OpenSSL toolkit.

  _Ralf S. Engelschall_

- General source tree makefile cleanups: Made `making xxx in yyy...`
  display consistent in the source tree and replaced `/bin/rm` by `rm`.
  Additionally cleaned up the `make links` target: Remove unnecessary
  semicolons, subsequent redundant removes, inline point.sh into mklink.sh
  to speed processing and no longer clutter the display with confusing
  stuff. Instead only the actually done links are displayed.

  _Ralf S. Engelschall_

- Permit null encryption ciphersuites, used for authentication only. It used
  to be necessary to set the preprocessor define SSL_ALLOW_ENULL to do this.
  It is now necessary to set SSL_FORBID_ENULL to prevent the use of null
  encryption.

  _Ben Laurie_

- Add a bunch of fixes to the PKCS#7 stuff. It used to sometimes reorder
  signed attributes when verifying signatures (this would break them),
  the detached data encoding was wrong and public keys obtained using
  X509_get_pubkey() weren't freed.

  _Steve Henson_

- Add text documentation for the BUFFER functions. Also added a work around
  to a Win95 console bug. This was triggered by the password read stuff: the
  last character typed gets carried over to the next fread(). If you were
  generating a new cert request using 'req' for example then the last
  character of the passphrase would be CR which would then enter the first
  field as blank.

  _Steve Henson_

- Added the new 'Includes OpenSSL Cryptography Software' button as
  doc/openssl_button.{gif,html} which is similar in style to the old SSLeay
  button and can be used by applications based on OpenSSL to show the
  relationship to the OpenSSL project.

  _Ralf S. Engelschall_

- Remove confusing variables in function signatures in files
  ssl/ssl_lib.c and ssl/ssl.h.

  _Lennart Bong <lob@kulthea.stacken.kth.se>_

- Don't install bss_file.c under PREFIX/include/

  _Lennart Bong <lob@kulthea.stacken.kth.se>_

- Get the Win32 compile working again. Modify mkdef.pl so it can handle
  functions that return function pointers and has support for NT specific
  stuff. Fix mk1mf.pl and VC-32.pl to support NT differences also. Various
  #ifdef WIN32 and WINNTs sprinkled about the place and some changes from
  unsigned to signed types: this was killing the Win32 compile.

  _Steve Henson_

- Add new certificate file to stack functions,
  SSL_add_dir_cert_subjects_to_stack() and
  SSL_add_file_cert_subjects_to_stack(). These largely supplant
  SSL_load_client_CA_file(), and can be used to add multiple certs easily
  to a stack (usually this is then handed to SSL_CTX_set_client_CA_list()).
  This means that Apache-SSL and similar packages don't have to mess around
  to add as many CAs as they want to the preferred list.

  _Ben Laurie_

- Experiment with doxygen documentation. Currently only partially applied to
  ssl/ssl_lib.c.
  See <http://www.stack.nl/~dimitri/doxygen/index.html>, and run doxygen with
  openssl.doxy as the configuration file.

  _Ben Laurie_

- Get rid of remaining C++-style comments which strict C compilers hate.

  _Ralf S. Engelschall, pointed out by Carlos Amengual_

- Changed BN_RECURSION in bn_mont.c to BN_RECURSION_MONT so it is not
  compiled in by default: it has problems with large keys.

  _Steve Henson_

- Add a bunch of SSL_xxx() functions for configuring the temporary RSA and
  DH private keys and/or callback functions which directly correspond to
  their SSL_CTX_xxx() counterparts but work on a per-connection basis. This
  is needed for applications which have to configure certificates on a
  per-connection basis (e.g. Apache+mod_ssl) instead of a per-context basis
  (e.g. s_server).
  For the RSA certificate situation is makes no difference, but
  for the DSA certificate situation this fixes the "no shared cipher"
  problem where the OpenSSL cipher selection procedure failed because the
  temporary keys were not overtaken from the context and the API provided
  no way to reconfigure them.
  The new functions now let applications reconfigure the stuff and they
  are in detail: SSL_need_tmp_RSA, SSL_set_tmp_rsa, SSL_set_tmp_dh,
  SSL_set_tmp_rsa_callback and SSL_set_tmp_dh_callback. Additionally a new
  non-public-API function ssl_cert_instantiate() is used as a helper
  function and also to reduce code redundancy inside ssl_rsa.c.

  _Ralf S. Engelschall_

- Move s_server -dcert and -dkey options out of the undocumented feature
  area because they are useful for the DSA situation and should be
  recognized by the users.

  _Ralf S. Engelschall_

- Fix the cipher decision scheme for export ciphers: the export bits are
  _not_ within SSL_MKEY_MASK or SSL_AUTH_MASK, they are within
  SSL_EXP_MASK. So, the original variable has to be used instead of the
  already masked variable.

  _Richard Levitte <levitte@stacken.kth.se>_

- Fix `port` variable from `int` to `unsigned int` in crypto/bio/b_sock.c

  _Richard Levitte <levitte@stacken.kth.se>_

- Change type of another md_len variable in pk7_doit.c:PKCS7_dataFinal()
  from `int` to `unsigned int` because it is a length and initialized by
  EVP_DigestFinal() which expects an `unsigned int *`.

  _Richard Levitte <levitte@stacken.kth.se>_

- Don't hard-code path to Perl interpreter on shebang line of Configure
  script. Instead use the usual Shell->Perl transition trick.

  _Ralf S. Engelschall_

- Make `openssl x509 -noout -modulus`' functional also for DSA certificates
  (in addition to RSA certificates) to match the behaviour of `openssl dsa
-noout -modulus` as it's already the case for `openssl rsa -noout
-modulus`. For RSA the -modulus is the real "modulus" while for DSA
  currently the public key is printed (a decision which was already done by
  `openssl dsa -modulus` in the past) which serves a similar purpose.
  Additionally the NO_RSA no longer completely removes the whole -modulus
  option; it now only avoids using the RSA stuff. Same applies to NO_DSA
  now, too.

  _Ralf S. Engelschall_

- Add Arne Ansper's reliable BIO - this is an encrypted, block-digested
  BIO. See the source (crypto/evp/bio_ok.c) for more info.

  _Arne Ansper <arne@ats.cyber.ee>_

- Dump the old yucky req code that tried (and failed) to allow raw OIDs
  to be added. Now both 'req' and 'ca' can use new objects defined in the
  config file.

  _Steve Henson_

- Add cool BIO that does syslog (or event log on NT).

  _Arne Ansper <arne@ats.cyber.ee>, integrated by Ben Laurie_

- Add support for new TLS ciphersuites, TLS_RSA_EXPORT56_WITH_RC4_56_MD5,
  TLS_RSA_EXPORT56_WITH_RC2_CBC_56_MD5 and
  TLS_RSA_EXPORT56_WITH_DES_CBC_SHA, as specified in "56-bit Export Cipher
  Suites For TLS", draft-ietf-tls-56-bit-ciphersuites-00.txt.

  _Ben Laurie_

- Add preliminary config info for new extension code.

  _Steve Henson_

- Make RSA_NO_PADDING really use no padding.

  _Ulf Moeller <ulf@fitug.de>_

- Generate errors when private/public key check is done.

  _Ben Laurie_

- Overhaul for 'crl' utility. New function X509_CRL_print. Partial support
  for some CRL extensions and new objects added.

  _Steve Henson_

- Really fix the ASN1 IMPLICIT bug this time... Partial support for private
  key usage extension and fuller support for authority key id.

  _Steve Henson_

- Add OAEP encryption for the OpenSSL crypto library. OAEP is the improved
  padding method for RSA, which is recommended for new applications in PKCS
  #1 v2.0 (RFC 2437, October 1998).
  OAEP (Optimal Asymmetric Encryption Padding) has better theoretical
  foundations than the ad-hoc padding used in PKCS #1 v1.5. It is secure
  against Bleichbacher's attack on RSA.
  _Ulf Moeller <ulf@fitug.de>, reformatted, corrected and integrated by
  Ben Laurie_

- Updates to the new SSL compression code

  _Eric A. Young, (from changes to C2Net SSLeay, integrated by Mark Cox)_

- Fix so that the version number in the master secret, when passed
  via RSA, checks that if TLS was proposed, but we roll back to SSLv3
  (because the server will not accept higher), that the version number
  is 0x03,0x01, not 0x03,0x00

  _Eric A. Young, (from changes to C2Net SSLeay, integrated by Mark Cox)_

- Run extensive memory leak checks on SSL commands. Fixed _lots_ of memory
  leaks in `ssl/` relating to new `X509_get_pubkey()` behaviour. Also fixes
  in `apps/` and an unrelated leak in `crypto/dsa/dsa_vrf.c`.

  _Steve Henson_

- Support for RAW extensions where an arbitrary extension can be
  created by including its DER encoding. See `apps/openssl.cnf` for
  an example.

  _Steve Henson_

- Make sure latest Perl versions don't interpret some generated C array
  code as Perl array code in the crypto/err/err_genc.pl script.

  _Lars Weber <3weber@informatik.uni-hamburg.de>_

- Modify ms/do_ms.bat to not generate assembly language makefiles since
  not many people have the assembler. Various Win32 compilation fixes and
  update to the INSTALL.W32 file with (hopefully) more accurate Win32
  build instructions.

  _Steve Henson_

- Modify configure script 'Configure' to automatically create crypto/date.h
  file under Win32 and also build pem.h from pem.org. New script
  util/mkfiles.pl to create the MINFO file on environments that can't do a
  'make files': perl util/mkfiles.pl >MINFO should work.

  _Steve Henson_

- Major rework of DES function declarations, in the pursuit of correctness
  and purity. As a result, many evil casts evaporated, and some weirdness,
  too. You may find this causes warnings in your code. Zapping your evil
  casts will probably fix them. Mostly.

  _Ben Laurie_

- Fix for a typo in asn1.h. Bug fix to object creation script
  obj_dat.pl. It considered a zero in an object definition to mean
  "end of object": none of the objects in objects.h have any zeros
  so it wasn't spotted.

  _Steve Henson, reported by Erwann ABALEA <eabalea@certplus.com>_

- Add support for Triple DES Cipher Block Chaining with Output Feedback
  Masking (CBCM). In the absence of test vectors, the best I have been able
  to do is check that the decrypt undoes the encrypt, so far. Send me test
  vectors if you have them.

  _Ben Laurie_

- Correct calculation of key length for export ciphers (too much space was
  allocated for null ciphers). This has not been tested!

  _Ben Laurie_

- Modifications to the mkdef.pl for Win32 DEF file creation. The usage
  message is now correct (it understands "crypto" and "ssl" on its
  command line). There is also now an "update" option. This will update
  the util/ssleay.num and util/libeay.num files with any new functions.
  If you do a:
  perl util/mkdef.pl crypto ssl update
  it will update them.

  _Steve Henson_

- Overhauled the Perl interface:
  - ported BN stuff to OpenSSL's different BN library
  - made the perl/ source tree CVS-aware
  - renamed the package from SSLeay to OpenSSL (the files still contain
    their history because I've copied them in the repository)
  - removed obsolete files (the test scripts will be replaced
    by better Test::Harness variants in the future)

  _Ralf S. Engelschall_

- First cut for a very conservative source tree cleanup:
  1.  merge various obsolete readme texts into doc/ssleay.txt
      where we collect the old documents and readme texts.
  2.  remove the first part of files where I'm already sure that we no
      longer need them because of three reasons: either they are just temporary
      files which were left by Eric or they are preserved original files where
      I've verified that the diff is also available in the CVS via "cvs diff
      -rSSLeay_0_8_1b" or they were renamed (as it was definitely the case for
      the crypto/md/ stuff).

  _Ralf S. Engelschall_

- More extension code. Incomplete support for subject and issuer alt
  name, issuer and authority key id. Change the i2v function parameters
  and add an extra 'crl' parameter in the X509V3_CTX structure: guess
  what that's for :-) Fix to ASN1 macro which messed up
  IMPLICIT tag and add f_enum.c which adds a2i, i2a for ENUMERATED.

  _Steve Henson_

- Preliminary support for ENUMERATED type. This is largely copied from the
  INTEGER code.

  _Steve Henson_

- Add new function, EVP_MD_CTX_copy() to replace frequent use of memcpy.

  _Eric A. Young, (from changes to C2Net SSLeay, integrated by Mark Cox)_

- Make sure `make rehash` target really finds the `openssl` program.

  _Ralf S. Engelschall, Matthias Loepfe <Matthias.Loepfe@adnovum.ch>_

- Squeeze another 7% of speed out of MD5 assembler, at least on a P2. I'd
  like to hear about it if this slows down other processors.

  _Ben Laurie_

- Add CygWin32 platform information to Configure script.

  _Alan Batie <batie@aahz.jf.intel.com>_

- Fixed ms/32all.bat script: `no_asm` -> `no-asm`

  _Rainer W. Gerling <gerling@mpg-gv.mpg.de>_

- New program nseq to manipulate netscape certificate sequences

  _Steve Henson_

- Modify crl2pkcs7 so it supports multiple -certfile arguments. Fix a
  few typos.

  _Steve Henson_

- Fixes to BN code. Previously the default was to define BN_RECURSION
  but the BN code had some problems that would cause failures when
  doing certificate verification and some other functions.

  _Eric A. Young, (from changes to C2Net SSLeay, integrated by Mark Cox)_

- Add ASN1 and PEM code to support netscape certificate sequences.

  _Steve Henson_

- Add ASN1 and PEM code to support netscape certificate sequences.

  _Steve Henson_

- Add several PKIX and private extended key usage OIDs.

  _Steve Henson_

- Modify the 'ca' program to handle the new extension code. Modify
  openssl.cnf for new extension format, add comments.

  _Steve Henson_

- More X509 V3 changes. Fix typo in v3_bitstr.c. Add support to 'req'
  and add a sample to openssl.cnf so req -x509 now adds appropriate
  CA extensions.

  _Steve Henson_

- Continued X509 V3 changes. Add to other makefiles, integrate with the
  error code, add initial support to X509_print() and x509 application.

  _Steve Henson_

- Takes a deep breath and start adding X509 V3 extension support code. Add
  files in crypto/x509v3. Move original stuff to crypto/x509v3/old. All this
  stuff is currently isolated and isn't even compiled yet.

  _Steve Henson_

- Continuing patches for GeneralizedTime. Fix up certificate and CRL
  ASN1 to use ASN1_TIME and modify print routines to use ASN1_TIME_print.
  Removed the versions check from X509 routines when loading extensions:
  this allows certain broken certificates that don't set the version
  properly to be processed.

  _Steve Henson_

- Deal with irritating shit to do with dependencies, in YAAHW (Yet Another
  Ad Hoc Way) - Makefile.ssls now all contain local dependencies, which
  can still be regenerated with "make depend".

  _Ben Laurie_

- Spelling mistake in C version of CAST-128.

  _Ben Laurie, reported by Jeremy Hylton <jeremy@cnri.reston.va.us>_

- Changes to the error generation code. The perl script err-code.pl
  now reads in the old error codes and retains the old numbers, only
  adding new ones if necessary. It also only changes the .err files if new
  codes are added. The makefiles have been modified to only insert errors
  when needed (to avoid needlessly modifying header files). This is done
  by only inserting errors if the .err file is newer than the auto generated
  C file. To rebuild all the error codes from scratch (the old behaviour)
  either modify crypto/Makefile.ssl to pass the -regen flag to err_code.pl
  or delete all the .err files.

  _Steve Henson_

- CAST-128 was incorrectly implemented for short keys. The C version has
  been fixed, but is untested. The assembler versions are also fixed, but
  new assembler HAS NOT BEEN GENERATED FOR WIN32 - the Makefile needs fixing
  to regenerate it if needed.
  _Ben Laurie, reported (with fix for C version) by Jun-ichiro itojun
  Hagino <itojun@kame.net>_

- File was opened incorrectly in randfile.c.

  _Ulf Möller <ulf@fitug.de>_

- Beginning of support for GeneralizedTime. d2i, i2d, check and print
  functions. Also ASN1_TIME suite which is a CHOICE of UTCTime or
  GeneralizedTime. ASN1_TIME is the proper type used in certificates et
  al: it's just almost always a UTCTime. Note this patch adds new error
  codes so do a "make errors" if there are problems.

  _Steve Henson_

- Correct Linux 1 recognition in config.

  _Ulf Möller <ulf@fitug.de>_

- Remove pointless MD5 hash when using DSA keys in ca.

  _Anonymous <nobody@replay.com>_

- Generate an error if given an empty string as a cert directory. Also
  generate an error if handed NULL (previously returned 0 to indicate an
  error, but didn't set one).

  _Ben Laurie, reported by Anonymous <nobody@replay.com>_

- Add prototypes to SSL methods. Make SSL_write's buffer const, at last.

  _Ben Laurie_

- Fix the dummy function BN_ref_mod_exp() in rsaref.c to have the correct
  parameters. This was causing a warning which killed off the Win32 compile.

  _Steve Henson_

- Remove C++ style comments from crypto/bn/bn_local.h.

  _Neil Costigan <neil.costigan@celocom.com>_

- The function OBJ_txt2nid was broken. It was supposed to return a nid
  based on a text string, looking up short and long names and finally
  "dot" format. The "dot" format stuff didn't work. Added new function
  OBJ_txt2obj to do the same but return an ASN1_OBJECT and rewrote
  OBJ_txt2nid to use it. OBJ_txt2obj can also return objects even if the
  OID is not part of the table.

  _Steve Henson_

- Add prototypes to X509 lookup/verify methods, fixing a bug in
  X509_LOOKUP_by_alias().

  _Ben Laurie_

- Sort openssl functions by name.

  _Ben Laurie_

- Get the `gendsa` command working and add it to the `list` command. Remove
  encryption from sample DSA keys (in case anyone is interested the password
  was "1234").

  _Steve Henson_

- Make _all_ `*_free` functions accept a NULL pointer.

  _Frans Heymans <fheymans@isaserver.be>_

- If a DH key is generated in s3_srvr.c, don't blow it by trying to use
  NULL pointers.

  _Anonymous <nobody@replay.com>_

- s_server should send the CAfile as acceptable CAs, not its own cert.

  _Bodo Moeller <3moeller@informatik.uni-hamburg.de>_

- Don't blow it for numeric `-newkey` arguments to `apps/req`.

  _Bodo Moeller <3moeller@informatik.uni-hamburg.de>_

- Temp key "for export" tests were wrong in s3_srvr.c.

  _Anonymous <nobody@replay.com>_

- Add prototype for temp key callback functions
  SSL*CTX_set_tmp*{rsa,dh}\_callback().

  _Ben Laurie_

- Make DH_free() tolerate being passed a NULL pointer (like RSA_free() and
  DSA_free()). Make X509_PUBKEY_set() check for errors in d2i_PublicKey().

  _Steve Henson_

- X509_name_add_entry() freed the wrong thing after an error.

  _Arne Ansper <arne@ats.cyber.ee>_

- rsa_eay.c would attempt to free a NULL context.

  _Arne Ansper <arne@ats.cyber.ee>_

- BIO_s_socket() had a broken should_retry() on Windoze.

  _Arne Ansper <arne@ats.cyber.ee>_

- BIO_f_buffer() didn't pass on BIO_CTRL_FLUSH.

  _Arne Ansper <arne@ats.cyber.ee>_

- Make sure the already existing X509_STORE->depth variable is initialized
  in X509_STORE_new(), but document the fact that this variable is still
  unused in the certificate verification process.

  _Ralf S. Engelschall_

- Fix the various library and `apps/` files to free up pkeys obtained from
  X509_PUBKEY_get() et al. Also allow x509.c to handle netscape extensions.

  _Steve Henson_

- Fix reference counting in X509_PUBKEY_get(). This makes
  demos/maurice/example2.c work, amongst others, probably.

  _Steve Henson and Ben Laurie_

- First cut of a cleanup for `apps/`. First the `ssleay` program is now named
  `openssl` and second, the shortcut symlinks for the `openssl <command>`
  are no longer created. This way we have a single and consistent command
  line interface `openssl <command>`, similar to `cvs <command>`.

  _Ralf S. Engelschall, Paul Sutton and Ben Laurie_

- ca.c: move test for DSA keys inside #ifndef NO_DSA. Make pubkey
  BIT STRING wrapper always have zero unused bits.

  _Steve Henson_

- Add CA.pl, perl version of CA.sh, add extended key usage OID.

  _Steve Henson_

- Make the top-level INSTALL documentation easier to understand.

  _Paul Sutton_

- Makefiles updated to exit if an error occurs in a sub-directory
  make (including if user presses ^C) [Paul Sutton]

- Make Montgomery context stuff explicit in RSA data structure.

  _Ben Laurie_

- Fix build order of pem and err to allow for generated pem.h.

  _Ben Laurie_

- Fix renumbering bug in X509_NAME_delete_entry().

  _Ben Laurie_

- Enhanced the err-ins.pl script so it makes the error library number
  global and can add a library name. This is needed for external ASN1 and
  other error libraries.

  _Steve Henson_

- Fixed sk_insert which never worked properly.

  _Steve Henson_

- Fix ASN1 macros so they can handle indefinite length constructed
  EXPLICIT tags. Some non standard certificates use these: they can now
  be read in.

  _Steve Henson_

- Merged the various old/obsolete SSLeay documentation files (doc/xxx.doc)
  into a single doc/ssleay.txt bundle. This way the information is still
  preserved but no longer messes up this directory. Now it's new room for
  the new set of documentation files.

  _Ralf S. Engelschall_

- SETs were incorrectly DER encoded. This was a major pain, because they
  shared code with SEQUENCEs, which aren't coded the same. This means that
  almost everything to do with SETs or SEQUENCEs has either changed name or
  number of arguments.

  _Ben Laurie, based on a partial fix by GP Jayan <gp@nsj.co.jp>_

- Fix test data to work with the above.

  _Ben Laurie_

- Fix the RSA header declarations that hid a bug I fixed in 0.9.0b but
  was already fixed by Eric for 0.9.1 it seems.

  _Ben Laurie - pointed out by Ulf Möller <ulf@fitug.de>_

- Autodetect FreeBSD3.

  _Ben Laurie_

- Fix various bugs in Configure. This affects the following platforms:
  nextstep
  ncr-scde
  unixware-2.0
  unixware-2.0-pentium
  sco5-cc.

  _Ben Laurie_

- Eliminate generated files from CVS. Reorder tests to regenerate files
  before they are needed.

  _Ben Laurie_

- Generate Makefile.ssl from Makefile.org (to keep CVS happy).

  _Ben Laurie_

### Changes between 0.9.1b and 0.9.1c [23-Dec-1998]

- Added OPENSSL_VERSION_NUMBER to crypto/crypto.h and
  changed SSLeay to OpenSSL in version strings.

  _Ralf S. Engelschall_

- Some fixups to the top-level documents.

  _Paul Sutton_

- Fixed the nasty bug where rsaref.h was not found under compile-time
  because the symlink to include/ was missing.

  _Ralf S. Engelschall_

- Incorporated the popular no-RSA/DSA-only patches
  which allow to compile an RSA-free SSLeay.

  _Andrew Cooke / Interrader Ldt., Ralf S. Engelschall_

- Fixed nasty rehash problem under `make -f Makefile.ssl links`
  when "ssleay" is still not found.

  _Ralf S. Engelschall_

- Added more platforms to Configure: Cray T3E, HPUX 11,

  _Ralf S. Engelschall, Beckmann <beckman@acl.lanl.gov>_

- Updated the README file.

  _Ralf S. Engelschall_

- Added various .cvsignore files in the CVS repository subdirs
  to make a "cvs update" really silent.

  _Ralf S. Engelschall_

- Recompiled the error-definition header files and added
  missing symbols to the Win32 linker tables.

  _Ralf S. Engelschall_

- Cleaned up the top-level documents;
  o new files: CHANGES and LICENSE
  o merged VERSION, HISTORY* and README* files a CHANGES.SSLeay
  o merged COPYRIGHT into LICENSE
  o removed obsolete TODO file
  o renamed MICROSOFT to INSTALL.W32

  _Ralf S. Engelschall_

- Removed dummy files from the 0.9.1b source tree:
  crypto/asn1/x crypto/bio/cd crypto/bio/fg crypto/bio/grep crypto/bio/vi
  crypto/bn/asm/......add.c crypto/bn/asm/a.out crypto/dsa/f crypto/md5/f
  crypto/pem/gmon.out crypto/perlasm/f crypto/pkcs7/build crypto/rsa/f
  crypto/sha/asm/f crypto/threads/f ms/zzz ssl/f ssl/f.mak test/f
  util/f.mak util/pl/f util/pl/f.mak crypto/bf/bf_locl.old apps/f

  _Ralf S. Engelschall_

- Added various platform portability fixes.

  _Mark J. Cox_

- The Genesis of the OpenSSL rpject:
  We start with the latest (unreleased) SSLeay version 0.9.1b which Eric A.
  Young and Tim J. Hudson created while they were working for C2Net until
  summer 1998.

  _The OpenSSL Project_

### Changes between 0.9.0b and 0.9.1b [not released]

- Updated a few CA certificates under certs/

  _Eric A. Young_

- Changed some BIGNUM api stuff.

  _Eric A. Young_

- Various platform ports: OpenBSD, Ultrix, IRIX 64bit, NetBSD,
  DGUX x86, Linux Alpha, etc.

  _Eric A. Young_

- New COMP library [crypto/comp/] for SSL Record Layer Compression:
  RLE (dummy implemented) and ZLIB (really implemented when ZLIB is
  available).

  _Eric A. Young_

- Add -strparse option to asn1pars program which parses nested
  binary structures

  _Dr Stephen Henson <shenson@bigfoot.com>_

- Added "oid_file" to ssleay.cnf for "ca" and "req" programs.

  _Eric A. Young_

- DSA fix for "ca" program.

  _Eric A. Young_

- Added "-genkey" option to "dsaparam" program.

  _Eric A. Young_

- Added RIPE MD160 (rmd160) message digest.

  _Eric A. Young_

- Added -a (all) option to "ssleay version" command.

  _Eric A. Young_

- Added PLATFORM define which is the id given to Configure.

  _Eric A. Young_

- Added MemCheck_XXXX functions to crypto/mem.c for memory checking.

  _Eric A. Young_

- Extended the ASN.1 parser routines.

  _Eric A. Young_

- Extended BIO routines to support REUSEADDR, seek, tell, etc.

  _Eric A. Young_

- Added a BN_CTX to the BN library.

  _Eric A. Young_

- Fixed the weak key values in DES library

  _Eric A. Young_

- Changed API in EVP library for cipher aliases.

  _Eric A. Young_

- Added support for RC2/64bit cipher.

  _Eric A. Young_

- Converted the lhash library to the crypto/mem.c functions.

  _Eric A. Young_

- Added more recognized ASN.1 object ids.

  _Eric A. Young_

- Added more RSA padding checks for SSL/TLS.

  _Eric A. Young_

- Added BIO proxy/filter functionality.

  _Eric A. Young_

- Added extra_certs to SSL_CTX which can be used
  send extra CA certificates to the client in the CA cert chain sending
  process. It can be configured with SSL_CTX_add_extra_chain_cert().

  _Eric A. Young_

- Now Fortezza is denied in the authentication phase because
  this is key exchange mechanism is not supported by SSLeay at all.

  _Eric A. Young_

- Additional PKCS1 checks.

  _Eric A. Young_

- Support the string "TLSv1" for all TLS v1 ciphers.

  _Eric A. Young_

- Added function SSL_get_ex_data_X509_STORE_CTX_idx() which gives the
  ex_data index of the SSL context in the X509_STORE_CTX ex_data.

  _Eric A. Young_

- Fixed a few memory leaks.

  _Eric A. Young_

- Fixed various code and comment typos.

  _Eric A. Young_

- A minor bug in ssl/s3_clnt.c where there would always be 4 0
  bytes sent in the client random.

  _Edward Bishop <ebishop@spyglass.com>_

<!-- Links -->

[CVE-2026-22796]: https://www.openssl.org/news/vulnerabilities.html#CVE-2026-22796
[CVE-2026-22795]: https://www.openssl.org/news/vulnerabilities.html#CVE-2026-22795
[CVE-2025-69421]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-69421
[CVE-2025-69420]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-69420
[CVE-2025-69419]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-69419
[CVE-2025-69418]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-69418
[CVE-2025-68160]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-68160
[CVE-2025-66199]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-66199
[CVE-2025-15469]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-15469
[CVE-2025-15468]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-15468
[CVE-2025-15467]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-15467
[CVE-2025-11187]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-11187
[CVE-2025-9232]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-9232
[CVE-2025-9231]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-9231
[CVE-2025-9230]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-9230
[CVE-2025-4575]: https://www.openssl.org/news/vulnerabilities.html#CVE-2025-4575
[CVE-2024-13176]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-13176
[CVE-2024-9143]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-9143
[CVE-2024-6119]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-6119
[CVE-2024-5535]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-5535
[CVE-2024-4741]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-4741
[CVE-2024-4603]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-4603
[CVE-2024-2511]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-2511
[CVE-2024-0727]: https://www.openssl.org/news/vulnerabilities.html#CVE-2024-0727
[CVE-2023-6237]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-6237
[CVE-2023-6129]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-6129
[CVE-2023-5678]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-5678
[CVE-2023-5363]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-5363
[CVE-2023-4807]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-4807
[CVE-2023-3817]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-3817
[CVE-2023-3446]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-3446
[CVE-2023-2975]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-2975
[RFC 2578 (STD 58), section 3.5]: https://datatracker.ietf.org/doc/html/rfc2578#section-3.5
[CVE-2023-2650]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-2650
[CVE-2023-1255]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-1255
[CVE-2023-0466]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0466
[CVE-2023-0465]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0465
[CVE-2023-0464]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0464
[CVE-2023-0401]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0401
[CVE-2023-0286]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0286
[CVE-2023-0217]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0217
[CVE-2023-0216]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0216
[CVE-2023-0215]: https://www.openssl.org/news/vulnerabilities.html#CVE-2023-0215
[CVE-2022-4450]: https://www.openssl.org/news/vulnerabilities.html#CVE-2022-4450
[CVE-2022-4304]: https://www.openssl.org/news/vulnerabilities.html#CVE-2022-4304
[CVE-2022-4203]: https://www.openssl.org/news/vulnerabilities.html#CVE-2022-4203
[CVE-2022-3996]: https://www.openssl.org/news/vulnerabilities.html#CVE-2022-3996
[CVE-2022-2274]: https://www.openssl.org/news/vulnerabilities.html#CVE-2022-2274
[CVE-2022-2097]: https://www.openssl.org/news/vulnerabilities.html#CVE-2022-2097
[CVE-2020-1971]: https://www.openssl.org/news/vulnerabilities.html#CVE-2020-1971
[CVE-2020-1967]: https://www.openssl.org/news/vulnerabilities.html#CVE-2020-1967
[CVE-2019-1563]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1563
[CVE-2019-1559]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1559
[CVE-2019-1552]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1552
[CVE-2019-1551]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1551
[CVE-2019-1549]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1549
[CVE-2019-1547]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1547
[CVE-2019-1543]: https://www.openssl.org/news/vulnerabilities.html#CVE-2019-1543
[CVE-2018-5407]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-5407
[CVE-2018-0739]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-0739
[CVE-2018-0737]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-0737
[CVE-2018-0735]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-0735
[CVE-2018-0734]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-0734
[CVE-2018-0733]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-0733
[CVE-2018-0732]: https://www.openssl.org/news/vulnerabilities.html#CVE-2018-0732
[CVE-2017-3738]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3738
[CVE-2017-3737]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3737
[CVE-2017-3736]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3736
[CVE-2017-3735]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3735
[CVE-2017-3733]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3733
[CVE-2017-3732]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3732
[CVE-2017-3731]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3731
[CVE-2017-3730]: https://www.openssl.org/news/vulnerabilities.html#CVE-2017-3730
[CVE-2016-7055]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-7055
[CVE-2016-7054]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-7054
[CVE-2016-7053]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-7053
[CVE-2016-7052]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-7052
[CVE-2016-6309]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6309
[CVE-2016-6308]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6308
[CVE-2016-6307]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6307
[CVE-2016-6306]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6306
[CVE-2016-6305]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6305
[CVE-2016-6304]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6304
[CVE-2016-6303]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6303
[CVE-2016-6302]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-6302
[CVE-2016-2183]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2183
[CVE-2016-2182]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2182
[CVE-2016-2181]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2181
[CVE-2016-2180]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2180
[CVE-2016-2179]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2179
[CVE-2016-2178]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2178
[CVE-2016-2177]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2177
[CVE-2016-2176]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2176
[CVE-2016-2109]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2109
[CVE-2016-2107]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2107
[CVE-2016-2106]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2106
[CVE-2016-2105]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-2105
[CVE-2016-0800]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0800
[CVE-2016-0799]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0799
[CVE-2016-0798]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0798
[CVE-2016-0797]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0797
[CVE-2016-0705]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0705
[CVE-2016-0702]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0702
[CVE-2016-0701]: https://www.openssl.org/news/vulnerabilities.html#CVE-2016-0701
[CVE-2015-3197]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-3197
[CVE-2015-3196]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-3196
[CVE-2015-3195]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-3195
[CVE-2015-3194]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-3194
[CVE-2015-3193]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-3193
[CVE-2015-1793]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1793
[CVE-2015-1792]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1792
[CVE-2015-1791]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1791
[CVE-2015-1790]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1790
[CVE-2015-1789]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1789
[CVE-2015-1788]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1788
[CVE-2015-1787]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-1787
[CVE-2015-0293]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0293
[CVE-2015-0291]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0291
[CVE-2015-0290]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0290
[CVE-2015-0289]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0289
[CVE-2015-0288]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0288
[CVE-2015-0287]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0287
[CVE-2015-0286]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0286
[CVE-2015-0285]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0285
[CVE-2015-0209]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0209
[CVE-2015-0208]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0208
[CVE-2015-0207]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0207
[CVE-2015-0206]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0206
[CVE-2015-0205]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0205
[CVE-2015-0204]: https://www.openssl.org/news/vulnerabilities.html#CVE-2015-0204
[CVE-2014-8275]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-8275
[CVE-2014-5139]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-5139
[CVE-2014-3572]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3572
[CVE-2014-3571]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3571
[CVE-2014-3570]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3570
[CVE-2014-3569]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3569
[CVE-2014-3568]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3568
[CVE-2014-3567]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3567
[CVE-2014-3566]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3566
[CVE-2014-3513]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3513
[CVE-2014-3512]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3512
[CVE-2014-3511]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3511
[CVE-2014-3510]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3510
[CVE-2014-3509]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3509
[CVE-2014-3508]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3508
[CVE-2014-3507]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3507
[CVE-2014-3506]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3506
[CVE-2014-3505]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3505
[CVE-2014-3470]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-3470
[CVE-2014-0224]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-0224
[CVE-2014-0221]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-0221
[CVE-2014-0195]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-0195
[CVE-2014-0160]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-0160
[CVE-2014-0076]: https://www.openssl.org/news/vulnerabilities.html#CVE-2014-0076
[CVE-2013-6450]: https://www.openssl.org/news/vulnerabilities.html#CVE-2013-6450
[CVE-2013-4353]: https://www.openssl.org/news/vulnerabilities.html#CVE-2013-4353
[CVE-2013-0169]: https://www.openssl.org/news/vulnerabilities.html#CVE-2013-0169
[CVE-2013-0166]: https://www.openssl.org/news/vulnerabilities.html#CVE-2013-0166
[CVE-2012-2686]: https://www.openssl.org/news/vulnerabilities.html#CVE-2012-2686
[CVE-2012-2333]: https://www.openssl.org/news/vulnerabilities.html#CVE-2012-2333
[CVE-2012-2110]: https://www.openssl.org/news/vulnerabilities.html#CVE-2012-2110
[CVE-2012-0884]: https://www.openssl.org/news/vulnerabilities.html#CVE-2012-0884
[CVE-2012-0050]: https://www.openssl.org/news/vulnerabilities.html#CVE-2012-0050
[CVE-2012-0027]: https://www.openssl.org/news/vulnerabilities.html#CVE-2012-0027
[CVE-2011-4619]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-4619
[CVE-2011-4577]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-4577
[CVE-2011-4576]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-4576
[CVE-2011-4109]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-4109
[CVE-2011-4108]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-4108
[CVE-2011-3210]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-3210
[CVE-2011-3207]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-3207
[CVE-2011-0014]: https://www.openssl.org/news/vulnerabilities.html#CVE-2011-0014
[CVE-2010-4252]: https://www.openssl.org/news/vulnerabilities.html#CVE-2010-4252
[CVE-2010-4180]: https://www.openssl.org/news/vulnerabilities.html#CVE-2010-4180
[CVE-2010-3864]: https://www.openssl.org/news/vulnerabilities.html#CVE-2010-3864
[CVE-2010-1633]: https://www.openssl.org/news/vulnerabilities.html#CVE-2010-1633
[CVE-2010-0740]: https://www.openssl.org/news/vulnerabilities.html#CVE-2010-0740
[CVE-2010-0433]: https://www.openssl.org/news/vulnerabilities.html#CVE-2010-0433
[CVE-2009-4355]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-4355
[CVE-2009-3555]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-3555
[CVE-2009-3245]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-3245
[CVE-2009-1386]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-1386
[CVE-2009-1379]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-1379
[CVE-2009-1378]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-1378
[CVE-2009-1377]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-1377
[CVE-2009-0789]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-0789
[CVE-2009-0591]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-0591
[CVE-2009-0590]: https://www.openssl.org/news/vulnerabilities.html#CVE-2009-0590
[CVE-2008-5077]: https://www.openssl.org/news/vulnerabilities.html#CVE-2008-5077
[CVE-2008-1678]: https://www.openssl.org/news/vulnerabilities.html#CVE-2008-1678
[CVE-2008-1672]: https://www.openssl.org/news/vulnerabilities.html#CVE-2008-1672
[CVE-2008-0891]: https://www.openssl.org/news/vulnerabilities.html#CVE-2008-0891
[CVE-2007-5135]: https://www.openssl.org/news/vulnerabilities.html#CVE-2007-5135
[CVE-2007-4995]: https://www.openssl.org/news/vulnerabilities.html#CVE-2007-4995
[CVE-2006-4343]: https://www.openssl.org/news/vulnerabilities.html#CVE-2006-4343
[CVE-2006-4339]: https://www.openssl.org/news/vulnerabilities.html#CVE-2006-4339
[CVE-2006-3738]: https://www.openssl.org/news/vulnerabilities.html#CVE-2006-3738
[CVE-2006-2940]: https://www.openssl.org/news/vulnerabilities.html#CVE-2006-2940
[CVE-2006-2937]: https://www.openssl.org/news/vulnerabilities.html#CVE-2006-2937
[CVE-2005-2969]: https://www.openssl.org/news/vulnerabilities.html#CVE-2005-2969
[CVE-2004-0112]: https://www.openssl.org/news/vulnerabilities.html#CVE-2004-0112
[CVE-2004-0079]: https://www.openssl.org/news/vulnerabilities.html#CVE-2004-0079
[CVE-2003-0851]: https://www.openssl.org/news/vulnerabilities.html#CVE-2003-0851
[CVE-2003-0545]: https://www.openssl.org/news/vulnerabilities.html#CVE-2003-0545
[CVE-2003-0544]: https://www.openssl.org/news/vulnerabilities.html#CVE-2003-0544
[CVE-2003-0543]: https://www.openssl.org/news/vulnerabilities.html#CVE-2003-0543
[CVE-2003-0078]: https://www.openssl.org/news/vulnerabilities.html#CVE-2003-0078
[CVE-2002-0659]: https://www.openssl.org/news/vulnerabilities.html#CVE-2002-0659
[CVE-2002-0657]: https://www.openssl.org/news/vulnerabilities.html#CVE-2002-0657
[CVE-2002-0656]: https://www.openssl.org/news/vulnerabilities.html#CVE-2002-0656
[CVE-2002-0655]: https://www.openssl.org/news/vulnerabilities.html#CVE-2002-0655
[CMVP]: https://csrc.nist.gov/projects/cryptographic-module-validation-program
[ESV]: https://csrc.nist.gov/Projects/cryptographic-module-validation-program/entropy-validations
[SP 800-132]: https://csrc.nist.gov/pubs/sp/800/132/final
[SP 800-208]: https://csrc.nist.gov/pubs/sp/800/208/final
