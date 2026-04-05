/*
 * Copyright 2016-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_KDF_H
#define OPENSSL_KDF_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_KDF_H
#endif

#include <stdarg.h>
#include <stddef.h>
#include <openssl/types.h>
#include <openssl/core.h>

#ifdef __cplusplus
extern "C" {
#endif

int EVP_KDF_up_ref(EVP_KDF *kdf);
void EVP_KDF_free(EVP_KDF *kdf);
EVP_KDF *EVP_KDF_fetch(OSSL_LIB_CTX *libctx, const char *algorithm,
    const char *properties);

EVP_KDF_CTX *EVP_KDF_CTX_new(EVP_KDF *kdf);
void EVP_KDF_CTX_free(EVP_KDF_CTX *ctx);
EVP_KDF_CTX *EVP_KDF_CTX_dup(const EVP_KDF_CTX *src);
const char *EVP_KDF_get0_description(const EVP_KDF *kdf);
int EVP_KDF_is_a(const EVP_KDF *kdf, const char *name);
const char *EVP_KDF_get0_name(const EVP_KDF *kdf);
const OSSL_PROVIDER *EVP_KDF_get0_provider(const EVP_KDF *kdf);
const EVP_KDF *EVP_KDF_CTX_kdf(EVP_KDF_CTX *ctx);

void EVP_KDF_CTX_reset(EVP_KDF_CTX *ctx);
size_t EVP_KDF_CTX_get_kdf_size(EVP_KDF_CTX *ctx);
int EVP_KDF_derive(EVP_KDF_CTX *ctx, unsigned char *key, size_t keylen,
    const OSSL_PARAM params[]);
int EVP_KDF_CTX_set_SKEY(EVP_KDF_CTX *ctx, EVP_SKEY *key, const char *paramname);
EVP_SKEY *EVP_KDF_derive_SKEY(EVP_KDF_CTX *ctx, EVP_SKEYMGMT *mgmt,
    const char *key_type, const char *propquery,
    size_t keylen, const OSSL_PARAM params[]);
int EVP_KDF_get_params(EVP_KDF *kdf, OSSL_PARAM params[]);
int EVP_KDF_CTX_get_params(EVP_KDF_CTX *ctx, OSSL_PARAM params[]);
int EVP_KDF_CTX_set_params(EVP_KDF_CTX *ctx, const OSSL_PARAM params[]);
const OSSL_PARAM *EVP_KDF_gettable_params(const EVP_KDF *kdf);
const OSSL_PARAM *EVP_KDF_gettable_ctx_params(const EVP_KDF *kdf);
const OSSL_PARAM *EVP_KDF_settable_ctx_params(const EVP_KDF *kdf);
const OSSL_PARAM *EVP_KDF_CTX_gettable_params(EVP_KDF_CTX *ctx);
const OSSL_PARAM *EVP_KDF_CTX_settable_params(EVP_KDF_CTX *ctx);

void EVP_KDF_do_all_provided(OSSL_LIB_CTX *libctx,
    void (*fn)(EVP_KDF *kdf, void *arg),
    void *arg);
int EVP_KDF_names_do_all(const EVP_KDF *kdf,
    void (*fn)(const char *name, void *data),
    void *data);

#define EVP_KDF_HKDF_MODE_EXTRACT_AND_EXPAND 0
#define EVP_KDF_HKDF_MODE_EXTRACT_ONLY 1
#define EVP_KDF_HKDF_MODE_EXPAND_ONLY 2

#define EVP_KDF_SSHKDF_TYPE_INITIAL_IV_CLI_TO_SRV 65
#define EVP_KDF_SSHKDF_TYPE_INITIAL_IV_SRV_TO_CLI 66
#define EVP_KDF_SSHKDF_TYPE_ENCRYPTION_KEY_CLI_TO_SRV 67
#define EVP_KDF_SSHKDF_TYPE_ENCRYPTION_KEY_SRV_TO_CLI 68
#define EVP_KDF_SSHKDF_TYPE_INTEGRITY_KEY_CLI_TO_SRV 69
#define EVP_KDF_SSHKDF_TYPE_INTEGRITY_KEY_SRV_TO_CLI 70

/**** The legacy PKEY-based KDF API follows. ****/

#define EVP_PKEY_CTRL_TLS_MD (EVP_PKEY_ALG_CTRL)
#define EVP_PKEY_CTRL_TLS_SECRET (EVP_PKEY_ALG_CTRL + 1)
#define EVP_PKEY_CTRL_TLS_SEED (EVP_PKEY_ALG_CTRL + 2)
#define EVP_PKEY_CTRL_HKDF_MD (EVP_PKEY_ALG_CTRL + 3)
#define EVP_PKEY_CTRL_HKDF_SALT (EVP_PKEY_ALG_CTRL + 4)
#define EVP_PKEY_CTRL_HKDF_KEY (EVP_PKEY_ALG_CTRL + 5)
#define EVP_PKEY_CTRL_HKDF_INFO (EVP_PKEY_ALG_CTRL + 6)
#define EVP_PKEY_CTRL_HKDF_MODE (EVP_PKEY_ALG_CTRL + 7)
#define EVP_PKEY_CTRL_PASS (EVP_PKEY_ALG_CTRL + 8)
#define EVP_PKEY_CTRL_SCRYPT_SALT (EVP_PKEY_ALG_CTRL + 9)
#define EVP_PKEY_CTRL_SCRYPT_N (EVP_PKEY_ALG_CTRL + 10)
#define EVP_PKEY_CTRL_SCRYPT_R (EVP_PKEY_ALG_CTRL + 11)
#define EVP_PKEY_CTRL_SCRYPT_P (EVP_PKEY_ALG_CTRL + 12)
#define EVP_PKEY_CTRL_SCRYPT_MAXMEM_BYTES (EVP_PKEY_ALG_CTRL + 13)

#define EVP_PKEY_HKDEF_MODE_EXTRACT_AND_EXPAND \
    EVP_KDF_HKDF_MODE_EXTRACT_AND_EXPAND
#define EVP_PKEY_HKDEF_MODE_EXTRACT_ONLY \
    EVP_KDF_HKDF_MODE_EXTRACT_ONLY
#define EVP_PKEY_HKDEF_MODE_EXPAND_ONLY \
    EVP_KDF_HKDF_MODE_EXPAND_ONLY

int EVP_PKEY_CTX_set_tls1_prf_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);

int EVP_PKEY_CTX_set1_tls1_prf_secret(EVP_PKEY_CTX *pctx,
    const unsigned char *sec, int seclen);

int EVP_PKEY_CTX_add1_tls1_prf_seed(EVP_PKEY_CTX *pctx,
    const unsigned char *seed, int seedlen);

int EVP_PKEY_CTX_set_hkdf_md(EVP_PKEY_CTX *ctx, const EVP_MD *md);

int EVP_PKEY_CTX_set1_hkdf_salt(EVP_PKEY_CTX *ctx,
    const unsigned char *salt, int saltlen);

int EVP_PKEY_CTX_set1_hkdf_key(EVP_PKEY_CTX *ctx,
    const unsigned char *key, int keylen);

int EVP_PKEY_CTX_add1_hkdf_info(EVP_PKEY_CTX *ctx,
    const unsigned char *info, int infolen);

int EVP_PKEY_CTX_set_hkdf_mode(EVP_PKEY_CTX *ctx, int mode);
#define EVP_PKEY_CTX_hkdf_mode EVP_PKEY_CTX_set_hkdf_mode

int EVP_PKEY_CTX_set1_pbe_pass(EVP_PKEY_CTX *ctx, const char *pass,
    int passlen);

int EVP_PKEY_CTX_set1_scrypt_salt(EVP_PKEY_CTX *ctx,
    const unsigned char *salt, int saltlen);

int EVP_PKEY_CTX_set_scrypt_N(EVP_PKEY_CTX *ctx, uint64_t n);

int EVP_PKEY_CTX_set_scrypt_r(EVP_PKEY_CTX *ctx, uint64_t r);

int EVP_PKEY_CTX_set_scrypt_p(EVP_PKEY_CTX *ctx, uint64_t p);

int EVP_PKEY_CTX_set_scrypt_maxmem_bytes(EVP_PKEY_CTX *ctx,
    uint64_t maxmem_bytes);

#ifdef __cplusplus
}
#endif
#endif
