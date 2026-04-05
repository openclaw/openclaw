/*
 * Copyright 2015-2024 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

/* clang-format off */

/* clang-format on */

#ifndef OPENSSL_COMP_H
#define OPENSSL_COMP_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_COMP_H
#endif

#include <openssl/opensslconf.h>

#include <openssl/crypto.h>
#include <openssl/comperr.h>
#ifdef __cplusplus
extern "C" {
#endif

#ifndef OPENSSL_NO_COMP

COMP_CTX *COMP_CTX_new(COMP_METHOD *meth);
const COMP_METHOD *COMP_CTX_get_method(const COMP_CTX *ctx);
int COMP_CTX_get_type(const COMP_CTX *comp);
int COMP_get_type(const COMP_METHOD *meth);
const char *COMP_get_name(const COMP_METHOD *meth);
void COMP_CTX_free(COMP_CTX *ctx);

int COMP_compress_block(COMP_CTX *ctx, unsigned char *out, int olen,
    unsigned char *in, int ilen);
int COMP_expand_block(COMP_CTX *ctx, unsigned char *out, int olen,
    unsigned char *in, int ilen);

COMP_METHOD *COMP_zlib(void);
COMP_METHOD *COMP_zlib_oneshot(void);
COMP_METHOD *COMP_brotli(void);
COMP_METHOD *COMP_brotli_oneshot(void);
COMP_METHOD *COMP_zstd(void);
COMP_METHOD *COMP_zstd_oneshot(void);

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define COMP_zlib_cleanup() \
    while (0)               \
    continue
#endif

#ifdef OPENSSL_BIO_H
const BIO_METHOD *BIO_f_zlib(void);
const BIO_METHOD *BIO_f_brotli(void);
const BIO_METHOD *BIO_f_zstd(void);
#endif

#endif

typedef struct ssl_comp_st SSL_COMP;

/* clang-format off */
SKM_DEFINE_STACK_OF_INTERNAL(SSL_COMP, SSL_COMP, SSL_COMP)
#define sk_SSL_COMP_num(sk) OPENSSL_sk_num(ossl_check_const_SSL_COMP_sk_type(sk))
#define sk_SSL_COMP_value(sk, idx) ((SSL_COMP *)OPENSSL_sk_value(ossl_check_const_SSL_COMP_sk_type(sk), (idx)))
#define sk_SSL_COMP_new(cmp) ((STACK_OF(SSL_COMP) *)OPENSSL_sk_new(ossl_check_SSL_COMP_compfunc_type(cmp)))
#define sk_SSL_COMP_new_null() ((STACK_OF(SSL_COMP) *)OPENSSL_sk_new_null())
#define sk_SSL_COMP_new_reserve(cmp, n) ((STACK_OF(SSL_COMP) *)OPENSSL_sk_new_reserve(ossl_check_SSL_COMP_compfunc_type(cmp), (n)))
#define sk_SSL_COMP_reserve(sk, n) OPENSSL_sk_reserve(ossl_check_SSL_COMP_sk_type(sk), (n))
#define sk_SSL_COMP_free(sk) OPENSSL_sk_free(ossl_check_SSL_COMP_sk_type(sk))
#define sk_SSL_COMP_zero(sk) OPENSSL_sk_zero(ossl_check_SSL_COMP_sk_type(sk))
#define sk_SSL_COMP_delete(sk, i) ((SSL_COMP *)OPENSSL_sk_delete(ossl_check_SSL_COMP_sk_type(sk), (i)))
#define sk_SSL_COMP_delete_ptr(sk, ptr) ((SSL_COMP *)OPENSSL_sk_delete_ptr(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr)))
#define sk_SSL_COMP_push(sk, ptr) OPENSSL_sk_push(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr))
#define sk_SSL_COMP_unshift(sk, ptr) OPENSSL_sk_unshift(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr))
#define sk_SSL_COMP_pop(sk) ((SSL_COMP *)OPENSSL_sk_pop(ossl_check_SSL_COMP_sk_type(sk)))
#define sk_SSL_COMP_shift(sk) ((SSL_COMP *)OPENSSL_sk_shift(ossl_check_SSL_COMP_sk_type(sk)))
#define sk_SSL_COMP_pop_free(sk, freefunc) OPENSSL_sk_pop_free(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_freefunc_type(freefunc))
#define sk_SSL_COMP_insert(sk, ptr, idx) OPENSSL_sk_insert(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr), (idx))
#define sk_SSL_COMP_set(sk, idx, ptr) ((SSL_COMP *)OPENSSL_sk_set(ossl_check_SSL_COMP_sk_type(sk), (idx), ossl_check_SSL_COMP_type(ptr)))
#define sk_SSL_COMP_find(sk, ptr) OPENSSL_sk_find(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr))
#define sk_SSL_COMP_find_ex(sk, ptr) OPENSSL_sk_find_ex(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr))
#define sk_SSL_COMP_find_all(sk, ptr, pnum) OPENSSL_sk_find_all(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_type(ptr), pnum)
#define sk_SSL_COMP_sort(sk) OPENSSL_sk_sort(ossl_check_SSL_COMP_sk_type(sk))
#define sk_SSL_COMP_is_sorted(sk) OPENSSL_sk_is_sorted(ossl_check_const_SSL_COMP_sk_type(sk))
#define sk_SSL_COMP_dup(sk) ((STACK_OF(SSL_COMP) *)OPENSSL_sk_dup(ossl_check_const_SSL_COMP_sk_type(sk)))
#define sk_SSL_COMP_deep_copy(sk, copyfunc, freefunc) ((STACK_OF(SSL_COMP) *)OPENSSL_sk_deep_copy(ossl_check_const_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_copyfunc_type(copyfunc), ossl_check_SSL_COMP_freefunc_type(freefunc)))
#define sk_SSL_COMP_set_cmp_func(sk, cmp) ((sk_SSL_COMP_compfunc)OPENSSL_sk_set_cmp_func(ossl_check_SSL_COMP_sk_type(sk), ossl_check_SSL_COMP_compfunc_type(cmp)))

/* clang-format on */

#ifdef __cplusplus
}
#endif
#endif
