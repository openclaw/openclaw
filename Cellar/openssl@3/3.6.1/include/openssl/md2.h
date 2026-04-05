/*
 * Copyright 1995-2020 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_MD2_H
#define OPENSSL_MD2_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_MD2_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_MD2
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif

#define MD2_DIGEST_LENGTH 16

#if !defined(OPENSSL_NO_DEPRECATED_3_0)

typedef unsigned char MD2_INT;

#define MD2_BLOCK 16

typedef struct MD2state_st {
    unsigned int num;
    unsigned char data[MD2_BLOCK];
    MD2_INT cksm[MD2_BLOCK];
    MD2_INT state[MD2_BLOCK];
} MD2_CTX;
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 const char *MD2_options(void);
OSSL_DEPRECATEDIN_3_0 int MD2_Init(MD2_CTX *c);
OSSL_DEPRECATEDIN_3_0 int MD2_Update(MD2_CTX *c, const unsigned char *data,
    size_t len);
OSSL_DEPRECATEDIN_3_0 int MD2_Final(unsigned char *md, MD2_CTX *c);
OSSL_DEPRECATEDIN_3_0 unsigned char *MD2(const unsigned char *d, size_t n,
    unsigned char *md);
#endif

#ifdef __cplusplus
}
#endif
#endif
#endif
