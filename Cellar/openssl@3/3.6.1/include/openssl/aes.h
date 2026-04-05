/*
 * Copyright 2002-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_AES_H
#define OPENSSL_AES_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_AES_H
#endif

#include <openssl/opensslconf.h>

#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

#define AES_BLOCK_SIZE 16

#ifndef OPENSSL_NO_DEPRECATED_3_0

#define AES_ENCRYPT 1
#define AES_DECRYPT 0

#define AES_MAXNR 14

/* This should be a hidden type, but EVP requires that the size be known */
struct aes_key_st {
#ifdef AES_LONG
    unsigned long rd_key[4 * (AES_MAXNR + 1)];
#else
    unsigned int rd_key[4 * (AES_MAXNR + 1)];
#endif
    int rounds;
};
typedef struct aes_key_st AES_KEY;

#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 const char *AES_options(void);
OSSL_DEPRECATEDIN_3_0
int AES_set_encrypt_key(const unsigned char *userKey, const int bits,
    AES_KEY *key);
OSSL_DEPRECATEDIN_3_0
int AES_set_decrypt_key(const unsigned char *userKey, const int bits,
    AES_KEY *key);
OSSL_DEPRECATEDIN_3_0
void AES_encrypt(const unsigned char *in, unsigned char *out,
    const AES_KEY *key);
OSSL_DEPRECATEDIN_3_0
void AES_decrypt(const unsigned char *in, unsigned char *out,
    const AES_KEY *key);
OSSL_DEPRECATEDIN_3_0
void AES_ecb_encrypt(const unsigned char *in, unsigned char *out,
    const AES_KEY *key, const int enc);
OSSL_DEPRECATEDIN_3_0
void AES_cbc_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key,
    unsigned char *ivec, const int enc);
OSSL_DEPRECATEDIN_3_0
void AES_cfb128_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key,
    unsigned char *ivec, int *num, const int enc);
OSSL_DEPRECATEDIN_3_0
void AES_cfb1_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key,
    unsigned char *ivec, int *num, const int enc);
OSSL_DEPRECATEDIN_3_0
void AES_cfb8_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key,
    unsigned char *ivec, int *num, const int enc);
OSSL_DEPRECATEDIN_3_0
void AES_ofb128_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key,
    unsigned char *ivec, int *num);

/* NB: the IV is _two_ blocks long */
OSSL_DEPRECATEDIN_3_0
void AES_ige_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key,
    unsigned char *ivec, const int enc);
/* NB: the IV is _four_ blocks long */
OSSL_DEPRECATEDIN_3_0
void AES_bi_ige_encrypt(const unsigned char *in, unsigned char *out,
    size_t length, const AES_KEY *key, const AES_KEY *key2,
    const unsigned char *ivec, const int enc);
OSSL_DEPRECATEDIN_3_0
int AES_wrap_key(AES_KEY *key, const unsigned char *iv,
    unsigned char *out, const unsigned char *in,
    unsigned int inlen);
OSSL_DEPRECATEDIN_3_0
int AES_unwrap_key(AES_KEY *key, const unsigned char *iv,
    unsigned char *out, const unsigned char *in,
    unsigned int inlen);
#endif

#ifdef __cplusplus
}
#endif

#endif
