/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_MDC2_H
#define OPENSSL_MDC2_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_MDC2_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_MDC2
#include <stdlib.h>
#include <openssl/des.h>
#ifdef __cplusplus
extern "C" {
#endif

#define MDC2_DIGEST_LENGTH 16

#if !defined(OPENSSL_NO_DEPRECATED_3_0)

#define MDC2_BLOCK 8

typedef struct mdc2_ctx_st {
    unsigned int num;
    unsigned char data[MDC2_BLOCK];
    DES_cblock h, hh;
    unsigned int pad_type; /* either 1 or 2, default 1 */
} MDC2_CTX;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int MDC2_Init(MDC2_CTX *c);
OSSL_DEPRECATEDIN_3_0 int MDC2_Update(MDC2_CTX *c, const unsigned char *data,
    size_t len);
OSSL_DEPRECATEDIN_3_0 int MDC2_Final(unsigned char *md, MDC2_CTX *c);
OSSL_DEPRECATEDIN_3_0 unsigned char *MDC2(const unsigned char *d, size_t n,
    unsigned char *md);
#endif

#ifdef __cplusplus
}
#endif
#endif

#endif
