/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_RIPEMD_H
#define OPENSSL_RIPEMD_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_RIPEMD_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_RMD160
#include <openssl/e_os2.h>
#include <stddef.h>

#define RIPEMD160_DIGEST_LENGTH 20

#ifdef __cplusplus
extern "C" {
#endif
#if !defined(OPENSSL_NO_DEPRECATED_3_0)

#define RIPEMD160_LONG unsigned int

#define RIPEMD160_CBLOCK 64
#define RIPEMD160_LBLOCK (RIPEMD160_CBLOCK / 4)

typedef struct RIPEMD160state_st {
    RIPEMD160_LONG A, B, C, D, E;
    RIPEMD160_LONG Nl, Nh;
    RIPEMD160_LONG data[RIPEMD160_LBLOCK];
    unsigned int num;
} RIPEMD160_CTX;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int RIPEMD160_Init(RIPEMD160_CTX *c);
OSSL_DEPRECATEDIN_3_0 int RIPEMD160_Update(RIPEMD160_CTX *c, const void *data,
    size_t len);
OSSL_DEPRECATEDIN_3_0 int RIPEMD160_Final(unsigned char *md, RIPEMD160_CTX *c);
OSSL_DEPRECATEDIN_3_0 unsigned char *RIPEMD160(const unsigned char *d, size_t n,
    unsigned char *md);
OSSL_DEPRECATEDIN_3_0 void RIPEMD160_Transform(RIPEMD160_CTX *c,
    const unsigned char *b);
#endif

#ifdef __cplusplus
}
#endif
#endif
#endif
