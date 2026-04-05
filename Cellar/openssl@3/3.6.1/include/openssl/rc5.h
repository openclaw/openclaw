/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_RC5_H
#define OPENSSL_RC5_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_RC5_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_RC5
#ifdef __cplusplus
extern "C" {
#endif

#define RC5_32_BLOCK 8
#define RC5_32_KEY_LENGTH 16 /* This is a default, max is 255 */

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define RC5_ENCRYPT 1
#define RC5_DECRYPT 0

#define RC5_32_INT unsigned int

/*
 * This are the only values supported.  Tweak the code if you want more The
 * most supported modes will be RC5-32/12/16 RC5-32/16/8
 */
#define RC5_8_ROUNDS 8
#define RC5_12_ROUNDS 12
#define RC5_16_ROUNDS 16

typedef struct rc5_key_st {
    /* Number of rounds */
    int rounds;
    RC5_32_INT data[2 * (RC5_16_ROUNDS + 1)];
} RC5_32_KEY;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int RC5_32_set_key(RC5_32_KEY *key, int len,
    const unsigned char *data,
    int rounds);
OSSL_DEPRECATEDIN_3_0 void RC5_32_ecb_encrypt(const unsigned char *in,
    unsigned char *out,
    RC5_32_KEY *key,
    int enc);
OSSL_DEPRECATEDIN_3_0 void RC5_32_encrypt(unsigned long *data, RC5_32_KEY *key);
OSSL_DEPRECATEDIN_3_0 void RC5_32_decrypt(unsigned long *data, RC5_32_KEY *key);
OSSL_DEPRECATEDIN_3_0 void RC5_32_cbc_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    RC5_32_KEY *ks, unsigned char *iv,
    int enc);
OSSL_DEPRECATEDIN_3_0 void RC5_32_cfb64_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    RC5_32_KEY *schedule,
    unsigned char *ivec, int *num,
    int enc);
OSSL_DEPRECATEDIN_3_0 void RC5_32_ofb64_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    RC5_32_KEY *schedule,
    unsigned char *ivec, int *num);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
