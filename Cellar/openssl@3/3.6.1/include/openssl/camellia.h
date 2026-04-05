/*
 * Copyright 2006-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_CAMELLIA_H
#define OPENSSL_CAMELLIA_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_CAMELLIA_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_CAMELLIA
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

#define CAMELLIA_BLOCK_SIZE 16

#ifndef OPENSSL_NO_DEPRECATED_3_0

#define CAMELLIA_ENCRYPT 1
#define CAMELLIA_DECRYPT 0

/*
 * Because array size can't be a const in C, the following two are macros.
 * Both sizes are in bytes.
 */

/* This should be a hidden type, but EVP requires that the size be known */

#define CAMELLIA_TABLE_BYTE_LEN 272
#define CAMELLIA_TABLE_WORD_LEN (CAMELLIA_TABLE_BYTE_LEN / 4)

typedef unsigned int KEY_TABLE_TYPE[CAMELLIA_TABLE_WORD_LEN]; /* to match
                                                               * with WORD */

struct camellia_key_st {
    union {
        double d; /* ensures 64-bit align */
        KEY_TABLE_TYPE rd_key;
    } u;
    int grand_rounds;
};
typedef struct camellia_key_st CAMELLIA_KEY;

#endif /* OPENSSL_NO_DEPRECATED_3_0 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int Camellia_set_key(const unsigned char *userKey,
    const int bits,
    CAMELLIA_KEY *key);
OSSL_DEPRECATEDIN_3_0 void Camellia_encrypt(const unsigned char *in,
    unsigned char *out,
    const CAMELLIA_KEY *key);
OSSL_DEPRECATEDIN_3_0 void Camellia_decrypt(const unsigned char *in,
    unsigned char *out,
    const CAMELLIA_KEY *key);
OSSL_DEPRECATEDIN_3_0 void Camellia_ecb_encrypt(const unsigned char *in,
    unsigned char *out,
    const CAMELLIA_KEY *key,
    const int enc);
OSSL_DEPRECATEDIN_3_0 void Camellia_cbc_encrypt(const unsigned char *in,
    unsigned char *out,
    size_t length,
    const CAMELLIA_KEY *key,
    unsigned char *ivec,
    const int enc);
OSSL_DEPRECATEDIN_3_0 void Camellia_cfb128_encrypt(const unsigned char *in,
    unsigned char *out,
    size_t length,
    const CAMELLIA_KEY *key,
    unsigned char *ivec,
    int *num,
    const int enc);
OSSL_DEPRECATEDIN_3_0 void Camellia_cfb1_encrypt(const unsigned char *in,
    unsigned char *out,
    size_t length,
    const CAMELLIA_KEY *key,
    unsigned char *ivec,
    int *num,
    const int enc);
OSSL_DEPRECATEDIN_3_0 void Camellia_cfb8_encrypt(const unsigned char *in,
    unsigned char *out,
    size_t length,
    const CAMELLIA_KEY *key,
    unsigned char *ivec,
    int *num,
    const int enc);
OSSL_DEPRECATEDIN_3_0 void Camellia_ofb128_encrypt(const unsigned char *in,
    unsigned char *out,
    size_t length,
    const CAMELLIA_KEY *key,
    unsigned char *ivec,
    int *num);
OSSL_DEPRECATEDIN_3_0
void Camellia_ctr128_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const CAMELLIA_KEY *key,
    unsigned char ivec[CAMELLIA_BLOCK_SIZE],
    unsigned char ecount_buf[CAMELLIA_BLOCK_SIZE],
    unsigned int *num);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
