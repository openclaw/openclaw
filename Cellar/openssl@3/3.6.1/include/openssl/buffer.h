/*
 * Copyright 1995-2018 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_BUFFER_H
#define OPENSSL_BUFFER_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_BUFFER_H
#endif

#include <openssl/types.h>
#ifndef OPENSSL_CRYPTO_H
#include <openssl/crypto.h>
#endif
#include <openssl/buffererr.h>

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>
#include <sys/types.h>

#ifndef OPENSSL_NO_DEPRECATED_3_0
#define BUF_strdup(s) OPENSSL_strdup(s)
#define BUF_strndup(s, size) OPENSSL_strndup(s, size)
#define BUF_memdup(data, size) OPENSSL_memdup(data, size)
#define BUF_strlcpy(dst, src, size) OPENSSL_strlcpy(dst, src, size)
#define BUF_strlcat(dst, src, size) OPENSSL_strlcat(dst, src, size)
#define BUF_strnlen(str, maxlen) OPENSSL_strnlen(str, maxlen)
#endif

struct buf_mem_st {
    size_t length; /* current number of bytes */
    char *data;
    size_t max; /* size of buffer */
    unsigned long flags;
};

#define BUF_MEM_FLAG_SECURE 0x01

BUF_MEM *BUF_MEM_new(void);
BUF_MEM *BUF_MEM_new_ex(unsigned long flags);
void BUF_MEM_free(BUF_MEM *a);
size_t BUF_MEM_grow(BUF_MEM *str, size_t len);
size_t BUF_MEM_grow_clean(BUF_MEM *str, size_t len);
void BUF_reverse(unsigned char *out, const unsigned char *in, size_t siz);

#ifdef __cplusplus
}
#endif
#endif
