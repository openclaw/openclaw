/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_CAST_H
#define OPENSSL_CAST_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_CAST_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_CAST
#ifdef __cplusplus
extern "C" {
#endif

#define CAST_BLOCK 8
#define CAST_KEY_LENGTH 16

#ifndef OPENSSL_NO_DEPRECATED_3_0

#define CAST_ENCRYPT 1
#define CAST_DECRYPT 0

#define CAST_LONG unsigned int

typedef struct cast_key_st {
    CAST_LONG data[32];
    int short_key; /* Use reduced rounds for short key */
} CAST_KEY;

#endif /* OPENSSL_NO_DEPRECATED_3_0 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
void CAST_set_key(CAST_KEY *key, int len, const unsigned char *data);
OSSL_DEPRECATEDIN_3_0
void CAST_ecb_encrypt(const unsigned char *in, unsigned char *out,
    const CAST_KEY *key, int enc);
OSSL_DEPRECATEDIN_3_0
void CAST_encrypt(CAST_LONG *data, const CAST_KEY *key);
OSSL_DEPRECATEDIN_3_0
void CAST_decrypt(CAST_LONG *data, const CAST_KEY *key);
OSSL_DEPRECATEDIN_3_0
void CAST_cbc_encrypt(const unsigned char *in, unsigned char *out,
    long length, const CAST_KEY *ks, unsigned char *iv,
    int enc);
OSSL_DEPRECATEDIN_3_0
void CAST_cfb64_encrypt(const unsigned char *in, unsigned char *out,
    long length, const CAST_KEY *schedule,
    unsigned char *ivec, int *num, int enc);
OSSL_DEPRECATEDIN_3_0
void CAST_ofb64_encrypt(const unsigned char *in, unsigned char *out,
    long length, const CAST_KEY *schedule,
    unsigned char *ivec, int *num);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
