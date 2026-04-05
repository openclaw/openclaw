/*
 * Copyright 2022-2024 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

/* APIs and data structures for HPKE (RFC9180)  */
#ifndef OSSL_HPKE_H
#define OSSL_HPKE_H
#pragma once

#include <openssl/types.h>

/* HPKE modes */
#define OSSL_HPKE_MODE_BASE 0 /* Base mode  */
#define OSSL_HPKE_MODE_PSK 1 /* Pre-shared key mode */
#define OSSL_HPKE_MODE_AUTH 2 /* Authenticated mode */
#define OSSL_HPKE_MODE_PSKAUTH 3 /* PSK+authenticated mode */

/*
 * Max for ikm, psk, pskid, info and exporter contexts.
 * RFC9180, section 7.2.1 RECOMMENDS 64 octets but we have test vectors from
 * Appendix A.6.1 with a 66 octet IKM so we'll allow that.
 */
#define OSSL_HPKE_MAX_PARMLEN 66
#define OSSL_HPKE_MIN_PSKLEN 32
#define OSSL_HPKE_MAX_INFOLEN 1024

/*
 * The (16bit) HPKE algorithm ID IANA codepoints
 * If/when new IANA codepoints are added there are tables in
 * crypto/hpke/hpke_util.c that must also be updated.
 */
#define OSSL_HPKE_KEM_ID_RESERVED 0x0000 /* not used */
#define OSSL_HPKE_KEM_ID_P256 0x0010 /* NIST P-256 */
#define OSSL_HPKE_KEM_ID_P384 0x0011 /* NIST P-384 */
#define OSSL_HPKE_KEM_ID_P521 0x0012 /* NIST P-521 */
#define OSSL_HPKE_KEM_ID_X25519 0x0020 /* Curve25519 */
#define OSSL_HPKE_KEM_ID_X448 0x0021 /* Curve448 */

#define OSSL_HPKE_KDF_ID_RESERVED 0x0000 /* not used */
#define OSSL_HPKE_KDF_ID_HKDF_SHA256 0x0001 /* HKDF-SHA256 */
#define OSSL_HPKE_KDF_ID_HKDF_SHA384 0x0002 /* HKDF-SHA384 */
#define OSSL_HPKE_KDF_ID_HKDF_SHA512 0x0003 /* HKDF-SHA512 */

#define OSSL_HPKE_AEAD_ID_RESERVED 0x0000 /* not used */
#define OSSL_HPKE_AEAD_ID_AES_GCM_128 0x0001 /* AES-GCM-128 */
#define OSSL_HPKE_AEAD_ID_AES_GCM_256 0x0002 /* AES-GCM-256 */
#define OSSL_HPKE_AEAD_ID_CHACHA_POLY1305 0x0003 /* Chacha20-Poly1305 */
#define OSSL_HPKE_AEAD_ID_EXPORTONLY 0xFFFF /* export-only fake ID */

/* strings for suite components */
#define OSSL_HPKE_KEMSTR_P256 "P-256" /* KEM id 0x10 */
#define OSSL_HPKE_KEMSTR_P384 "P-384" /* KEM id 0x11 */
#define OSSL_HPKE_KEMSTR_P521 "P-521" /* KEM id 0x12 */
#define OSSL_HPKE_KEMSTR_X25519 "X25519" /* KEM id 0x20 */
#define OSSL_HPKE_KEMSTR_X448 "X448" /* KEM id 0x21 */
#define OSSL_HPKE_KDFSTR_256 "hkdf-sha256" /* KDF id 1 */
#define OSSL_HPKE_KDFSTR_384 "hkdf-sha384" /* KDF id 2 */
#define OSSL_HPKE_KDFSTR_512 "hkdf-sha512" /* KDF id 3 */
#define OSSL_HPKE_AEADSTR_AES128GCM "aes-128-gcm" /* AEAD id 1 */
#define OSSL_HPKE_AEADSTR_AES256GCM "aes-256-gcm" /* AEAD id 2 */
#define OSSL_HPKE_AEADSTR_CP "chacha20-poly1305" /* AEAD id 3 */
#define OSSL_HPKE_AEADSTR_EXP "exporter" /* AEAD id 0xff */

/*
 * Roles for use in creating an OSSL_HPKE_CTX, most
 * important use of this is to control nonce reuse.
 */
#define OSSL_HPKE_ROLE_SENDER 0
#define OSSL_HPKE_ROLE_RECEIVER 1

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint16_t kem_id; /* Key Encapsulation Method id */
    uint16_t kdf_id; /* Key Derivation Function id */
    uint16_t aead_id; /* AEAD alg id */
} OSSL_HPKE_SUITE;

/**
 * Suite constants, use this like:
 *          OSSL_HPKE_SUITE myvar = OSSL_HPKE_SUITE_DEFAULT;
 */
#ifndef OPENSSL_NO_ECX
#define OSSL_HPKE_SUITE_DEFAULT       \
    {                                 \
        OSSL_HPKE_KEM_ID_X25519,      \
        OSSL_HPKE_KDF_ID_HKDF_SHA256, \
        OSSL_HPKE_AEAD_ID_AES_GCM_128 \
    }
#else
#define OSSL_HPKE_SUITE_DEFAULT       \
    {                                 \
        OSSL_HPKE_KEM_ID_P256,        \
        OSSL_HPKE_KDF_ID_HKDF_SHA256, \
        OSSL_HPKE_AEAD_ID_AES_GCM_128 \
    }
#endif

typedef struct ossl_hpke_ctx_st OSSL_HPKE_CTX;

OSSL_HPKE_CTX *OSSL_HPKE_CTX_new(int mode, OSSL_HPKE_SUITE suite, int role,
    OSSL_LIB_CTX *libctx, const char *propq);
void OSSL_HPKE_CTX_free(OSSL_HPKE_CTX *ctx);

int OSSL_HPKE_encap(OSSL_HPKE_CTX *ctx,
    unsigned char *enc, size_t *enclen,
    const unsigned char *pub, size_t publen,
    const unsigned char *info, size_t infolen);
int OSSL_HPKE_seal(OSSL_HPKE_CTX *ctx,
    unsigned char *ct, size_t *ctlen,
    const unsigned char *aad, size_t aadlen,
    const unsigned char *pt, size_t ptlen);

int OSSL_HPKE_keygen(OSSL_HPKE_SUITE suite,
    unsigned char *pub, size_t *publen, EVP_PKEY **priv,
    const unsigned char *ikm, size_t ikmlen,
    OSSL_LIB_CTX *libctx, const char *propq);
int OSSL_HPKE_decap(OSSL_HPKE_CTX *ctx,
    const unsigned char *enc, size_t enclen,
    EVP_PKEY *recippriv,
    const unsigned char *info, size_t infolen);
int OSSL_HPKE_open(OSSL_HPKE_CTX *ctx,
    unsigned char *pt, size_t *ptlen,
    const unsigned char *aad, size_t aadlen,
    const unsigned char *ct, size_t ctlen);

int OSSL_HPKE_export(OSSL_HPKE_CTX *ctx,
    unsigned char *secret,
    size_t secretlen,
    const unsigned char *label,
    size_t labellen);

int OSSL_HPKE_CTX_set1_authpriv(OSSL_HPKE_CTX *ctx, EVP_PKEY *priv);
int OSSL_HPKE_CTX_set1_authpub(OSSL_HPKE_CTX *ctx,
    const unsigned char *pub,
    size_t publen);
int OSSL_HPKE_CTX_set1_psk(OSSL_HPKE_CTX *ctx,
    const char *pskid,
    const unsigned char *psk, size_t psklen);

int OSSL_HPKE_CTX_set1_ikme(OSSL_HPKE_CTX *ctx,
    const unsigned char *ikme, size_t ikmelen);

int OSSL_HPKE_CTX_set_seq(OSSL_HPKE_CTX *ctx, uint64_t seq);
int OSSL_HPKE_CTX_get_seq(OSSL_HPKE_CTX *ctx, uint64_t *seq);

int OSSL_HPKE_suite_check(OSSL_HPKE_SUITE suite);
int OSSL_HPKE_get_grease_value(const OSSL_HPKE_SUITE *suite_in,
    OSSL_HPKE_SUITE *suite,
    unsigned char *enc, size_t *enclen,
    unsigned char *ct, size_t ctlen,
    OSSL_LIB_CTX *libctx, const char *propq);
int OSSL_HPKE_str2suite(const char *str, OSSL_HPKE_SUITE *suite);
size_t OSSL_HPKE_get_ciphertext_size(OSSL_HPKE_SUITE suite, size_t clearlen);
size_t OSSL_HPKE_get_public_encap_size(OSSL_HPKE_SUITE suite);
size_t OSSL_HPKE_get_recommended_ikmelen(OSSL_HPKE_SUITE suite);

#ifdef __cplusplus
}
#endif

#endif
