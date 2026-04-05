/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_MD4_H
#define OPENSSL_MD4_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_MD4_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_MD4
#include <openssl/e_os2.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

#define MD4_DIGEST_LENGTH 16

#if !defined(OPENSSL_NO_DEPRECATED_3_0)

/*-
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * ! MD4_LONG has to be at least 32 bits wide.                     !
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 */
#define MD4_LONG unsigned int

#define MD4_CBLOCK 64
#define MD4_LBLOCK (MD4_CBLOCK / 4)

typedef struct MD4state_st {
    MD4_LONG A, B, C, D;
    MD4_LONG Nl, Nh;
    MD4_LONG data[MD4_LBLOCK];
    unsigned int num;
} MD4_CTX;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int MD4_Init(MD4_CTX *c);
OSSL_DEPRECATEDIN_3_0 int MD4_Update(MD4_CTX *c, const void *data, size_t len);
OSSL_DEPRECATEDIN_3_0 int MD4_Final(unsigned char *md, MD4_CTX *c);
OSSL_DEPRECATEDIN_3_0 unsigned char *MD4(const unsigned char *d, size_t n,
    unsigned char *md);
OSSL_DEPRECATEDIN_3_0 void MD4_Transform(MD4_CTX *c, const unsigned char *b);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
