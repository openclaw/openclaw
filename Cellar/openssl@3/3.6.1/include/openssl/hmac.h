/*
 * Copyright 1995-2021 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_HMAC_H
#define OPENSSL_HMAC_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_HMAC_H
#endif

#include <openssl/opensslconf.h>

#include <openssl/evp.h>

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HMAC_MAX_MD_CBLOCK 200 /* Deprecated */
#endif

#ifdef __cplusplus
extern "C" {
#endif

#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 size_t HMAC_size(const HMAC_CTX *e);
OSSL_DEPRECATEDIN_3_0 HMAC_CTX *HMAC_CTX_new(void);
OSSL_DEPRECATEDIN_3_0 int HMAC_CTX_reset(HMAC_CTX *ctx);
OSSL_DEPRECATEDIN_3_0 void HMAC_CTX_free(HMAC_CTX *ctx);
#endif
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
OSSL_DEPRECATEDIN_1_1_0 __owur int HMAC_Init(HMAC_CTX *ctx,
    const void *key, int len,
    const EVP_MD *md);
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int HMAC_Init_ex(HMAC_CTX *ctx, const void *key, int len,
    const EVP_MD *md, ENGINE *impl);
OSSL_DEPRECATEDIN_3_0 int HMAC_Update(HMAC_CTX *ctx, const unsigned char *data,
    size_t len);
OSSL_DEPRECATEDIN_3_0 int HMAC_Final(HMAC_CTX *ctx, unsigned char *md,
    unsigned int *len);
OSSL_DEPRECATEDIN_3_0 __owur int HMAC_CTX_copy(HMAC_CTX *dctx, HMAC_CTX *sctx);
OSSL_DEPRECATEDIN_3_0 void HMAC_CTX_set_flags(HMAC_CTX *ctx, unsigned long flags);
OSSL_DEPRECATEDIN_3_0 const EVP_MD *HMAC_CTX_get_md(const HMAC_CTX *ctx);
#endif

unsigned char *HMAC(const EVP_MD *evp_md, const void *key, int key_len,
    const unsigned char *data, size_t data_len,
    unsigned char *md, unsigned int *md_len);

#ifdef __cplusplus
}
#endif

#endif
