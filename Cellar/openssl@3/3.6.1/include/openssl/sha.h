/*
 * Copyright 1995-2023 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_SHA_H
#define OPENSSL_SHA_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_SHA_H
#endif

#include <openssl/e_os2.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SHA_DIGEST_LENGTH 20

#ifndef OPENSSL_NO_DEPRECATED_3_0
/*-
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * ! SHA_LONG has to be at least 32 bits wide.                    !
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
#define SHA_LONG unsigned int

#define SHA_LBLOCK 16
#define SHA_CBLOCK (SHA_LBLOCK * 4) /* SHA treats input data as a      \
                                     * contiguous array of 32 bit wide \
                                     * big-endian values. */
#define SHA_LAST_BLOCK (SHA_CBLOCK - 8)

typedef struct SHAstate_st {
    SHA_LONG h0, h1, h2, h3, h4;
    SHA_LONG Nl, Nh;
    SHA_LONG data[SHA_LBLOCK];
    unsigned int num;
} SHA_CTX;

OSSL_DEPRECATEDIN_3_0 int SHA1_Init(SHA_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA1_Update(SHA_CTX *c, const void *data, size_t len);
OSSL_DEPRECATEDIN_3_0 int SHA1_Final(unsigned char *md, SHA_CTX *c);
OSSL_DEPRECATEDIN_3_0 void SHA1_Transform(SHA_CTX *c, const unsigned char *data);
#endif

unsigned char *SHA1(const unsigned char *d, size_t n, unsigned char *md);

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define SHA256_CBLOCK (SHA_LBLOCK * 4) /* SHA-256 treats input data as a  \
                                        * contiguous array of 32 bit wide \
                                        * big-endian values. */

typedef struct SHA256state_st {
    SHA_LONG h[8];
    SHA_LONG Nl, Nh;
    SHA_LONG data[SHA_LBLOCK];
    unsigned int num, md_len;
} SHA256_CTX;

OSSL_DEPRECATEDIN_3_0 int SHA224_Init(SHA256_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA224_Update(SHA256_CTX *c,
    const void *data, size_t len);
OSSL_DEPRECATEDIN_3_0 int SHA224_Final(unsigned char *md, SHA256_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA256_Init(SHA256_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA256_Update(SHA256_CTX *c,
    const void *data, size_t len);
OSSL_DEPRECATEDIN_3_0 int SHA256_Final(unsigned char *md, SHA256_CTX *c);
OSSL_DEPRECATEDIN_3_0 void SHA256_Transform(SHA256_CTX *c,
    const unsigned char *data);
#endif

unsigned char *SHA224(const unsigned char *d, size_t n, unsigned char *md);
unsigned char *SHA256(const unsigned char *d, size_t n, unsigned char *md);

#define SHA256_192_DIGEST_LENGTH 24
#define SHA224_DIGEST_LENGTH 28
#define SHA256_DIGEST_LENGTH 32
#define SHA384_DIGEST_LENGTH 48
#define SHA512_DIGEST_LENGTH 64

#ifndef OPENSSL_NO_DEPRECATED_3_0
/*
 * Unlike 32-bit digest algorithms, SHA-512 *relies* on SHA_LONG64
 * being exactly 64-bit wide. See Implementation Notes in sha512.c
 * for further details.
 */
/*
 * SHA-512 treats input data as a
 * contiguous array of 64 bit
 * wide big-endian values.
 */
#define SHA512_CBLOCK (SHA_LBLOCK * 8)
#if (defined(_WIN32) || defined(_WIN64)) && !defined(__MINGW32__)
#define SHA_LONG64 unsigned __int64
#elif defined(__arch64__)
#define SHA_LONG64 unsigned long
#else
#define SHA_LONG64 unsigned long long
#endif

typedef struct SHA512state_st {
    SHA_LONG64 h[8];
    SHA_LONG64 Nl, Nh;
    union {
        SHA_LONG64 d[SHA_LBLOCK];
        unsigned char p[SHA512_CBLOCK];
    } u;
    unsigned int num, md_len;
} SHA512_CTX;

OSSL_DEPRECATEDIN_3_0 int SHA384_Init(SHA512_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA384_Update(SHA512_CTX *c,
    const void *data, size_t len);
OSSL_DEPRECATEDIN_3_0 int SHA384_Final(unsigned char *md, SHA512_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA512_Init(SHA512_CTX *c);
OSSL_DEPRECATEDIN_3_0 int SHA512_Update(SHA512_CTX *c,
    const void *data, size_t len);
OSSL_DEPRECATEDIN_3_0 int SHA512_Final(unsigned char *md, SHA512_CTX *c);
OSSL_DEPRECATEDIN_3_0 void SHA512_Transform(SHA512_CTX *c,
    const unsigned char *data);
#endif

unsigned char *SHA384(const unsigned char *d, size_t n, unsigned char *md);
unsigned char *SHA512(const unsigned char *d, size_t n, unsigned char *md);

#ifdef __cplusplus
}
#endif

#endif
