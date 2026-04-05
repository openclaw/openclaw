/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_IDEA_H
#define OPENSSL_IDEA_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_IDEA_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_IDEA
#ifdef __cplusplus
extern "C" {
#endif

#define IDEA_BLOCK 8
#define IDEA_KEY_LENGTH 16

#ifndef OPENSSL_NO_DEPRECATED_3_0

typedef unsigned int IDEA_INT;

#define IDEA_ENCRYPT 1
#define IDEA_DECRYPT 0

typedef struct idea_key_st {
    IDEA_INT data[9][6];
} IDEA_KEY_SCHEDULE;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 const char *IDEA_options(void);
OSSL_DEPRECATEDIN_3_0 void IDEA_ecb_encrypt(const unsigned char *in,
    unsigned char *out,
    IDEA_KEY_SCHEDULE *ks);
OSSL_DEPRECATEDIN_3_0 void IDEA_set_encrypt_key(const unsigned char *key,
    IDEA_KEY_SCHEDULE *ks);
OSSL_DEPRECATEDIN_3_0 void IDEA_set_decrypt_key(IDEA_KEY_SCHEDULE *ek,
    IDEA_KEY_SCHEDULE *dk);
OSSL_DEPRECATEDIN_3_0 void IDEA_cbc_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    IDEA_KEY_SCHEDULE *ks,
    unsigned char *iv, int enc);
OSSL_DEPRECATEDIN_3_0 void IDEA_cfb64_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    IDEA_KEY_SCHEDULE *ks,
    unsigned char *iv, int *num,
    int enc);
OSSL_DEPRECATEDIN_3_0 void IDEA_ofb64_encrypt(const unsigned char *in,
    unsigned char *out, long length,
    IDEA_KEY_SCHEDULE *ks,
    unsigned char *iv, int *num);
OSSL_DEPRECATEDIN_3_0 void IDEA_encrypt(unsigned long *in,
    IDEA_KEY_SCHEDULE *ks);
#endif

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define idea_options IDEA_options
#define idea_ecb_encrypt IDEA_ecb_encrypt
#define idea_set_encrypt_key IDEA_set_encrypt_key
#define idea_set_decrypt_key IDEA_set_decrypt_key
#define idea_cbc_encrypt IDEA_cbc_encrypt
#define idea_cfb64_encrypt IDEA_cfb64_encrypt
#define idea_ofb64_encrypt IDEA_ofb64_encrypt
#define idea_encrypt IDEA_encrypt
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
