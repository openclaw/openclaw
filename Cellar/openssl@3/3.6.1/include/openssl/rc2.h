/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_RC2_H
#define OPENSSL_RC2_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_RC2_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_RC2
#ifdef __cplusplus
extern "C" {
#endif

#define RC2_BLOCK 8
#define RC2_KEY_LENGTH 16

#ifndef OPENSSL_NO_DEPRECATED_3_0
typedef unsigned int RC2_INT;

#define RC2_ENCRYPT 1
#define RC2_DECRYPT 0

typedef struct rc2_key_st {
    RC2_INT data[64];
} RC2_KEY;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 void RC2_set_key(RC2_KEY *key, int len,
    const unsigned char *data, int bits);
OSSL_DEPRECATEDIN_3_0 void RC2_ecb_encrypt(const unsigned char *in,
    unsigned char *out, RC2_KEY *key,
    int enc);
OSSL_DEPRECATEDIN_3_0 void RC2_encrypt(unsigned long *data, RC2_KEY *key);
OSSL_DEPRECATEDIN_3_0 void RC2_decrypt(unsigned long *data, RC2_KEY *key);
OSSL_DEPRECATEDIN_3_0 void RC2_cbc_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    RC2_KEY *ks, unsigned char *iv,
    int enc);
OSSL_DEPRECATEDIN_3_0 void RC2_cfb64_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    RC2_KEY *schedule,
    unsigned char *ivec,
    int *num, int enc);
OSSL_DEPRECATEDIN_3_0 void RC2_ofb64_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    RC2_KEY *schedule,
    unsigned char *ivec,
    int *num);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
