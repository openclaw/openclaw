/*
 * Copyright 2005-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_WHRLPOOL_H
#define OPENSSL_WHRLPOOL_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_WHRLPOOL_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_WHIRLPOOL
#include <openssl/e_os2.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

#define WHIRLPOOL_DIGEST_LENGTH (512 / 8)

#if !defined(OPENSSL_NO_DEPRECATED_3_0)

#define WHIRLPOOL_BBLOCK 512
#define WHIRLPOOL_COUNTER (256 / 8)

typedef struct {
    union {
        unsigned char c[WHIRLPOOL_DIGEST_LENGTH];
        /* double q is here to ensure 64-bit alignment */
        double q[WHIRLPOOL_DIGEST_LENGTH / sizeof(double)];
    } H;
    unsigned char data[WHIRLPOOL_BBLOCK / 8];
    unsigned int bitoff;
    size_t bitlen[WHIRLPOOL_COUNTER / sizeof(size_t)];
} WHIRLPOOL_CTX;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int WHIRLPOOL_Init(WHIRLPOOL_CTX *c);
OSSL_DEPRECATEDIN_3_0 int WHIRLPOOL_Update(WHIRLPOOL_CTX *c,
    const void *inp, size_t bytes);
OSSL_DEPRECATEDIN_3_0 void WHIRLPOOL_BitUpdate(WHIRLPOOL_CTX *c,
    const void *inp, size_t bits);
OSSL_DEPRECATEDIN_3_0 int WHIRLPOOL_Final(unsigned char *md, WHIRLPOOL_CTX *c);
OSSL_DEPRECATEDIN_3_0 unsigned char *WHIRLPOOL(const void *inp, size_t bytes,
    unsigned char *md);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
